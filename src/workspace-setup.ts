// Installing the workspace's dependencies, running commands inside it, and the
// setupWorkspace entry point the commands call.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import {
  assertLayerPathsServed,
  buildLayersFromCache,
  buildLayersFromPaths,
  downloadAndExtractLayers,
  assertCachedArchivesExist,
} from "./layers";
import { assertCachedLayerPathsExist, resolveManifest } from "./manifest";
import {
  writeFrontendModuleRegistry,
  copyStaticTemplates,
  materializeLayers,
  writeDmsMainCss,
  writeWorkspacePackageJson,
} from "./materialize";
import {
  ensureWorkspace,
  ResolvedLayer,
  writeWorkspaceMeta,
} from "./workspace";
import { canonicalizeBackendUrl, DEPS_HASH_FILE } from "./config";

// ============================================================================
// Constants
// ============================================================================

export function computeDepsHash(
  layerPaths: string[],
  workspacePackage?: string,
): string {
  const hash = createHash("sha256");
  if (workspacePackage && existsSync(workspacePackage))
    hash.update(readFileSync(workspacePackage));
  for (const layerPath of [...layerPaths].sort()) {
    const pkgPath = join(layerPath, "package.json");
    if (existsSync(pkgPath)) {
      hash.update(readFileSync(pkgPath, "utf-8"));
    }
  }
  return hash.digest("hex");
}

/**
 * Check if dependencies need to be installed.
 * Returns true if install is needed.
 */
export function needsInstall(
  workspaceDir: string,
  layerPaths: string[],
  force: boolean,
): boolean {
  if (force) return true;

  const hashFile = join(workspaceDir, DEPS_HASH_FILE);
  if (!existsSync(hashFile)) return true;
  if (!existsSync(join(workspaceDir, "node_modules"))) return true;

  const currentHash = computeDepsHash(
    layerPaths,
    join(workspaceDir, "package.json"),
  );
  const savedHash = readFileSync(hashFile, "utf-8").trim();
  return currentHash !== savedHash;
}

/**
 * Save the current deps hash after a successful install
 */
export function saveDepsHash(workspaceDir: string, layerPaths: string[]): void {
  const hash = computeDepsHash(layerPaths, join(workspaceDir, "package.json"));
  writeFileSync(join(workspaceDir, DEPS_HASH_FILE), hash);
}

/**
 * Run pnpm install in the workspace directory
 */
export function installDeps(workspaceDir: string): void {
  const { execSync } = require("node:child_process");
  execSync("pnpm install", {
    cwd: workspaceDir,
    stdio: "inherit",
  });
}

// ============================================================================
// Process Spawning
// ============================================================================

/** Signals the CLI forwards to the child instead of dying on its own. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** How long a child may take to honor a forwarded signal before SIGKILL. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 5000;

/** Shell convention for "died from signal N", used when the child never exited on its own. */
function exitCodeForSignal(signal: NodeJS.Signals): number {
  const number = osConstants.signals[signal];
  return 128 + (typeof number === "number" ? number : 15);
}

/**
 * Spawn a child process and wait for it to complete.
 *
 * The child owns a port (server.mjs, the Vite dev server), so it must never
 * outlive the CLI: leaving an orphan behind keeps the port bound until the
 * user hunts the pid down. Node's default is exactly that — a terminal Ctrl-C
 * reaches the child only because it shares the foreground process group, and
 * `kill` on the CLI reaches it not at all — so the signals are forwarded here
 * explicitly, and the child is killed outright if the CLI goes down for any
 * other reason.
 */
export function runCommand(
  command: string,
  args: string[],
  options?: SpawnOptions,
): Promise<number> {
  const isWindows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      // A shell is only needed on Windows, where npm-installed binaries are
      // .cmd shims. On POSIX it would put /bin/sh between us and the server:
      // dash forks rather than execs here, so the pid we hold would be the
      // shell's and the signals below would never reach the actual process.
      shell: isWindows,
      ...options,
    });

    let escalation: NodeJS.Timeout | undefined;
    let forwarded: NodeJS.Signals | undefined;

    const alive = () => child.exitCode === null && child.signalCode === null;

    const stopChild = (signal: NodeJS.Signals) => {
      if (!alive()) return;
      try {
        // Windows has no signal delivery: any signal terminates the child
        // immediately, so SIGHUP/SIGINT are normalized to SIGTERM and the
        // escalation below is a no-op there.
        child.kill(isWindows ? "SIGTERM" : signal);
      } catch {
        // The child raced us to exit; the "exit" handler settles the promise.
      }
      if (escalation || isWindows) return;
      escalation = setTimeout(() => {
        if (alive()) {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }, CHILD_SHUTDOWN_TIMEOUT_MS);
      escalation.unref();
    };

    const onSignal = (signal: NodeJS.Signals) => {
      forwarded = signal;
      stopChild(signal);
    };

    // "exit" is synchronous, so there is no room for a graceful shutdown:
    // this is the last-resort net for an uncaught exception or a
    // process.exit() raised elsewhere in the CLI.
    const onParentExit = () => {
      if (alive()) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }
    };

    for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
    process.on("exit", onParentExit);

    const cleanup = () => {
      if (escalation) clearTimeout(escalation);
      for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal);
      process.off("exit", onParentExit);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (code !== null) return resolve(code);
      resolve(exitCodeForSignal(signal ?? forwarded ?? "SIGTERM"));
    });
  });
}

// ============================================================================
// Full Workspace Setup (orchestration)
// ============================================================================

export interface SetupWorkspaceOptions {
  backendUrl: string;
  force: boolean;
  /** "dev" uses direct paths, "build" downloads ZIP */
  mode: "dev" | "build";
  /** Skip the backend fetch and reuse the cached manifest */
  offline?: boolean;
  /** Frontend URL forwarded to the backend on the manifest fetch (dev) */
  clientUrl?: string;
  /**
   * Identity key for the workspace directory. Defaults to the canonical
   * backend URL; autodiscovery mode passes `projectWorkspaceKey(...)` so
   * the workspace survives backend port changes between runs.
   */
  workspaceKey?: string;
  /** Credential presented on the backend's layer endpoints */
  bootstrapSecret?: string;
}

export interface SetupWorkspaceResult {
  workspaceDir: string;
  layers: ResolvedLayer[];
  /** True when the manifest was replayed from cache (backend not contacted or unreachable) */
  manifestFromCache: boolean;
  /** ISO timestamp of the cached manifest, when `manifestFromCache` is true */
  manifestFetchedAt?: string;
}

/**
 * Full workspace setup: fetch the manifest, resolve frontend modules, copy
 * templates, write the workspace package.json with `workspace:*` deps,
 * materialize each module under `<workspace>/frontend-modules/<safeName>/`,
 * write the generated module registry and dms-main.css, and install deps.
 */
export async function setupWorkspace(
  opts: SetupWorkspaceOptions,
): Promise<SetupWorkspaceResult> {
  const { backendUrl, force, mode, offline, clientUrl, bootstrapSecret } = opts;

  const workspaceKey = opts.workspaceKey ?? canonicalizeBackendUrl(backendUrl);
  const workspaceDir = ensureWorkspace(workspaceKey);
  writeWorkspaceMeta(workspaceDir, backendUrl, workspaceKey);

  const resolved = await resolveManifest(
    workspaceDir,
    backendUrl,
    !!offline,
    clientUrl,
    bootstrapSecret,
  );
  const { manifest, fromCache, fetchedAt } = resolved;

  let layers: ResolvedLayer[];
  if (mode === "dev") {
    assertLayerPathsServed(manifest.modules);
    if (fromCache) {
      assertCachedLayerPathsExist(manifest.modules, fetchedAt);
    }
    layers = buildLayersFromPaths(manifest.modules);
  } else {
    const cacheDir = join(workspaceDir, ".layers-cache");
    if (fromCache) {
      // No backend to download from: reuse the layers extracted by the
      // last online run, after checking the extraction is complete —
      // `buildLayersFromCache` silently skips missing archives.
      if (!existsSync(cacheDir)) {
        throw new Error(
          "Backend unreachable and no previously downloaded layers archive — run once with the backend reachable first.",
        );
      }
      assertCachedArchivesExist(manifest.modules, cacheDir, fetchedAt);
    } else {
      await downloadAndExtractLayers(
        backendUrl,
        manifest.pack,
        cacheDir,
        force,
        bootstrapSecret,
      );
    }
    layers = await buildLayersFromCache(manifest.modules, cacheDir);
  }

  copyStaticTemplates(workspaceDir);
  writeWorkspacePackageJson(workspaceDir, layers);
  materializeLayers(workspaceDir, layers);
  writeFrontendModuleRegistry(workspaceDir, layers);
  writeDmsMainCss(workspaceDir, layers);

  const layerPaths = layers.map((layer) => layer.path);
  const shouldInstall = needsInstall(workspaceDir, layerPaths, force);

  // `materializeLayers` always wipes `<workspace>/frontend-modules/` and
  // re-creates it from the current manifest. It must run before
  // `pnpm install` so pnpm sees the workspace packages.
  if (shouldInstall) {
    installDeps(workspaceDir);
    saveDepsHash(workspaceDir, layerPaths);
  }

  return {
    workspaceDir,
    layers,
    manifestFromCache: fromCache,
    manifestFetchedAt: fetchedAt,
  };
}

// ============================================================================
// Dev-mode source watcher
// ============================================================================

// ============================================================================
// Workspace apply primitives (shared by the dev watcher and ZIP/HTTP sync)
// ============================================================================

/** Debounce window for coalescing a burst of watcher events into one apply. */

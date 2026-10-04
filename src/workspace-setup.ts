// Installing the workspace's dependencies, running commands inside it, and the
// setupWorkspace entry point the commands call.
//
// Split out of common.ts, which stays the barrel every command imports from.

import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
  spawnSync,
} from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { CliError, getProcessTasks, isVerboseRun } from "@antelopejs/core/cli";
import {
  createPathMapper,
  describeChildFailure,
  InstallProgress,
  LineSplitter,
  OutputTail,
  type PathMapper,
  stripAnsi,
  writeChildLine,
} from "./child-output";
import {
  assertLayerPathsServed,
  buildLayersFromCache,
  buildLayersFromPaths,
  downloadAndExtractLayers,
  assertCachedArchivesExist,
} from "./layers";
import { assertCachedLayerPathsExist, resolveManifest } from "./manifest";
import {
  collectManifestSecrets,
  type ManifestSecrets,
} from "./manifest-secrets";
import { assertLayersSupportRenderer } from "./renderer-range";
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

const WORKSPACE_PNPM_CONFIG = "pnpm-workspace.yaml";
const WORKSPACE_PATCHES_DIR = "patches";

/**
 * Workspace files besides the package manifests that change what `pnpm
 * install` produces: the pnpm workspace config, which lists the dependency
 * patches, and the patches themselves. A workspace installed before a patch
 * was added or changed has to install again to pick it up.
 */
function workspaceInstallInputs(workspaceDir: string): string[] {
  const patchesDir = join(workspaceDir, WORKSPACE_PATCHES_DIR);
  const patches = existsSync(patchesDir)
    ? readdirSync(patchesDir)
        .sort()
        .map((name) => join(patchesDir, name))
    : [];
  return [join(workspaceDir, WORKSPACE_PNPM_CONFIG), ...patches];
}

export function computeDepsHash(
  layerPaths: string[],
  workspacePackage?: string,
  installInputs: readonly string[] = [],
): string {
  const hash = createHash("sha256");
  if (workspacePackage && existsSync(workspacePackage))
    hash.update(readFileSync(workspacePackage));
  for (const input of installInputs) {
    if (existsSync(input)) hash.update(readFileSync(input));
  }
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
    workspaceInstallInputs(workspaceDir),
  );
  const savedHash = readFileSync(hashFile, "utf-8").trim();
  return currentHash !== savedHash;
}

/**
 * Save the current deps hash after a successful install
 */
export function saveDepsHash(workspaceDir: string, layerPaths: string[]): void {
  const hash = computeDepsHash(
    layerPaths,
    join(workspaceDir, "package.json"),
    workspaceInstallInputs(workspaceDir),
  );
  writeFileSync(join(workspaceDir, DEPS_HASH_FILE), hash);
}

/** Append-only: the CLI reads pnpm's output line by line. */
const PNPM_INSTALL_ARGS = ["install", "--reporter=append-only"];

/**
 * Run pnpm install in the workspace directory, as one task whose label follows
 * pnpm's progress. Its output is kept and replayed on failure, or streamed
 * behind a gutter in a verbose run.
 */
export async function installDeps(
  workspaceDir: string,
  mapLine?: PathMapper,
): Promise<void> {
  const progress = new InstallProgress();
  const task = getProcessTasks().start(progress.label);
  try {
    const { code, lines } = await runFramedCommand("pnpm", PNPM_INSTALL_ARGS, {
      name: "pnpm",
      cwd: workspaceDir,
      // The workspace pins its own pnpm, which a DMS user has no reason to
      // upgrade.
      env: { ...process.env, npm_config_update_notifier: "false" },
      mapLine,
      onLine: (line) => {
        if (progress.read(line)) task.update(progress.label);
      },
    });
    if (code !== 0) {
      throw new CliError(
        describeChildFailure({
          title: "Dependency install failed",
          command: "pnpm install",
          code,
          lines,
          isVerbose: isVerboseRun(),
        }),
      );
    }
    task.succeed(progress.doneLabel);
  } catch (error) {
    task.dismiss();
    throw error;
  }
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
 * The CLI received `signal` while a child was running: the child's process
 * tree has been stopped and the run is cancelled, not failed. The exit code
 * follows the shell convention, 130 for Ctrl+C.
 */
export class CancelledError extends Error {
  readonly exitCode: number;

  constructor(readonly signal: NodeJS.Signals) {
    super(signal === "SIGINT" ? "Stopped" : `Stopped (${signal})`);
    this.name = "CancelledError";
    this.exitCode = exitCodeForSignal(signal);
  }
}

/**
 * Spawn a child process and wait for it to complete.
 *
 * The child owns a port (server.mjs, the Vite dev server) or writes to the
 * workspace (pnpm install, the production build), so neither it nor anything
 * it started may outlive the CLI. On POSIX the child leads its own process
 * group, so a terminal Ctrl-C reaches the CLI alone and the CLI stops the
 * whole tree at once: pnpm, the shell it runs a script in, and Vite under it.
 * On Windows the tree is killed with `taskkill /T`. The tree is killed
 * outright if the CLI goes down for any other reason.
 *
 * Resolves with the child's exit code; rejects with a `CancelledError` when
 * the CLI received SIGINT, SIGTERM or SIGHUP while the child was running.
 * `onSpawn` receives the child as soon as it exists, to read its piped output.
 */
export function runCommand(
  command: string,
  args: string[],
  options?: SpawnOptions,
  onSpawn?: (child: ChildProcess) => void,
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
      // A new process group on POSIX, whose id is the child's pid. On
      // Windows it would open a new console window instead.
      detached: !isWindows,
    });
    onSpawn?.(child);

    let escalation: NodeJS.Timeout | undefined;
    let forwarded: NodeJS.Signals | undefined;

    const alive = () => child.exitCode === null && child.signalCode === null;

    const signalTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (isWindows) {
          // Windows has no signal delivery: the tree is terminated at once,
          // so the escalation below is a no-op there.
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {
        // The whole group already exited.
      }
    };

    const stopChild = (signal: NodeJS.Signals) => {
      if (!alive()) return;
      signalTree(signal);
      if (escalation || isWindows) return;
      escalation = setTimeout(() => {
        if (alive()) signalTree("SIGKILL");
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
      if (alive()) signalTree("SIGKILL");
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
      if (forwarded) {
        // A grandchild that ignored the signal would be reparented to init
        // and keep running after the CLI exits.
        if (!isWindows) signalTree("SIGKILL");
        return reject(new CancelledError(forwarded));
      }
      if (code !== null) return resolve(code);
      resolve(exitCodeForSignal(signal ?? "SIGTERM"));
    });
  });
}

/** How long piped output may keep arriving once the child has exited. */
const OUTPUT_DRAIN_TIMEOUT_MS = 2000;

export interface FramedCommandOptions {
  /** Names the child in the gutter of a verbose run. */
  name: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Rewrites each line before anything reads it, e.g. workspace paths. */
  mapLine?: PathMapper;
  /** Receives each line, mapped and without colors. */
  onLine?: (line: string) => void;
}

export interface FramedCommandResult {
  code: number;
  /** The last lines of stdout and stderr, interleaved, without colors. */
  lines: string[];
}

/** Resolves once the stream ended or failed. */
function drained(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((settle) => {
    stream.once("end", settle);
    stream.once("error", settle);
  });
}

function drainTimeout(): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, OUTPUT_DRAIN_TIMEOUT_MS).unref();
  });
}

/**
 * Run a child whose output the CLI frames instead of letting it reach the
 * terminal: kept for the failure report, or streamed behind a gutter naming
 * the child in a verbose run. Signals stop it as `runCommand` does.
 */
export async function runFramedCommand(
  command: string,
  args: string[],
  options: FramedCommandOptions,
): Promise<FramedCommandResult> {
  const { name, cwd, env, mapLine = (line) => line, onLine } = options;
  const isVerbose = isVerboseRun();
  const tail = new OutputTail();
  const readLine = (line: string) => {
    const mapped = mapLine(line);
    if (isVerbose) writeChildLine(name, mapped);
    const plain = stripAnsi(mapped);
    tail.push(plain);
    onLine?.(plain);
  };
  let ended: Promise<unknown> = Promise.resolve();
  const code = await runCommand(
    command,
    args,
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    (child) => {
      const streams = [child.stdout, child.stderr];
      for (const stream of streams) {
        const splitter = new LineSplitter(readLine);
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => splitter.push(chunk));
        stream?.once("end", () => splitter.flush());
      }
      ended = Promise.all(streams.map((stream) => drained(stream)));
    },
  );
  await Promise.race([ended, drainTimeout()]);
  return { code, lines: tail.lines() };
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
  /** Called before `pnpm install` starts, e.g. to end the task that set the workspace up */
  beforeInstall?: () => Promise<void>;
}

export interface SetupWorkspaceResult {
  workspaceDir: string;
  layers: ResolvedLayer[];
  /** True when the manifest was replayed from cache (backend not contacted or unreachable) */
  manifestFromCache: boolean;
  /** ISO timestamp of the cached manifest, when `manifestFromCache` is true */
  manifestFetchedAt?: string;
  /** Server secrets the backend published in the manifest */
  manifestSecrets: ManifestSecrets;
}

/**
 * Full workspace setup: fetch the manifest, resolve frontend modules, check
 * that each supports this loader release, copy templates, write the workspace
 * package.json with `workspace:*` deps, materialize each module under
 * `<workspace>/frontend-modules/<safeName>/`, write the generated module
 * registry and dms-main.css, and install deps.
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
    assertLayerPathsServed(manifest.modules, backendUrl, bootstrapSecret);
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
        throw new CliError({
          title:
            "The backend is unreachable and no layers archive was downloaded before",
          fixes: ["Run once with the backend reachable first"],
        });
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

  assertLayersSupportRenderer(layers);

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
    await opts.beforeInstall?.();
    await installDeps(workspaceDir, createPathMapper(workspaceDir, layers));
    saveDepsHash(workspaceDir, layerPaths);
  }

  return {
    workspaceDir,
    layers,
    manifestFromCache: fromCache,
    manifestFetchedAt: fetchedAt,
    manifestSecrets: collectManifestSecrets(manifest.modules),
  };
}

// ============================================================================
// Dev-mode source watcher
// ============================================================================

// ============================================================================
// Workspace apply primitives (shared by the dev watcher and ZIP/HTTP sync)
// ============================================================================

/** Debounce window for coalescing a burst of watcher events into one apply. */

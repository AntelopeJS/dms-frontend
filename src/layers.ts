// Resolving the manifest's frontend modules onto disk -- downloading and
// extracting them, or rebuilding them from cache -- so the workspace can
// materialize them and build its module registry.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { CliError } from "@antelopejs/core/cli";
import {
  backendEndpoint,
  BackendResponseError,
  displayUrl,
  fetchFromBackend,
  ServedWithPath,
} from "./manifest";
import { ManifestModule, ResolvedLayer } from "./workspace";
import { syncDirectories } from "./fs-sync";
import { LAYERS_SUBDIR } from "./config";
import { formatAge } from "./output";

// ============================================================================
// Constants
// ============================================================================

/** What the user does when a backend never sends layer source paths. */
const BUILD_FIX =
  "A remote or production backend never sends them: use `ajs dms build` against it";

/** Where a manifest without layer source paths came from. */
interface PathlessManifestSource {
  /** The credential this run sent the backend, when it sent one. */
  bootstrapSecret?: string;
  /** Set when the manifest was read from the cache rather than fetched. */
  cache?: { fetchedAt?: string };
}

/**
 * Dev mode extends each layer from its source directory on this machine, so
 * a manifest without those paths cannot drive it. A development backend
 * sends them only to callers presenting its credential, so the likely cause
 * depends on whether this run sent one, or sent nothing at all because the
 * manifest came from the cache.
 */
export function assertLayerPathsServed(
  modules: ManifestModule[],
  backendUrl: string,
  { bootstrapSecret, cache }: PathlessManifestSource = {},
): asserts modules is ServedWithPath[] {
  const pathless = modules.filter((mod) => !mod.path);
  if (pathless.length === 0) return;
  const count = `${pathless.length} of ${modules.length} module${modules.length === 1 ? "" : "s"}`;
  if (cache) {
    const fetched = cache.fetchedAt
      ? ` (fetched ${formatAge(cache.fetchedAt)})`
      : "";
    throw new CliError({
      title: `The cached manifest of ${displayUrl(backendUrl)}${fetched} has no layer source paths (${count})`,
      reason:
        "This run did not fetch it. The backend sends the paths only to callers presenting its development credential, and did not send them to the run that cached this manifest.",
      fixes: [
        "Run once without --offline, with the backend reachable, from the project started with `ajs project dev` or with DMS_BOOTSTRAP_SECRET set",
        BUILD_FIX,
      ],
    });
  }
  const { reason, fix } = bootstrapSecret
    ? {
        reason:
          "It sends them only to callers presenting its development credential, and did not accept the one this run sent.",
        fix: "Run the command from the antelope project started with `ajs project dev`, without DMS_BOOTSTRAP_SECRET or --bootstrap-secret, so the credential is read from .antelope/dms-dev.json",
      }
    : {
        reason:
          "It sends them only to callers presenting its development credential, and this run sent none: " +
          "no DMS_BOOTSTRAP_SECRET or --bootstrap-secret, and no project started with `ajs project dev` " +
          "serving this backend was found from the current directory, so no .antelope/dms-dev.json was read.",
        fix: "Run the command from that project, or set DMS_BOOTSTRAP_SECRET to the backend's credential",
      };
  throw new CliError({
    title: `The backend at ${displayUrl(backendUrl)} did not send layer source paths (${count})`,
    reason,
    fixes: [fix, BUILD_FIX],
  });
}

/**
 * Build-mode counterpart of `assertCachedLayerPathsExist`: the extracted
 * `.layers-cache` can be left incomplete by an interrupted download, and
 * `buildLayersFromCache` silently skips manifest entries whose archive
 * directory is absent — an offline build would then proceed against a
 * partial (possibly empty) layer set with no warning.
 */
export function assertCachedArchivesExist(
  modules: ManifestModule[],
  cacheDir: string,
  fetchedAt?: string,
): void {
  const present = new Set(readdirSync(cacheDir));
  const missing = modules.filter((mod) => !present.has(mod.archiveName));
  if (missing.length === 0) return;
  throw new CliError({
    title: `The cached layers archive is missing entries listed in the manifest${fetchedAt ? ` (fetched ${formatAge(fetchedAt)})` : ""}`,
    fixes: ["Run once with the backend reachable to download the layers again"],
    details: missing.map((mod) => `${mod.name}: ${mod.archiveName}`),
  });
}

// ============================================================================
// Layer Resolution
// ============================================================================

/**
 * Sort frontend modules by descending priority.
 */
function sortModulesByPriority<T extends ManifestModule>(modules: T[]): T[] {
  return [...modules].sort((a, b) => b.priority - a.priority);
}

/** The fields of a layer's package.json the loader reads. */
export interface LayerPackage {
  name?: unknown;
  engines?: Record<string, unknown>;
}

/**
 * Read a layer's package.json, or undefined when it is missing or unreadable.
 */
export function readLayerPackage(layerPath: string): LayerPackage | undefined {
  const pkgPath = join(layerPath, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    return JSON.parse(readFileSync(pkgPath, "utf-8"));
  } catch {
    return undefined;
  }
}

/**
 * Read a layer's npm package name from its package.json "name" field.
 */
function readLayerPackageName(layerPath: string): string | undefined {
  const name = readLayerPackage(layerPath)?.name;
  return typeof name === "string" ? name : undefined;
}

function resolveLayer(layerPath: string, mod: ManifestModule): ResolvedLayer {
  return {
    path: layerPath,
    name: mod.name,
    sourcePath: mod.path,
    packageName: readLayerPackageName(layerPath),
    priority: mod.priority,
    configKey: mod.configKey,
    options: mod.options,
    authEstablishEndpoints: mod.authEstablishEndpoints,
  };
}

/**
 * Build a list of ResolvedLayer from a manifest where each module's `path`
 * points directly at a local layer directory (dev mode).
 */
export function buildLayersFromPaths(
  modules: ServedWithPath[],
): ResolvedLayer[] {
  return sortModulesByPriority(modules).map((mod) =>
    resolveLayer(mod.path, mod),
  );
}

/**
 * Download and extract the layers ZIP archive from the backend
 */
export async function downloadAndExtractLayers(
  backendUrl: string,
  packUrl: string,
  cacheDir: string,
  force: boolean,
  bootstrapSecret?: string,
): Promise<void> {
  const url = backendEndpoint(backendUrl, packUrl);
  const response = await fetchFromBackend(backendUrl, url, bootstrapSecret);
  if (!response.ok) {
    throw new BackendResponseError("the layers archive", url, response);
  }
  if (!response.body) {
    throw new Error(
      `The layers archive from ${displayUrl(url)} came without a body`,
    );
  }

  const modulesBlob = await buffer(Readable.fromWeb(response.body as any));
  // Only build needs it, and it is the heaviest module the CLI loads.
  const { Open } = await import("unzipper");

  const cacheExists = existsSync(cacheDir);

  if (force || !cacheExists) {
    if (cacheExists) {
      rmSync(cacheDir, { recursive: true, force: true });
    }
    await (await Open.buffer(modulesBlob)).extract({ path: cacheDir });
    return;
  }

  const tempDir = `${cacheDir}_temp`;
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  await (await Open.buffer(modulesBlob)).extract({ path: tempDir });

  const tempEntries = readdirSync(tempDir);
  for (const entry of tempEntries) {
    syncDirectories(join(tempDir, entry), join(cacheDir, entry));
  }

  rmSync(tempDir, { recursive: true, force: true });
}

/**
 * Build a list of ResolvedLayer from an extracted cache directory (build mode).
 * Skips manifest entries whose archive directory is not present in the cache.
 */
export async function buildLayersFromCache(
  modules: ManifestModule[],
  cacheDir: string,
): Promise<ResolvedLayer[]> {
  if (!existsSync(cacheDir)) return [];

  const layerFiles = await readdir(cacheDir);
  const layers: ResolvedLayer[] = [];

  for (const mod of sortModulesByPriority(modules)) {
    if (!layerFiles.includes(mod.archiveName)) continue;
    const layerPath = join(cacheDir, mod.archiveName);
    layers.push(resolveLayer(layerPath, mod));
  }

  return layers;
}

// ============================================================================
// Generated Layers Data
// ============================================================================

/**
 * Derive a filesystem-safe directory name for a layer from its package name,
 * falling back to the basename of its path. Used to name each module's
 * directory inside `<workspace>/frontend-modules/`.
 */
export function getLayerSafeName(layer: ResolvedLayer): string {
  if (layer.packageName) {
    return layer.packageName.replace(/^@/, "").replace(/\//g, "__");
  }
  return basename(layer.path);
}

/**
 * Resolve the absolute path where this module is (or will be) materialized
 * inside the workspace's `frontend-modules/` directory.
 */
export function getLayerWorkspacePath(
  workspaceDir: string,
  layer: ResolvedLayer,
): string {
  return join(workspaceDir, LAYERS_SUBDIR, getLayerSafeName(layer));
}

// ============================================================================
// Workspace File Generation
// ============================================================================

/**
 * Get the package root directory (where the package.json and
 * templates/ directory live). Works for both `dist/common.js` (published)
 * and `src/common.ts` (via tsx during development).
 */

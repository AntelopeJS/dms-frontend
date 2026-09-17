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
import { Open } from "unzipper";
import { ManifestUnauthorizedError, ServedWithPath } from "./manifest";
import {
  ManifestModule,
  ResolvedLayer,
  bootstrapHeaders,
  isUnauthorized,
} from "./workspace";
import { syncDirectories } from "./fs-sync";
import { LAYERS_SUBDIR } from "./config";

// ============================================================================
// Constants
// ============================================================================

export function assertLayerPathsServed(
  modules: ManifestModule[],
): asserts modules is ServedWithPath[] {
  const pathless = modules.filter((mod) => !mod.path);
  if (pathless.length === 0) return;
  throw new Error(
    "The backend served a manifest without layer source paths:\n" +
      pathless.map((mod) => `  - ${mod.name}`).join("\n") +
      "\n`ajs-dms dev` needs a development backend running on this machine (started with " +
      "`ajs project dev`); use `ajs-dms build` against a remote or production one.\n" +
      "If the backend is local and in development mode, it did not recognize the bootstrap " +
      "credential — see DMS_BOOTSTRAP_SECRET.",
  );
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
  throw new Error(
    `Cached layers archive is missing entries listed in the manifest${fetchedAt ? ` (fetched ${fetchedAt})` : ""}:\n` +
      missing.map((mod) => `  - ${mod.name}: ${mod.archiveName}`).join("\n") +
      "\nRun once with the backend reachable to re-download the layers.",
  );
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

/**
 * Read a layer's npm package name from its package.json "name" field.
 */
function readLayerPackageName(layerPath: string): string | undefined {
  const pkgPath = join(layerPath, "package.json");
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return typeof pkg.name === "string" ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

function resolveLayer(layerPath: string, mod: ManifestModule): ResolvedLayer {
  return {
    path: layerPath,
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
  modules: ManifestModule[],
): ResolvedLayer[] {
  assertLayerPathsServed(modules);
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
  const url = `${backendUrl}${packUrl}`;
  const response = await fetch(url, {
    headers: bootstrapHeaders(bootstrapSecret),
  });

  if (isUnauthorized(response.status)) {
    throw new ManifestUnauthorizedError(url, response.status);
  }
  if (!response.ok || !response.body) {
    throw new Error("Failed to download layers archive");
  }

  const modulesBlob = await buffer(Readable.fromWeb(response.body as any));

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

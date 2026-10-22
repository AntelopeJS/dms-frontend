// Resolving the manifest's frontend modules onto disk -- downloading and
// extracting them, or rebuilding them from cache -- so the workspace can
// materialize them and build its module registry.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import { displayUrl, ServedWithPath } from "./manifest";
import { ManifestModule, ResolvedLayer } from "./workspace";
import { LAYERS_SUBDIR } from "./config";
import { formatAge } from "./output";

// ============================================================================
// Constants
// ============================================================================

/** What the user does when a backend never sends layer source paths. */
const BUILD_FIX =
  "A remote or production backend never sends them: build the frontend from the project instead, with `ajs dms build`";

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
  /** The module's frontend registration file, see `project-modules.ts`. */
  dmsFrontend?: unknown;
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
    privateOptions: mod.privateOptions,
    authEstablishEndpoints: mod.authEstablishEndpoints,
    publicEndpoints: mod.publicEndpoints,
    backendProxies: mod.backendProxies,
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

// Fetching the frontend manifest from the backend, and the on-disk cache that
// lets a workspace start without it.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSecretBearingFile } from "./config";
import {
  Manifest,
  bootstrapHeaders,
  FRONTEND_MANIFEST_VERSION,
  FrontendManifest,
  isUnauthorized,
  ManifestModule,
} from "./workspace";

// ============================================================================
// Constants
// ============================================================================

export class ManifestUnauthorizedError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(
      `Backend refused the layers request (${status}) at ${url}.\n` +
        "  This DMS backend requires a bootstrap credential for its layer endpoints.\n" +
        "  • Production/CI: set DMS_BOOTSTRAP_SECRET to the backend's frontend.bootstrapSecret.\n" +
        "  • Local dev: run inside the antelope project started with `ajs project dev` —\n" +
        "    the credential is read from .antelope/dms-dev.json automatically.",
    );
    this.name = "ManifestUnauthorizedError";
  }
}

/**
 * Fetch the layers manifest from the DMS backend. `clientUrl` tells a
 * dev-mode backend where the frontend will actually be reachable (real
 * resolved port included) so it can serve a matching `clientBaseUrl` and
 * whitelist that origin for CORS; production backends ignore it.
 */
export async function fetchManifest(
  backendUrl: string,
  clientUrl?: string,
  bootstrapSecret?: string,
): Promise<Manifest> {
  const frontendUrl = new URL(`${backendUrl}/dms/frontend`);
  frontendUrl.searchParams.set("renderer", "vue");
  frontendUrl.searchParams.set("rendererVersion", "3");
  if (clientUrl) {
    frontendUrl.searchParams.set("clientUrl", clientUrl);
  }
  const response = await fetch(frontendUrl, {
    headers: bootstrapHeaders(bootstrapSecret),
  });

  if (isUnauthorized(response.status)) {
    throw new ManifestUnauthorizedError(frontendUrl.href, response.status);
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch manifest from ${frontendUrl.href} (${response.status})`,
    );
  }

  const manifest = (await response.json()) as FrontendManifest;
  if (manifest.version !== FRONTEND_MANIFEST_VERSION) {
    throw new Error(
      `Unsupported frontend manifest version: ${String(manifest.version)}`,
    );
  }
  const incompatible = manifest.modules.filter(
    (module) =>
      module.renderer?.name !== "vue" || module.renderer?.version !== "3",
  );
  if (incompatible.length) {
    throw new Error(
      `Frontend manifest contains incompatible renderer modules: ${incompatible.map((module) => module.name).join(", ")}`,
    );
  }
  return { pack: manifest.archive, modules: manifest.modules };
}

// ============================================================================
// Manifest Cache
// ============================================================================

/**
 * The manifest is the only thing the backend is needed for during workspace
 * setup — everything downstream (frontend-module materialization, pnpm
 * install, workspace generation) is local. Caching the last successful
 * response per workspace lets `prepare`/`dev` run without a live backend,
 * which matters because `prepare` typically runs from a frontend module's
 * `postinstall` hook.
 *
 * One entry per file: the workspace directory is already keyed by the
 * canonical backend URL, so a workspace can only ever see one manifest.
 */
const MANIFEST_CACHE_FILE = ".manifest-cache.json";

export interface ManifestCacheEntry {
  manifest: Manifest;
  fetchedAt: string;
}

export function readCachedManifest(
  workspaceDir: string,
): ManifestCacheEntry | undefined {
  const file = join(workspaceDir, MANIFEST_CACHE_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (!parsed?.manifest) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeCachedManifest(workspaceDir: string, manifest: Manifest): void {
  const entry: ManifestCacheEntry = {
    manifest,
    fetchedAt: new Date().toISOString(),
  };
  writeSecretBearingFile(
    join(workspaceDir, MANIFEST_CACHE_FILE),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
}

export interface ResolvedManifest {
  manifest: Manifest;
  fromCache: boolean;
  fetchedAt?: string;
}

/**
 * Get the manifest, preferring the live backend. On fetch failure we fall
 * back to the cached copy (with `fromCache: true` so callers can surface a
 * warning). With `offline` we skip the network call entirely.
 *
 * Note the workspace directory is derived from the backend URL hash, so a
 * mistyped URL maps to a different (empty) workspace and still fails hard
 * — the fallback only ever replays a manifest that URL actually served.
 * (In autodiscovery mode the workspace is keyed on the project path
 * instead, which is exactly what lets the cache survive backend port
 * changes between runs.)
 *
 * A rejected credential is the one failure that does not fall back: the
 * backend is actively withholding what the cache may still contain. The cache
 * is deliberately not keyed on the credential beyond that — a development
 * backend mints a fresh secret on every boot (the previous one dies with its
 * pid even though the handshake file stays behind), so binding the entry to it
 * would make the offline replay this cache exists for unreachable from the
 * second run onward.
 */
export async function resolveManifest(
  workspaceDir: string,
  backendUrl: string,
  offline: boolean,
  clientUrl?: string,
  bootstrapSecret?: string,
): Promise<ResolvedManifest> {
  if (!offline) {
    try {
      const manifest = await fetchManifest(
        backendUrl,
        clientUrl,
        bootstrapSecret,
      );
      writeCachedManifest(workspaceDir, manifest);
      return { manifest, fromCache: false };
    } catch (err) {
      if (err instanceof ManifestUnauthorizedError) throw err;
      const cached = readCachedManifest(workspaceDir);
      if (!cached) throw err;
      return fromCachedEntry(cached);
    }
  }

  const cached = readCachedManifest(workspaceDir);
  if (!cached) {
    throw new Error(
      "No cached manifest for this workspace — run once with the backend reachable before using --offline.",
    );
  }
  return fromCachedEntry(cached);
}

function fromCachedEntry(cached: ManifestCacheEntry): ResolvedManifest {
  return {
    manifest: cached.manifest,
    fromCache: true,
    fetchedAt: cached.fetchedAt,
  };
}

/**
 * A cached manifest can outlive the layer sources it points at (backend
 * module reinstalled elsewhere, repo moved, …). Fail with an actionable
 * message rather than letting `materializeLayers` crash on cpSync —
 * partial type generation from the surviving layers would be worse than
 * no generation.
 */
export function assertCachedLayerPathsExist(
  modules: ServedWithPath[],
  fetchedAt?: string,
): void {
  const missing = modules.filter((mod) => !existsSync(mod.path));
  if (missing.length === 0) return;
  throw new Error(
    `Cached manifest${fetchedAt ? ` (fetched ${fetchedAt})` : ""} references layer paths that no longer exist:\n` +
      missing.map((mod) => `  - ${mod.name}: ${mod.path}`).join("\n") +
      "\nStart the backend and re-run to refresh the cache.",
  );
}

/**
 * Dev mode extends each layer from its source directory on this machine, so
 * a manifest without those paths cannot drive it. The backend withholds them
 * from production instances and from callers it did not authenticate, which
 * are two very different mistakes — name both.
 */

export type ServedWithPath = ManifestModule & { path: string };

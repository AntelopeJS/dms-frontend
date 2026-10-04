// Fetching the frontend manifest from the backend, and the on-disk cache that
// lets a workspace start without it.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CliError,
  type CliProblem,
  FAILURE_EXIT_CODE,
} from "@antelopejs/core/cli";
import { parseBackendUrl, UsageError, writeSecretBearingFile } from "./config";
import { cachedAge, formatAge } from "./output";
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

export class ManifestUnauthorizedError extends CliError {
  constructor(
    readonly url: string,
    readonly status: number,
    credentialSent: boolean,
  ) {
    super({
      title: credentialSent
        ? `The backend refused the bootstrap credential (${status}) at ${url}`
        : `The backend requires a bootstrap credential (${status}) at ${url}, and none was sent`,
      fixes: [
        "Production/CI: set DMS_BOOTSTRAP_SECRET to the backend's frontend.bootstrapSecret",
        "Local dev: run inside the antelope project started with `ajs project dev`; the credential is read from .antelope/dms-dev.json automatically",
      ],
    });
    this.name = "ManifestUnauthorizedError";
  }
}

const UNREACHABLE_REASONS: Record<string, string> = {
  ECONNREFUSED: "Connection refused",
  ECONNRESET: "Connection reset",
  ENOTFOUND: "Unknown host",
  EAI_AGAIN: "Host name lookup failed",
  ETIMEDOUT: "Connection timed out",
  UND_ERR_CONNECT_TIMEOUT: "Connection timed out",
};

const UNKNOWN_HOST_CODES = ["ENOTFOUND", "EAI_AGAIN"];

/**
 * `fetch` reports every transport failure as a bare "fetch failed" and keeps
 * the reason in its `cause`. Still a plain failure for `resolveManifest`, so
 * the cache can stand in for a backend that is down.
 */
export class BackendUnreachableError extends CliError {
  readonly code?: string;

  constructor(
    readonly url: string,
    failure: unknown,
  ) {
    const cause = (failure as { cause?: unknown })?.cause ?? failure;
    const code = errorCode(cause);
    const detail = code
      ? (UNREACHABLE_REASONS[code] ?? errorMessage(cause))
      : `The request failed: ${errorMessage(cause)}`;
    const fix =
      code && UNKNOWN_HOST_CODES.includes(code)
        ? `Check the host name '${new URL(url).hostname}' in -b <url> or DMS_API_BASE_URL`
        : "Start the backend (`ajs project dev` for a local one), or pass its URL with -b <url>";
    super(
      {
        title: `Cannot reach the DMS backend at ${url}`,
        reason: `${code ? `${detail} (${code})` : detail}.`,
        fixes: [fix],
      },
      { cause: failure },
    );
    this.name = "BackendUnreachableError";
    this.code = code;
  }
}

function errorCode(err: unknown): string | undefined {
  const { code, errors } = (err ?? {}) as { code?: unknown; errors?: unknown };
  if (typeof code === "string") return code;
  return Array.isArray(errors) ? errorCode(errors[0]) : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A URL as shown in a message: without the query string the CLI adds for the
 * backend, and without credentials a user may have put in it.
 */
export function displayUrl(url: string | URL): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname.replace(/\/$/, "")}`;
}

/**
 * The URL of an endpoint of the backend. The command line rejects a URL fetch
 * cannot use, but a discovered backend never went through that check.
 */
export function backendEndpoint(backendUrl: string, path: string): URL {
  try {
    return new URL(`${parseBackendUrl(backendUrl)}${path}`);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    throw new CliError(
      { ...err.problem, exitCode: FAILURE_EXIT_CODE },
      { cause: err },
    );
  }
}

/**
 * Request an endpoint of the backend, presenting the bootstrap credential
 * when there is one. A backend that cannot be reached fails with its URL and
 * the cause, and a refused credential with the endpoint that refused it.
 */
export async function fetchFromBackend(
  backendUrl: string,
  url: URL,
  bootstrapSecret?: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: bootstrapHeaders(bootstrapSecret) });
  } catch (err) {
    throw new BackendUnreachableError(displayUrl(backendUrl), err);
  }
  if (isUnauthorized(response.status)) {
    throw new ManifestUnauthorizedError(
      displayUrl(url),
      response.status,
      !!bootstrapSecret,
    );
  }
  return response;
}

/**
 * The backend answered with a manifest this renderer cannot run: another
 * protocol version, or modules built for another renderer. Unlike an outage,
 * the cache must not stand in for it, since the backend has just said the
 * cached modules are not what it serves any more.
 */
export class ManifestRefusedError extends CliError {
  constructor(problem: string | CliProblem) {
    super(typeof problem === "string" ? { title: problem } : problem);
    this.name = "ManifestRefusedError";
  }
}

const OWN_RELEASE: {
  name: string;
  version: string;
} = require("../package.json");
const BACKEND_PACKAGE = "@antelopejs/dms";
const LOADER_UPDATE_COMMAND = "ajs update dms";

/**
 * A manifest of another protocol version: which side is behind, the versions
 * on both, and the side to upgrade.
 */
export function describeManifestVersion(version: unknown): CliProblem {
  const loader = `${OWN_RELEASE.name} ${OWN_RELEASE.version}`;
  const supported = `This loader reads version ${FRONTEND_MANIFEST_VERSION}`;
  if (typeof version !== "number") {
    return {
      title:
        "The backend served a frontend manifest without a protocol version",
      reason: `${supported}; the answer does not look like one from ${BACKEND_PACKAGE}.`,
      fixes: [
        `Check that -b <url> points at a DMS backend running ${BACKEND_PACKAGE}`,
      ],
    };
  }
  const title = `The backend serves frontend manifest version ${version}, which ${loader} cannot read`;
  if (version > FRONTEND_MANIFEST_VERSION) {
    return {
      title,
      reason: `${supported}; the backend's ${BACKEND_PACKAGE} is newer than this loader.`,
      fixes: [
        `Upgrade the loader (${LOADER_UPDATE_COMMAND}) to a release that reads version ${version}`,
      ],
    };
  }
  return {
    title,
    reason: `${supported}; the backend's ${BACKEND_PACKAGE} is older than this loader.`,
    fixes: [
      `Upgrade ${BACKEND_PACKAGE} on the backend, or use a ${OWN_RELEASE.name} release that reads version ${version}`,
    ],
  };
}

/**
 * The backend answered a request for `subject` with an error status. A 5xx is
 * the backend failing, and only its own logs say why; any other status means
 * the URL does not lead to a DMS backend's endpoint.
 */
export class BackendResponseError extends CliError {
  constructor(
    subject: string,
    url: string | URL,
    response: Pick<Response, "status" | "statusText">,
  ) {
    const { status, statusText } = response;
    const answer = `HTTP ${status}${statusText ? ` ${statusText}` : ""}`;
    const shown = displayUrl(url);
    const problem: CliProblem =
      status >= 500
        ? {
            title: `The DMS backend failed to serve ${subject} (${answer})`,
            reason: `${shown} answered ${status}: the backend failed on the request.`,
            fixes: [
              "Check the backend logs (the `ajs project dev` output for a local backend), then run again",
            ],
          }
        : {
            title: `The DMS backend did not serve ${subject} (${answer})`,
            reason: `${shown} answered ${status}.`,
            fixes: [
              `Check that -b <url> points at a DMS backend running ${BACKEND_PACKAGE}`,
            ],
          };
    super(problem);
    this.name = "BackendResponseError";
  }
}

/**
 * --offline on a workspace no backend has served yet: like an outage, the
 * backend is out of reach rather than refusing anything.
 */
export class NoCachedManifestError extends CliError {
  constructor() {
    super({
      title: "No cached manifest for this workspace",
      fixes: ["Run once with the backend reachable before using --offline"],
    });
    this.name = "NoCachedManifestError";
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
  const frontendUrl = backendEndpoint(backendUrl, "/dms/frontend");
  frontendUrl.searchParams.set("renderer", "vue");
  frontendUrl.searchParams.set("rendererVersion", "3");
  if (clientUrl) {
    frontendUrl.searchParams.set("clientUrl", clientUrl);
  }
  const response = await fetchFromBackend(
    backendUrl,
    frontendUrl,
    bootstrapSecret,
  );
  if (!response.ok) {
    throw new BackendResponseError(
      "the frontend manifest",
      frontendUrl,
      response,
    );
  }

  const manifest = (await response.json()) as FrontendManifest;
  if (manifest.version !== FRONTEND_MANIFEST_VERSION) {
    throw new ManifestRefusedError(describeManifestVersion(manifest.version));
  }
  const incompatible = manifest.modules.filter(
    (module) =>
      module.renderer?.name !== "vue" || module.renderer?.version !== "3",
  );
  if (incompatible.length) {
    throw new ManifestRefusedError(
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

/**
 * When the cached manifest stands in for the backend: `fallback` replays it
 * when the backend cannot be reached or fails (dev, prepare), `offline`
 * without asking the backend, and `never` fails instead (build, whose output
 * is deployed: a stale frontend must be asked for with --offline).
 */
export type ManifestCacheUse = "fallback" | "offline" | "never";

export interface ResolvedManifest {
  manifest: Manifest;
  fromCache: boolean;
  fetchedAt?: string;
}

/**
 * Get the manifest, preferring the live backend. On fetch failure we fall
 * back to the cached copy (with `fromCache: true` so callers can surface a
 * warning), unless `cacheUse` is `never`. With `offline` we skip the network
 * call entirely.
 *
 * Note the workspace directory is derived from the backend URL hash, so a
 * mistyped URL maps to a different (empty) workspace and still fails hard
 * — the fallback only ever replays a manifest that URL actually served.
 * (In autodiscovery mode the workspace is keyed on the project path
 * instead, which is exactly what lets the cache survive backend port
 * changes between runs.)
 *
 * A rejected credential and a refused manifest are the failures that do not
 * fall back: the backend answered, and either withholds what the cache may
 * still contain or serves something this renderer cannot run. Only a backend
 * that cannot be reached, or fails, is replaced by the cache. The cache
 * is deliberately not keyed on the credential beyond that — a development
 * backend mints a fresh secret on every boot (the previous one dies with its
 * pid even though the handshake file stays behind), so binding the entry to it
 * would make the offline replay this cache exists for unreachable from the
 * second run onward.
 */
export async function resolveManifest(
  workspaceDir: string,
  backendUrl: string,
  cacheUse: ManifestCacheUse,
  clientUrl?: string,
  bootstrapSecret?: string,
): Promise<ResolvedManifest> {
  if (cacheUse !== "offline") {
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
      if (err instanceof ManifestRefusedError) throw err;
      const cached = readCachedManifest(workspaceDir);
      if (!cached) throw err;
      if (cacheUse === "never") throw cacheNotUsed(err, backendUrl, cached);
      return fromCachedEntry(cached);
    }
  }

  const cached = readCachedManifest(workspaceDir);
  if (!cached) throw new NoCachedManifestError();
  return fromCachedEntry(cached);
}

/**
 * The backend failure a build stops on when a cache could have replaced it:
 * the failure itself, then how to build from the cache on purpose.
 */
function cacheNotUsed(
  failure: unknown,
  backendUrl: string,
  cached: ManifestCacheEntry,
): CliError {
  const problem =
    failure instanceof CliError
      ? failure.problem
      : { title: errorMessage(failure) };
  const cache = `A manifest${cachedAge(cached.fetchedAt)} exists; a build uses it only with --offline.`;
  return new CliError(
    {
      ...problem,
      reason: problem.reason ? `${problem.reason} ${cache}` : cache,
      fixes: [
        ...(problem.fixes ?? []),
        `Or build from the cache on purpose: ajs dms build -b ${displayUrl(backendUrl)} --offline`,
      ],
    },
    { cause: failure },
  );
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
  throw new CliError({
    title: `The cached manifest${fetchedAt ? ` (fetched ${formatAge(fetchedAt)})` : ""} references layer paths that no longer exist`,
    fixes: ["Start the backend and run again to refresh the cache"],
    details: missing.map((mod) => `${mod.name}: ${mod.path}`),
  });
}

export type ServedWithPath = ManifestModule & { path: string };

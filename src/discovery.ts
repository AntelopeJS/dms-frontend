import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ============================================================================
// Backend autodiscovery via .antelope/dev.json
// ============================================================================

/**
 * Shared contract with the antelopejs core: `ajs project dev` writes
 * `.antelope/dev.json` at the project root, listing the endpoints each
 * server module actually bound (the api module may have fallen back to
 * another port when its configured one was busy). The file is only valid
 * while the process that wrote it is alive — a dead `pid` means the file
 * is an orphan left behind by a crash and must be ignored.
 */
export interface DevRegistryEndpoint {
  protocol: string;
  host: string;
  port: number;
}

export interface DevRegistry {
  pid: number;
  startedAt?: string;
  servers: Record<string, { endpoints: DevRegistryEndpoint[] }>;
}

export const DEV_REGISTRY_RELATIVE_PATH = join(".antelope", "dev.json");

export interface DiscoveredBackend {
  /** Antelope project root containing `.antelope/dev.json` */
  projectDir: string;
  registry: DevRegistry;
  backendUrl: string;
}

export interface DiscoveryOptions {
  /** Injectable for tests; defaults to a `process.kill(pid, 0)` probe */
  isPidAlive?: (pid: number) => boolean;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // EPERM means the process exists but belongs to another user.
    return err?.code === "EPERM";
  }
}

function parseRegistry(file: string): DevRegistry | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (
      typeof parsed?.pid !== "number" ||
      typeof parsed?.servers !== "object" ||
      parsed.servers === null
    ) {
      return undefined;
    }
    return parsed as DevRegistry;
  } catch {
    return undefined;
  }
}

/**
 * The registry records the address the api server actually bound, which
 * is a wildcard (`0.0.0.0` / `::`) in the common bind-all setup — not a
 * reachable URL host (connecting to `0.0.0.0` fails on many Linux
 * setups). Discovery only ever finds same-machine backends, so loopback
 * is the right substitute. Bare IPv6 literals need brackets in a URL.
 */
export function buildBackendUrl(endpoint: DevRegistryEndpoint): string {
  let host = endpoint.host;
  if (host === "0.0.0.0" || host === "::" || host === "[::]") {
    host = "localhost";
  } else if (host.includes(":") && !host.startsWith("[")) {
    host = `[${host}]`;
  }
  return `${endpoint.protocol}://${host}:${endpoint.port}`;
}

export type DiscoveryResult =
  | { status: "found"; backend: DiscoveredBackend }
  | { status: "not-found" }
  /** A dev.json exists but its writer is dead (orphan from a crash) */
  | { status: "stale"; projectDir: string; pid: number }
  /** A live dev.json exists but declares no api endpoint */
  | { status: "no-api-endpoint"; projectDir: string }
  /** A dev.json exists but cannot be parsed against the contract */
  | { status: "malformed"; projectDir: string };

/**
 * Walk up from `cwd` to the filesystem root looking for an antelope
 * project that has a live dev registry. The first directory containing
 * `.antelope/dev.json` decides the outcome: a live registry with an api
 * endpoint wins; a stale, endpoint-less or unparseable one is reported
 * as such so the caller can print an actionable error (we deliberately
 * do NOT keep walking up past it — in a nested-projects setup, silently
 * falling through to a parent project's backend would connect the wrong
 * one for this cwd).
 */
export function discoverBackend(
  cwd: string,
  options: DiscoveryOptions = {},
): DiscoveryResult {
  const alive = options.isPidAlive ?? isPidAlive;

  let dir = resolve(cwd);
  while (true) {
    const file = join(dir, DEV_REGISTRY_RELATIVE_PATH);
    if (existsSync(file)) {
      const registry = parseRegistry(file);
      if (!registry) {
        return { status: "malformed", projectDir: dir };
      }
      if (!alive(registry.pid)) {
        return { status: "stale", projectDir: dir, pid: registry.pid };
      }
      const endpoint = registry.servers.api?.endpoints?.[0];
      if (!endpoint) {
        return { status: "no-api-endpoint", projectDir: dir };
      }
      return {
        status: "found",
        backend: {
          projectDir: dir,
          registry,
          backendUrl: buildBackendUrl(endpoint),
        },
      };
    }

    const parent = dirname(dir);
    if (parent === dir) return { status: "not-found" };
    dir = parent;
  }
}

/**
 * Human-readable explanation for every non-`found` outcome, shared by the
 * commands so the error reads the same everywhere.
 */
export function describeDiscoveryFailure(result: DiscoveryResult): string {
  switch (result.status) {
    case "not-found":
      return (
        "No backend URL provided and no running antelope project found.\n" +
        `  Searched for ${DEV_REGISTRY_RELATIVE_PATH} from the current directory upward.\n` +
        "  Either run this command inside an antelope project started with 'ajs project dev',\n" +
        "  or pass the backend explicitly with -b <url> (env: DMS_API_BASE_URL)."
      );
    case "stale":
      return (
        `Found ${join(result.projectDir, DEV_REGISTRY_RELATIVE_PATH)} but its process (pid ${result.pid}) is no longer running.\n` +
        "  Start the backend with 'ajs project dev', or pass -b <url> explicitly."
      );
    case "no-api-endpoint":
      return (
        `Found a running antelope project at ${result.projectDir} but it exposes no 'api' server endpoint.\n` +
        "  Make sure the api module is loaded, or pass -b <url> explicitly."
      );
    case "malformed":
      return (
        `Found ${join(result.projectDir, DEV_REGISTRY_RELATIVE_PATH)} but could not parse it.\n` +
        "  Restart the backend with 'ajs project dev' to rewrite it, or pass -b <url> explicitly."
      );
    case "found":
      return "";
  }
}

// ============================================================================
// Bootstrap credential handshake via .antelope/dms-dev.json
// ============================================================================

/**
 * Shared contract with the DMS backend: a development instance writes its
 * bootstrap credential next to the dev registry so a build tool on the same
 * machine authenticates without anyone configuring a secret. A sibling file
 * rather than a key in `dev.json` because the antelope core owns that one and
 * rewrites it wholesale.
 *
 * Validated by `pid` for the same reason as the registry: a crashed backend
 * leaves an orphan whose secret no live instance would accept.
 */
export interface DevHandshake {
  pid: number;
  bootstrapSecret: string;
  updatedAt?: string;
}

export const DEV_HANDSHAKE_RELATIVE_PATH = join(".antelope", "dms-dev.json");

function parseHandshake(file: string): DevHandshake | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (
      typeof parsed?.pid !== "number" ||
      typeof parsed?.bootstrapSecret !== "string" ||
      !parsed.bootstrapSecret
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * Read the credential a development backend published for `projectDir`.
 *
 * @param projectDir Antelope project root
 * @param options Injectable pid probe, for tests
 * @returns The credential, or undefined when absent, malformed or orphaned
 */
export function readDevBootstrapCredential(
  projectDir: string,
  options: DiscoveryOptions = {},
): string | undefined {
  const alive = options.isPidAlive ?? isPidAlive;
  const file = join(projectDir, DEV_HANDSHAKE_RELATIVE_PATH);
  if (!existsSync(file)) return undefined;
  const handshake = parseHandshake(file);
  if (!handshake || !alive(handshake.pid)) return undefined;
  return handshake.bootstrapSecret;
}

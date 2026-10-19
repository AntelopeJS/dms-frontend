// Following the backend's set of frontend modules while a server runs: the
// module store of the DMS installs and removes modules on a live backend, and
// the frontend has to rebuild its workspace to serve them. The server also
// tells the backend which modules it serves once it is ready, which is how
// the Modules page knows when to reload.

import { backendEndpoint, fetchManifest } from "./manifest";
import { bootstrapHeaders, type ManifestModule } from "./workspace";

/** How often `dev` reads the manifest to notice a module set change. */
export const MODULE_SET_POLL_INTERVAL_MS = 3000;
const READY_ENDPOINT = "/dms/frontend/ready";
const READY_TIMEOUT_MS = 5000;
const JSON_CONTENT_TYPE = "application/json";
const OWN_RELEASE: { version: string } = require("../package.json");

/** What a module set is compared on. */
export type ModuleSetMember = Pick<
  ManifestModule,
  "name" | "path" | "priority" | "publicEndpoints" | "backendProxies"
>;

/**
 * The bootstrap credential, read again on each poll: a development backend
 * issues a new one each time it restarts.
 */
export type BootstrapSecretSource = () => string | undefined;

export interface ModuleSetFollowOptions {
  backendUrl: string;
  clientUrl?: string;
  bootstrapSecret?: BootstrapSecretSource;
  /** The fingerprint of the set the running workspace was built from. */
  fingerprint: string;
  /** Called once the backend serves another set, on two reads in a row. */
  onChange: () => void;
  /**
   * Called after each read that finds the set unchanged: `dev` reports what
   * it serves again, so a backend that restarted, and lost the report it
   * had, learns it within one interval.
   */
  onUnchanged?: () => void;
  intervalMs?: number;
}

/**
 * A stable identity of a module set: which modules, from which sources, in
 * which order, and the backend routes each one has the server let through
 * (`publicEndpoints`, `backendProxies`), which the generated server reads
 * once, when it starts. Option values are left out on purpose: they change
 * with the client origin on every dev run and are applied without a rebuild.
 */
export function moduleSetFingerprint(
  modules: readonly ModuleSetMember[],
): string {
  return JSON.stringify(
    [...modules]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((module) => [
        module.name,
        module.path ?? "",
        module.priority,
        module.publicEndpoints ?? [],
        module.backendProxies ?? [],
      ]),
  );
}

/**
 * Reads the manifest every few seconds and calls `onChange` once the backend
 * serves a different module set, the same on two reads in a row: updating a
 * module takes its layer down and puts it back a few seconds later, and the
 * workspace is rebuilt once for the result, not for the step in between. A
 * manifest the backend marks as settling, and a failed read (a backend
 * restarting), are skipped: the next one decides.
 *
 * @returns A function that stops following
 */
export function followModuleSet(options: ModuleSetFollowOptions): () => void {
  let isStopped = false;
  let timer: NodeJS.Timeout | undefined;
  let candidate: string | undefined;
  const inspect = (fingerprint: string) => {
    if (fingerprint === options.fingerprint) {
      candidate = undefined;
      options.onUnchanged?.();
      return;
    }
    if (fingerprint !== candidate) {
      candidate = fingerprint;
      return;
    }
    isStopped = true;
    options.onChange();
  };
  const poll = async () => {
    try {
      const manifest = await fetchManifest(
        options.backendUrl,
        options.clientUrl,
        options.bootstrapSecret?.(),
      );
      if (!isStopped && !manifest.settling) {
        inspect(moduleSetFingerprint(manifest.modules));
      }
    } catch {
      // The backend is restarting or briefly unreachable.
    }
    if (!isStopped) schedule();
  };
  const schedule = () => {
    timer = setTimeout(
      () => void poll(),
      options.intervalMs ?? MODULE_SET_POLL_INTERVAL_MS,
    );
    timer.unref();
  };
  schedule();
  return () => {
    isStopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Tells the backend which frontend modules the server that just became ready
 * serves, and which dms-frontend version runs it: the module store checks a
 * module version's supported dms-frontend range against it. Best effort: a
 * backend that predates the endpoint answers 404, one that predates the
 * version ignores it, and nothing in the frontend depends on the answer.
 *
 * @returns Whether the backend took the report
 */
export async function reportFrontendReady(
  backendUrl: string,
  moduleNames: readonly string[],
  bootstrapSecret?: string,
): Promise<boolean> {
  try {
    const response = await fetch(backendEndpoint(backendUrl, READY_ENDPOINT), {
      method: "POST",
      headers: {
        ...bootstrapHeaders(bootstrapSecret),
        "content-type": JSON_CONTENT_TYPE,
      },
      body: JSON.stringify({
        modules: moduleNames,
        version: OWN_RELEASE.version,
      }),
      signal: AbortSignal.timeout(READY_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** How long `start` waits for the manifest it compares its build with. */
const DRIFT_CHECK_TIMEOUT_MS = 10_000;

/** How a build compares with the module set its backend serves now. */
export type BuildDrift =
  | { status: "matches"; served: string }
  | { status: "drifted"; served: string }
  | { status: "unknown"; reason: string };

/**
 * Compares the module set a build was made from with the one the backend
 * serves now, once, after the server is ready: a snapshot kept with the
 * project ages as the backend's modules change. Never retried and never
 * awaited by the server, so a backend that sleeps or is down delays nothing.
 *
 * @param backendUrl Backend the server proxies to
 * @param builtDigest `manifestDigest` of the build's modules
 * @param digestOf Digest of a served manifest's modules
 * @param bootstrapSecret Credential for the manifest, when the server has one
 */
export async function compareWithBackend(
  backendUrl: string,
  builtDigest: string,
  digestOf: (modules: readonly ManifestModule[]) => string,
  bootstrapSecret?: string,
): Promise<BuildDrift> {
  try {
    const manifest = await Promise.race([
      fetchManifest(backendUrl, undefined, bootstrapSecret),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("the backend did not answer in time")),
          DRIFT_CHECK_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
    const served = digestOf(manifest.modules);
    return { status: served === builtDigest ? "matches" : "drifted", served };
  } catch (error) {
    return {
      status: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

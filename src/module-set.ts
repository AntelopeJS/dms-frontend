// Following the backend's set of frontend modules while a server runs: the
// module store of the DMS installs and removes modules on a live backend, and
// the frontend has to rebuild its workspace to serve them. The server also
// tells the backend which modules it serves once it is ready, which is how
// the Modules page knows when to reload.

import { setTimeout as sleep } from "node:timers/promises";
import { backendEndpoint, fetchManifest } from "./manifest";
import { bootstrapHeaders, type ManifestModule } from "./workspace";

/** How often `dev` reads the manifest to notice a module set change. */
export const MODULE_SET_POLL_INTERVAL_MS = 3000;
const READY_ENDPOINT = "/dms/frontend/ready";
const READY_TIMEOUT_MS = 5000;
const JSON_CONTENT_TYPE = "application/json";
/** The dms-frontend release reporting, as the ready report names it. */
export const OWN_RELEASE: { version: string } = require("../package.json");

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
    } catch {}
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

/** A frontend module a server serves, and the package version it ships in. */
export interface ServedModule {
  name: string;
  version?: string;
}

/**
 * How long one report may take: longer than a platform holds a request while
 * it wakes the backend (60 s), so a held report is not cut short.
 */
const READY_WAKE_TIMEOUT_MS = 90_000;
/** The first pause before reporting again to a backend that did not answer. */
const READY_FIRST_RETRY_MS = 2_000;
/** The longest pause between two reports to a backend that does not answer. */
const READY_MAX_RETRY_MS = 60_000;
const SERVER_ERROR = 500;

/** Pauses between reports to a backend that does not answer yet. */
export interface ReadyRetry {
  firstDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
}

const DEFAULT_READY_RETRY: ReadyRetry = {
  firstDelayMs: READY_FIRST_RETRY_MS,
  maxDelayMs: READY_MAX_RETRY_MS,
  timeoutMs: READY_WAKE_TIMEOUT_MS,
};

/** Posts the ready report; rejects when the backend does not answer. */
async function postReadyReport(
  backendUrl: string,
  modules: readonly ServedModule[],
  bootstrapSecret: string | undefined,
  timeoutMs: number,
): Promise<Response> {
  const response = await fetch(backendEndpoint(backendUrl, READY_ENDPOINT), {
    method: "POST",
    headers: {
      ...bootstrapHeaders(bootstrapSecret),
      "content-type": JSON_CONTENT_TYPE,
    },
    body: JSON.stringify({ modules, version: OWN_RELEASE.version }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.body?.cancel();
  return response;
}

/**
 * Tells the backend which frontend modules, at which versions, the server
 * that just became ready serves, and which dms-frontend version runs it: the
 * backend warns when its own module versions differ, and the module store
 * checks a module version's supported dms-frontend range. Best effort:
 * nothing in the frontend depends on the answer.
 *
 * @returns Whether the backend took the report
 */
export async function reportFrontendReady(
  backendUrl: string,
  modules: readonly ServedModule[],
  bootstrapSecret?: string,
): Promise<boolean> {
  try {
    const response = await postReadyReport(
      backendUrl,
      modules,
      bootstrapSecret,
      READY_TIMEOUT_MS,
    );
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * {@link reportFrontendReady}, once the backend first answers: on a platform
 * that wakes the backend with the frontend, that is after the server is
 * ready. Reports again, with a growing pause, while the backend is asleep,
 * starting (a 5xx) or out of reach, on timers that never keep the process
 * alive; any other answer ends it. Never awaited by the server.
 *
 * @param retry Pauses between reports, for tests
 * @returns Whether the backend took the report
 */
export async function reportFrontendReadyOnceAnswered(
  backendUrl: string,
  modules: readonly ServedModule[],
  bootstrapSecret?: string,
  retry: ReadyRetry = DEFAULT_READY_RETRY,
): Promise<boolean> {
  for (let delayMs = retry.firstDelayMs; ;) {
    try {
      const response = await postReadyReport(
        backendUrl,
        modules,
        bootstrapSecret,
        retry.timeoutMs,
      );
      if (response.status < SERVER_ERROR) return response.ok;
    } catch {}
    await sleep(delayMs, undefined, { ref: false });
    delayMs = Math.min(retry.maxDelayMs, delayMs * 2);
  }
}

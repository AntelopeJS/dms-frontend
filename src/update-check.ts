// Daily "a newer release exists" notice for the `ajs-dms` executable.
//
// Every invocation goes through here, so the check is written to be
// invisible when it cannot help: it never blocks the command, never throws,
// and never writes to stdout, which callers pipe into other tools.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ClientRequest, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import semver from "semver";
import { DMS_FRONTEND_HOME } from "./config";

export const UPDATE_CHECK_PACKAGE = "@antelopejs/dms-frontend";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

/** One notice a day is a reminder; one an hour is noise. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Wall-clock deadline for the whole round trip, not an inactivity timeout:
 * the registry answers in milliseconds when it answers at all, and a captive
 * portal that dribbles bytes forever would satisfy any per-socket timer.
 */
export const UPDATE_CHECK_TIMEOUT_MS = 3000;

/**
 * Opt-out flag. Registered on the root command for `--help` only; it is
 * stripped from argv before Commander parses, because a root option would
 * otherwise be rejected once it appears after the subcommand name.
 */
export const NO_UPDATE_CHECK_FLAG = "--no-update-check";

const HELP_OR_VERSION_FLAGS = ["--help", "-h", "--version", "-v"];

/**
 * Options whose value is the next argv token. A flag spelled in that
 * position is an operand, not a flag: `-b --no-update-check` asks for a
 * backend URL spelled `--no-update-check`, and swallowing it here would
 * change what Commander reports.
 */
const VALUE_TAKING_OPTIONS = [
  "-b",
  "--backend-url",
  "-p",
  "--port",
  "--bootstrap-secret",
  "-l",
  "--layer",
  "-m",
  "--module",
  "--local-package",
];

interface UpdateCheckCache {
  checkedAt: number;
  /** Absent until a lookup succeeds; a failed attempt still stamps the time. */
  latestVersion?: string;
}

export interface UpdateCheckOptions {
  /** Version of the running executable. */
  currentVersion: string;
  /** Arguments after the node executable and script path. */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  cacheFile?: string;
  /** Resolves to the registry's `latest` version, or undefined on any failure. */
  fetchLatestVersion?: (packageName: string) => Promise<string | undefined>;
  /** Sink for the notice; stderr in production. */
  write?: (message: string) => void;
}

/**
 * Positions in `argv` where one of `flags` is used as a flag.
 *
 * Two things disqualify a matching token: everything after a bare `--` is an
 * operand by POSIX convention, and a token sitting where a value-taking
 * option expects its value belongs to that option.
 */
function flagIndexes(
  argv: readonly string[],
  flags: readonly string[],
): number[] {
  const terminator = argv.indexOf("--");
  const end = terminator === -1 ? argv.length : terminator;
  const found: number[] = [];
  for (let index = 0; index < end; index++) {
    if (!flags.includes(argv[index])) continue;
    if (VALUE_TAKING_OPTIONS.includes(argv[index - 1] ?? "")) continue;
    found.push(index);
  }
  return found;
}

/**
 * Remove the opt-out flag from an argument list.
 *
 * Commander rejects unknown options, and registering `--no-update-check` on
 * the root command would only accept it before the subcommand name. Since
 * the flag is read straight from argv, dropping it here lets it appear
 * anywhere on the command line — but only where it is really a flag.
 */
export function stripUpdateCheckFlag(argv: readonly string[]): string[] {
  const dropped = new Set(flagIndexes(argv, [NO_UPDATE_CHECK_FLAG]));
  return argv.filter((_, index) => !dropped.has(index));
}

/**
 * Decide whether this invocation may check the registry.
 *
 * `--help` and `--version` answer from the binary itself and are the two
 * commands a script is most likely to parse, so they stay silent. `CI` and
 * `NO_UPDATE_NOTIFIER` are the two conventional environment opt-outs.
 */
export function isUpdateCheckEnabled(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (env.CI) return false;
  if (env.NO_UPDATE_NOTIFIER) return false;
  if (argv[0] === "help") return false;
  if (flagIndexes(argv, [NO_UPDATE_CHECK_FLAG]).length) return false;
  return flagIndexes(argv, HELP_OR_VERSION_FLAGS).length === 0;
}

/**
 * Where the last check is remembered: next to the generated workspaces, in
 * the loader's own AntelopeJS home.
 */
export function updateCheckCacheFile(): string {
  return join(DMS_FRONTEND_HOME, "update-check.json");
}

function readCache(file: string): UpdateCheckCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    if (typeof parsed?.checkedAt !== "number") return undefined;
    const latestVersion = parsed.latestVersion;
    if (latestVersion !== undefined && typeof latestVersion !== "string") {
      return undefined;
    }
    return { checkedAt: parsed.checkedAt, latestVersion };
  } catch {
    return undefined;
  }
}

function writeCache(file: string, cache: UpdateCheckCache): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(cache)}\n`);
  } catch {
    // A read-only or full cache directory only costs us the throttle.
  }
}

/**
 * Ask a registry for a package's `latest` dist-tag.
 *
 * Uses `node:http(s)` rather than `fetch` for the socket: an unref'd socket
 * cannot hold the event loop open, so a short command (`clean`, a failed
 * `build`) exits at its usual speed and simply skips the notice.
 *
 * @param packageName Scoped package to look up
 * @param registryUrl Registry origin; overridden by tests
 * @param timeoutMs Deadline for the whole exchange; overridden by tests
 * @returns The published version, or undefined for any failure at all
 */
export function fetchLatestVersionFromRegistry(
  packageName: string,
  registryUrl: string = DEFAULT_REGISTRY_URL,
  timeoutMs: number = UPDATE_CHECK_TIMEOUT_MS,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let request: ClientRequest | undefined;
    let deadline: NodeJS.Timeout | undefined;
    let settled = false;
    const settle = (version?: string) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(version);
    };

    try {
      const url = new URL(
        `${packageName.replace("/", "%2f")}/latest`,
        registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`,
      );
      const get = url.protocol === "http:" ? httpGet : httpsGet;
      request = get(
        url,
        // The abbreviated packument media type is rejected by the `/latest`
        // endpoint with a 406, which would make this silently never fire.
        { headers: { accept: "application/json" } },
        (response) => {
          // Anything but a 200 is "no answer", 3xx included: this endpoint
          // does not redirect, and chasing one would mean a second deadline
          // and an open redirect to validate for a cosmetic notice.
          if (response.statusCode !== 200) {
            response.resume();
            settle();
            return;
          }
          response.setEncoding("utf-8");
          let body = "";
          response.on("data", (chunk: string) => {
            body += chunk;
          });
          response.on("end", () => {
            try {
              const version = JSON.parse(body)?.version;
              settle(typeof version === "string" ? version : undefined);
            } catch {
              settle();
            }
          });
          response.on("error", () => settle());
        },
      );
      request.on("socket", (socket) => socket.unref());
      request.on("error", () => settle());

      // Unref'd like the socket: the deadline exists to give up, never to
      // keep a command alive waiting for one.
      deadline = setTimeout(() => {
        request?.destroy();
        settle();
      }, timeoutMs);
      deadline.unref();
    } catch {
      settle();
    }
  });
}

function formatNotice(currentVersion: string, latestVersion: string): string {
  return (
    `A newer DMS frontend version is available: ${currentVersion} -> ${latestVersion}. ` +
    "Run `ajs update dms` to update.\n"
  );
}

function isNewer(currentVersion: string, latestVersion: string): boolean {
  const current = semver.valid(currentVersion);
  const latest = semver.valid(latestVersion);
  if (!current || !latest) return false;
  return semver.lt(current, latest);
}

/**
 * Notify about a newer release, at most one registry round-trip a day.
 *
 * The cached version still produces a notice inside the interval: the
 * throttle is on the network call, not on the reminder. A failed lookup
 * stamps the cache too, so a machine that is offline, throttled or behind a
 * broken proxy pays for one attempt a day rather than one per command; it
 * keeps whatever version the last successful lookup found.
 *
 * @param options Injection points for the clock, the registry and the sink
 * @returns A promise that settles once the check is done; production callers
 *   drop it, tests await it
 */
export async function checkForUpdate(
  options: UpdateCheckOptions,
): Promise<void> {
  try {
    const {
      currentVersion,
      argv = process.argv.slice(2),
      env = process.env,
      now = Date.now,
      cacheFile = updateCheckCacheFile(),
      fetchLatestVersion = fetchLatestVersionFromRegistry,
      write = (message: string) => process.stderr.write(message),
    } = options;

    if (!isUpdateCheckEnabled(argv, env)) return;

    const cached = readCache(cacheFile);
    const checkedAt = now();
    const withinInterval =
      cached !== undefined &&
      checkedAt - cached.checkedAt < UPDATE_CHECK_INTERVAL_MS;

    let latestVersion = cached?.latestVersion;
    if (!withinInterval) {
      latestVersion =
        (await fetchLatestVersion(UPDATE_CHECK_PACKAGE)) ?? latestVersion;
      writeCache(cacheFile, { checkedAt, latestVersion });
    }

    if (latestVersion && isNewer(currentVersion, latestVersion)) {
      write(formatNotice(currentVersion, latestVersion));
    }
  } catch {
    // A version notice is never worth failing a command over.
  }
}

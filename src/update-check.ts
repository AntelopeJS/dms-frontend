// Daily "a newer release exists" notice for the `ajs-dms` executable.
//
// Every invocation goes through here, so the check is written to be
// invisible when it cannot help: it never blocks the command, never throws,
// and only speaks to a terminal, on stderr, once the command is done.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type ClientRequest, get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { dirname, join } from "node:path";
import { getProcessUi, isQuietRun, type Ui } from "@antelopejs/core/cli";
import { DMS_FRONTEND_HOME } from "./config";
import {
  feedbackColumns,
  isTerminalFeedback,
  wrapAfter,
  writeFeedback,
} from "./output";

export const UPDATE_CHECK_PACKAGE = "@antelopejs/dms-frontend";

const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org/";

const UPDATE_COMMAND = "ajs update dms";

const DUMB_TERMINAL = "dumb";

/** One notice a day is a reminder; one an hour is noise. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Retry delay after a lookup that came back empty.
 *
 * A failure is not the same event as a success and must not buy the same
 * silence. A flaky network or a registry hiccup says nothing about the next
 * attempt, and charging a full day of silence for one would hide the notice
 * for the rest of the day. The command the check rides along with no longer
 * blocks the event loop while it works — `pnpm install` and the production
 * build run as asynchronous children — so the deadline below measures the
 * registry, not the command.
 */
export const UPDATE_CHECK_RETRY_INTERVAL_MS = 60 * 60 * 1000;

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

/** Flags whose output a script is the most likely to parse. */
const SILENT_FLAGS = ["--help", "-h", "--version", "-v", "--json"];

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
  /** When the last lookup was attempted, whether or not it answered. */
  checkedAt: number;
  /** Absent until a lookup succeeds; a failed attempt still stamps the time. */
  latestVersion?: string;
  /**
   * Whether the attempt at `checkedAt` answered, which picks the interval
   * before the next one. Absent in caches written before this field existed;
   * `latestVersion` is the fallback tell, and gets the one case that matters
   * right — a cache holding nothing but a timestamp is a failed first lookup.
   */
  succeeded?: boolean;
}

export interface UpdateCheckOptions {
  /** Version of the running executable. */
  currentVersion: string;
  /** Arguments after the node executable and script path. */
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Whether stderr is a terminal a person reads; the notice is only for one. */
  isTerminal?: boolean;
  now?: () => number;
  cacheFile?: string;
  /** Resolves to the registry's `latest` version, or undefined on any failure. */
  fetchLatestVersion?: (packageName: string) => Promise<string | undefined>;
  /** Symbols and colors of the notice; the process's own in production. */
  ui?: Ui;
  /** Sink for each line of the notice; stderr, above any running task, in production. */
  write?: (line: string) => void;
  /** The width the notice wraps to; the terminal's in production. */
  columns?: number;
}

export interface UpdateNoticeOptions {
  /**
   * Whether more output follows the notice, as a running server's does after
   * its ready block: the notice is then set apart from what follows it
   * rather than from what precedes it.
   */
  isFollowed?: boolean;
}

export interface UpdateCheck {
  /** Settles once the lookup is over; at once when the cache answered. */
  readonly completion: Promise<void>;
  /**
   * Print the notice when a newer release is known by now, once per check.
   * It never waits for the lookup: a command that finishes first ends at its
   * usual speed and leaves the answer to a later run.
   */
  report(options?: UpdateNoticeOptions): Promise<void>;
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
 * `--help` and `--version` answer from the binary itself, and they and
 * `--json` are what a script is most likely to parse, so they stay silent.
 * `CI` and `NO_UPDATE_NOTIFIER` are the two conventional environment
 * opt-outs, a dumb terminal is one nobody reads a notice on, and a quiet run
 * asked for nothing but results, warnings and errors.
 */
export function isUpdateCheckEnabled(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): boolean {
  if (env.CI) return false;
  if (isQuietRun({ argv: [...argv], env })) return false;
  if (env.NO_UPDATE_NOTIFIER) return false;
  if (env.TERM === DUMB_TERMINAL) return false;
  if (argv[0] === "help") return false;
  if (flagIndexes(argv, [NO_UPDATE_CHECK_FLAG]).length) return false;
  return flagIndexes(argv, SILENT_FLAGS).length === 0;
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
    const succeeded = parsed.succeeded;
    if (succeeded !== undefined && typeof succeeded !== "boolean") {
      return undefined;
    }
    return { checkedAt: parsed.checkedAt, latestVersion, succeeded };
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

/** `ℹ ajs dms 0.3.8 is available (you have 0.3.7) → ajs update dms`. */
function formatNotice(
  currentVersion: string,
  latestVersion: string,
  ui: Ui,
  columns: number | undefined,
): string[] {
  const palette = ui.palette("feedback");
  const { info, hint } = ui.symbols.levels;
  return wrapAfter(
    `${palette.blue(info)} `,
    `ajs dms ${latestVersion} is available (you have ${currentVersion}) ` +
      palette.cyan(`${hint} ${UPDATE_COMMAND}`),
    columns,
  );
}

/** Loads semver only when there is a version to compare, rarely. */
async function isNewer(
  currentVersion: string,
  latestVersion: string,
): Promise<boolean> {
  if (currentVersion === latestVersion) return false;
  const { lt, valid } = await import("semver");
  const current = valid(currentVersion);
  const latest = valid(latestVersion);
  if (!current || !latest) return false;
  return lt(current, latest);
}

/**
 * Start the check for a newer release, at most one registry round-trip a
 * day, before the command runs: the lookup then has the whole command to
 * answer in, a `pnpm install` or a build included.
 *
 * The cached version still produces a notice inside the interval: the
 * throttle is on the network call, not on the reminder. A failed lookup
 * stamps the cache too, so a machine that is offline, throttled or behind a
 * broken proxy pays for one attempt per hour rather than one per command; it
 * keeps whatever version the last successful lookup found. That shorter
 * `UPDATE_CHECK_RETRY_INTERVAL_MS` is the whole point of remembering whether
 * the last attempt answered: a lookup lost to a busy event loop or a dropped
 * connection otherwise costs a full day of silence.
 *
 * @param options Injection points for the clock, the registry and the output
 * @returns The running check, or undefined when this invocation stays silent
 */
export function startUpdateCheck(
  options: UpdateCheckOptions,
): UpdateCheck | undefined {
  try {
    const {
      currentVersion,
      argv = process.argv.slice(2),
      env = process.env,
      isTerminal = isTerminalFeedback(),
      now = Date.now,
      cacheFile = updateCheckCacheFile(),
      fetchLatestVersion = fetchLatestVersionFromRegistry,
      ui = getProcessUi(),
      write = writeFeedback,
      columns = feedbackColumns(),
    } = options;

    if (!isTerminal || !isUpdateCheckEnabled(argv, env)) return undefined;

    const cached = readCache(cacheFile);
    const checkedAt = now();
    const lastAttemptAnswered =
      cached?.succeeded ?? cached?.latestVersion !== undefined;
    const interval = lastAttemptAnswered
      ? UPDATE_CHECK_INTERVAL_MS
      : UPDATE_CHECK_RETRY_INTERVAL_MS;
    const withinInterval =
      cached !== undefined && checkedAt - cached.checkedAt < interval;

    let latestVersion = cached?.latestVersion;
    const completion = withinInterval
      ? Promise.resolve()
      : fetchLatestVersion(UPDATE_CHECK_PACKAGE).then(
          (published) => {
            latestVersion = published ?? latestVersion;
            writeCache(cacheFile, {
              checkedAt,
              latestVersion,
              succeeded: published !== undefined,
            });
          },
          () => {
            // A version notice is never worth failing a command over.
          },
        );

    let isReported = false;
    const report = async (placement: UpdateNoticeOptions = {}) => {
      if (isReported) return;
      isReported = true;
      const known = latestVersion;
      if (!known || !(await isNewer(currentVersion, known))) return;
      const lines = formatNotice(currentVersion, known, ui, columns);
      for (const text of placement.isFollowed
        ? [...lines, ""]
        : ["", ...lines]) {
        write(text);
      }
    };
    return {
      completion,
      report: (placement) => report(placement).catch(() => undefined),
    };
  } catch {
    // A version notice is never worth failing a command over.
    return undefined;
  }
}

let processUpdateCheck: UpdateCheck | undefined;

/** Start the process's own check; see `startUpdateCheck`. */
export function startProcessUpdateCheck(options: UpdateCheckOptions): void {
  processUpdateCheck = startUpdateCheck(options);
}

/**
 * Print the process's notice, at most once: as the last lines of a command
 * that succeeded, or under the ready block of a server that keeps running.
 */
export async function reportAvailableUpdate(
  options?: UpdateNoticeOptions,
): Promise<void> {
  await processUpdateCheck?.report(options);
}

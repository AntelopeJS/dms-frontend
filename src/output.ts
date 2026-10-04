// What the CLI says around the core output module: the line a command opens
// with, paths and dates as the user reads them, and the line a stopped run
// ends on.

import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  CliError,
  type CliProblem,
  detectCapabilities,
  displayPath,
  getProcessTasks,
  getProcessUi,
  isVerboseRun,
  processCapabilityContext,
  SYMBOL_SETS,
  type Ui,
} from "@antelopejs/core/cli";

const HOME_PREFIX = "~";
const CURRENT_DIRECTORY = ".";
const WORKSPACE_ID_LENGTH = 8;
const ELLIPSIS = "…";
const CONTEXT_SEPARATOR = " · ";
const LINE_BREAK = /\r?\n/;
const STOPPED_SYMBOLS = { unicode: "■", ascii: "x" };

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

function isTerminalFeedback(): boolean {
  return detectCapabilities(processCapabilityContext()).terminals.feedback;
}

/** Writes a raw line of feedback above the running tasks. */
function writeFeedback(line: string): void {
  getProcessTasks().write(process.stderr, `${line}\n`);
}

/**
 * Opens a task command with one line saying what it runs against:
 * `ajs dms build  http://localhost:5010 · production`.
 */
export function writeHeader(
  command: string,
  context: string[],
  ui: Ui = getProcessUi(),
): void {
  const title = ui.palette().bold(`ajs dms ${command}`);
  writeFeedback(`${title}  ${context.join(CONTEXT_SEPARATOR)}`);
}

/** Separates the CLI's own lines from the output of the child it starts. */
export function writeBlankLine(): void {
  writeFeedback("");
}

/**
 * A path as the user reads it: relative to the working directory when it lies
 * inside it, from `~` when it lies in the home directory, unchanged otherwise.
 */
export function showPath(target: string, home: string = homedir()): string {
  if (resolve(target) === process.cwd()) return CURRENT_DIRECTORY;
  const shown = displayPath(target);
  if (shown !== target) return shown;
  const fromHome = relative(home, target);
  const isInHome =
    fromHome !== "" && !isAbsolute(fromHome) && fromHome.split(sep)[0] !== "..";
  return isInHome ? join(HOME_PREFIX, fromHome) : target;
}

/**
 * A workspace directory as the user reads it. Its name is a 64-character
 * hash, cut to its first characters on a terminal, where a full one wraps;
 * piped output keeps it whole, for scripts and logs.
 */
export function showWorkspace(
  dir: string,
  isTerminal: boolean = isTerminalFeedback(),
  home: string = homedir(),
): string {
  const shown = showPath(dir, home);
  const id = basename(dir);
  if (!isTerminal || id.length <= WORKSPACE_ID_LENGTH) return shown;
  return join(dirname(shown), `${id.slice(0, WORKSPACE_ID_LENGTH)}${ELLIPSIS}`);
}

/** How long ago an ISO date was: `just now`, `5 min ago`, `2 h ago`, `3 days ago`. */
export function formatAge(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  const minutes = Math.floor(Math.max(0, now - time) / MS_PER_MINUTE);
  if (minutes < 1) return "just now";
  if (minutes < MINUTES_PER_HOUR) return `${minutes} min ago`;
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) return `${hours} h ago`;
  const days = Math.floor(hours / HOURS_PER_DAY);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/** ` cached 2 h ago` for a cached manifest, nothing when its date is unknown. */
export function cachedAge(fetchedAt: string | undefined): string {
  return fetchedAt ? ` cached ${formatAge(fetchedAt)}` : "";
}

/**
 * The first line of what went wrong, for a failure reported as a warning
 * rather than through the error boundary.
 */
function describeProblem(error: unknown): CliProblem {
  if (error instanceof CliError) return error.problem;
  const message = error instanceof Error ? error.message : String(error);
  return { title: message.split(LINE_BREAK)[0] };
}

/**
 * The detail lines of a failure that does not stop the command: its reason
 * and fixes, and its stack trace in a verbose run.
 */
export function failureDetails(
  error: unknown,
  ui: Ui = getProcessUi(),
): string[] {
  const { title, reason, fixes = [] } = describeProblem(error);
  const hint = ui.symbols.levels.hint;
  const stack =
    isVerboseRun() && error instanceof Error && !(error instanceof CliError)
      ? (error.stack ?? "").split(LINE_BREAK).slice(1)
      : [];
  return [
    title,
    ...(reason ? [reason] : []),
    ...fixes.map((fix) => `${hint} ${fix}`),
    ...stack.map((line) => line.trim()),
  ];
}

/**
 * Reports a run stopped by a signal. A terminal echoes Ctrl+C as `^C`
 * without a newline, so the line starts on a fresh one there.
 */
export function reportStopped(
  message: string,
  signal: NodeJS.Signals,
  ui: Ui = getProcessUi(),
): void {
  const isUnicode = ui.symbols === SYMBOL_SETS.unicode;
  const symbol = isUnicode ? STOPPED_SYMBOLS.unicode : STOPPED_SYMBOLS.ascii;
  const newline = signal === "SIGINT" && process.stderr.isTTY ? "\n" : "";
  writeFeedback(`${newline}${ui.palette().red(symbol)} ${message}`);
}

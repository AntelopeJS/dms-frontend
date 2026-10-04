// What the CLI says around the core output module: the line a command opens
// with, paths and dates as the user reads them, the block a ready server
// prints, the time-stamped lines of a running one, and the line a stopped run
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
  type ColorName,
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
const LINK_SYMBOLS = { unicode: "➜", ascii: ">" };
const BLOCK_INDENT = "  ";
const LINK_GAP = "  ";
const LABEL_SUFFIX = ":";
const TIME_LENGTH = 8;

const BYTES_PER_UNIT = 1024;
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];
const DECIMAL_SIZE_LIMIT = 10;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/** Whether feedback goes to a terminal, read as it is written. */
export function isTerminalFeedback(): boolean {
  return detectCapabilities(processCapabilityContext()).terminals.feedback;
}

/** Whether results go to a terminal rather than to a pipe or a file. */
export function isTerminalResult(): boolean {
  return detectCapabilities(processCapabilityContext()).terminals.result;
}

/** Writes a raw line of feedback above the running tasks. */
export function writeFeedback(line: string): void {
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

/**
 * The id of a workspace: its hashed directory name, cut to its first
 * characters on a terminal and whole in piped output.
 */
export function workspaceId(dir: string, isTerminal: boolean): string {
  const id = basename(dir);
  return isTerminal ? id.slice(0, WORKSPACE_ID_LENGTH) : id;
}

/** A size in bytes as the user reads it: `512 B`, `1.5 GB`, `498 MB`. */
export function formatSize(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= BYTES_PER_UNIT && unit < SIZE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unit += 1;
  }
  const shown =
    unit > 0 && value < DECIMAL_SIZE_LIMIT
      ? String(Math.round(value * 10) / 10)
      : String(Math.round(value));
  return `${shown} ${SIZE_UNITS[unit]}`;
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
 * The detail lines of a failure that does not stop the command: its reason,
 * fixes and details, and its stack trace in a verbose run.
 */
export function failureDetails(
  error: unknown,
  ui: Ui = getProcessUi(),
): string[] {
  const { title, reason, fixes = [], details = [] } = describeProblem(error);
  const hint = ui.symbols.levels.hint;
  const stack =
    isVerboseRun() && error instanceof Error && !(error instanceof CliError)
      ? (error.stack ?? "").split(LINE_BREAK).slice(1)
      : [];
  return [
    title,
    ...(reason ? [reason] : []),
    ...fixes.map((fix) => `${hint} ${fix}`),
    ...details,
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

/** A line of the ready block: a URL to open, or a setting of the run. */
export interface ReadyLine {
  label: string;
  value: string;
  /** Shown behind an arrow and in color: a URL the user opens. */
  isLink?: boolean;
}

export interface ReadyBlock {
  /** `Dev server ready in 1.5s` */
  title: string;
  lines: ReadyLine[];
  /** The closing line, without a label: `Watching 12 layer sources · Ctrl+C to stop` */
  footer: string;
}

/**
 * The block a server prints once it answers, as Vite does: the URLs to open
 * behind an arrow, then the settings of the run, labels aligned.
 *
 *   ✔ Dev server ready in 1.5s
 *
 *     ➜  Local:     http://localhost:3002/
 *        Backend:   http://127.0.0.1:5010
 */
export function formatReadyBlock(
  block: ReadyBlock,
  ui: Ui = getProcessUi(),
): string[] {
  const palette = ui.palette();
  const isUnicode = ui.symbols === SYMBOL_SETS.unicode;
  const arrow = isUnicode ? LINK_SYMBOLS.unicode : LINK_SYMBOLS.ascii;
  const width = Math.max(
    ...block.lines.map(({ label }) => label.length + LABEL_SUFFIX.length),
  );
  const lead = (isLink?: boolean) =>
    `${BLOCK_INDENT}${isLink ? palette.cyan(arrow) : " ".repeat(arrow.length)}${LINK_GAP}`;
  const lines = block.lines.map(({ label, value, isLink }) => {
    const shownLabel = `${label}${LABEL_SUFFIX}`.padEnd(width);
    const shownValue = isLink ? palette.cyan(value) : value;
    return `${lead(isLink)}${palette.dim(shownLabel)} ${shownValue}`;
  });
  return [
    `${palette.green(ui.symbols.levels.success)} ${block.title}`,
    "",
    ...lines,
    `${lead()}${palette.dim(block.footer)}`,
  ];
}

/** Prints the ready block, set apart from the server output that follows. */
export function writeReadyBlock(
  block: ReadyBlock,
  ui: Ui = getProcessUi(),
): void {
  for (const line of [...formatReadyBlock(block, ui), ""]) writeFeedback(line);
}

/** The levels a running server's notices use, with the color of their symbol. */
const TIMED_LEVEL_COLORS = {
  success: "green",
  info: "blue",
  warn: "yellow",
} as const satisfies Record<string, ColorName>;

type TimedLevel = keyof typeof TIMED_LEVEL_COLORS;

/** `14:03:22`, in local time. */
function clockTime(date: Date): string {
  return date.toTimeString().slice(0, TIME_LENGTH);
}

export interface TimedMessageOptions {
  details?: readonly string[];
  /** What the user does about it, behind the hint arrow. */
  fixes?: readonly string[];
}

/**
 * A notice printed while a server runs, after its ready block, behind the
 * time it happened at, as Vite prints its own: `14:03:22 ▲ <text>`. Details
 * and fixes are indented under the text.
 */
export function formatTimedMessage(
  level: TimedLevel,
  text: string,
  options: TimedMessageOptions = {},
  ui: Ui = getProcessUi(),
  now: Date = new Date(),
): string {
  const { details = [], fixes = [] } = options;
  const palette = ui.palette();
  const paint = palette[TIMED_LEVEL_COLORS[level]];
  const hint = palette.cyan(ui.symbols.levels.hint);
  const indent = " ".repeat(TIME_LENGTH + 1) + BLOCK_INDENT;
  return [
    `${palette.dim(clockTime(now))} ${paint(ui.symbols.levels[level])} ${text}`,
    ...details.map((detail) => `${indent}${palette.dim(detail)}`),
    ...fixes.map((fix) => `${indent}${hint} ${fix}`),
  ].join("\n");
}

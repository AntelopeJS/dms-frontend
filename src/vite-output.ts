// What the CLI makes of the output of a Vite production build: the warnings
// it printed and the error that stopped it.

import { type CliProblem, pluralize, type Ui } from "@antelopejs/core/cli";
import { isTerminalFeedback } from "./output";

/**
 * The level the build runs Vite at, read by the template's Vite configs:
 * warnings and errors only, unless the run is verbose.
 */
export const VITE_LOG_LEVEL_VARIABLE = "DMS_VITE_LOG_LEVEL";

export function viteLogLevel(isVerbose: boolean): string {
  return isVerbose ? "info" : "warn";
}

export const VERBOSE_VITE_HINT = "Run with --verbose for the full Vite output.";

/**
 * Lines that open a warning: Vite's `(!)`, a Rollup plugin's `[plugin x]`,
 * and Node's own `(node:123)` deprecation notices.
 */
const WARNING_START = /^(\(!\)|\[plugin[ :][^\]]*\]|\(node:\d+\))/;
/** A plugin tag alone on its line, whose `(!)` message follows on the next. */
const PLUGIN_TAG_LINE = /^\[plugin[ :][^\]]*\]$/;

/**
 * The warnings of a build run at `logLevel: "warn"`, where everything Vite
 * prints is a warning. One warning spans several lines, so the count follows
 * the lines that open one; output without any such line is one warning.
 */
export class ViteWarnings {
  private readonly kept: string[] = [];
  private opened = 0;
  private isAfterPluginTag = false;

  read(line: string): void {
    const text = line.trim();
    if (text === "") return;
    this.kept.push(line.trimEnd());
    const continuesTag = this.isAfterPluginTag && text.startsWith("(!)");
    if (WARNING_START.test(text) && !continuesTag) this.opened += 1;
    this.isAfterPluginTag = PLUGIN_TAG_LINE.test(text);
  }

  get count(): number {
    if (this.opened === 0 && this.kept.length > 0) return 1;
    return this.opened;
  }

  lines(): string[] {
    return [...this.kept];
  }
}

/**
 * Counts Vite's warnings on a terminal, where the steps are read now, and
 * lists them in full elsewhere, since CI logs are read later. A verbose run
 * has already streamed them.
 */
export function reportViteWarnings(
  warnings: ViteWarnings,
  isVerbose: boolean,
  ui: Ui,
): void {
  if (isVerbose || warnings.count === 0) return;
  const title = pluralize(warnings.count, "Vite warning");
  const details = isTerminalFeedback()
    ? [`${ui.symbols.levels.hint} Run with --verbose to list them`]
    : warnings.lines();
  ui.message("warn", title, { details });
}

const ERROR_START = "error during build:";
const FILE_LINE = /^file:\s+(.+)$/;
const CODE_FRAME_LINE = /^\s*\d*\s*\|/;
const STACK_FRAME = /^\s+at\s/;
const LOCATION_SUFFIX = /\s*\(\d+:\d+\)$/;
/** Vite's own plugin tag, in front of the tag of the tool that failed. */
const VITE_PLUGIN_TAG = /^\[vite:[^\]]+\]\s+(?=\S)/;

/** The lines Vite printed after `error during build:`, up to the stack. */
function errorBlock(lines: string[]): string[] | undefined {
  let start = -1;
  lines.forEach((line, index) => {
    if (line.trim() === ERROR_START) start = index;
  });
  if (start < 0) return undefined;
  const block: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (STACK_FRAME.test(line)) break;
    if (line.trim() !== "") block.push(line.trimEnd());
  }
  return block;
}

/**
 * The error that stopped a Vite build, as one problem: the file and position
 * Vite could not compile, its message and code frame. The stack trace of the
 * compiler stays out; a verbose run has already streamed it.
 *
 * `lines` are the build's output with workspace paths already mapped back to
 * their sources, and `rerun` the command the user runs once the file is
 * fixed. Undefined when Vite did not report the error itself.
 */
export function describeViteFailure(
  lines: string[],
  subject: string,
  isVerbose: boolean,
  rerun = "ajs dms build",
): CliProblem | undefined {
  const block = errorBlock(lines);
  if (!block) return undefined;
  const [message = "", ...rest] = block;
  const reason = message
    .replace(LOCATION_SUFFIX, "")
    .replace(VITE_PLUGIN_TAG, "");
  const hint = isVerbose ? [] : [VERBOSE_VITE_HINT];
  const file = rest
    .map((line) => FILE_LINE.exec(line.trim())?.[1])
    .find((match) => match !== undefined);
  if (file) {
    return {
      title: `Vite could not compile ${file}`,
      reason,
      fixes: [`Fix the file and run ${rerun} again`],
      details: [...rest.filter((line) => CODE_FRAME_LINE.test(line)), ...hint],
    };
  }
  return {
    title: `Vite could not build the ${subject}`,
    reason,
    details: [...rest, ...hint],
  };
}

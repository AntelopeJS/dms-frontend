// What the CLI makes of the output of the children it frames (pnpm install,
// the production build): lines kept for the failure report, paths into the
// generated workspace shown as the frontend-module sources they were copied
// from, and the gutter a verbose run streams them behind.

import { existsSync } from "node:fs";
import {
  type CliProblem,
  detectCapabilities,
  getProcessTasks,
  getProcessUi,
  pluralize,
  processCapabilityContext,
  SYMBOL_SETS,
  type Ui,
} from "@antelopejs/core/cli";
import { getLayerSafeName, getLayerWorkspacePath } from "./layers";
import { showPath, showWorkspace } from "./output";
import type { ResolvedLayer } from "./workspace";

const ESC = "\u001b";
const ANSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const LINE_BREAK = /\r?\n/;
const STACK_FRAME = /^\s+at\s/;
/** Node's deprecation notice for the tool itself, never the cause of a failure. */
const NODE_DEPRECATION_LINES = [
  /^\(node:\d+\) \[DEP\d+\]/,
  /^\(Use `node --trace-/,
];
const GUTTER_BARS = { unicode: "│", ascii: "|" };

/** Lines a framed child keeps in memory: enough for any failure report. */
const KEPT_OUTPUT_LINES = 200;

/** Lines of output a failure report replays. */
const FAILURE_TAIL_LINES = 15;

export const VERBOSE_OUTPUT_HINT = "Run with --verbose for the full output.";

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

/** Cuts a stream into lines, whatever the chunk boundaries. */
export class LineSplitter {
  private pending = "";

  constructor(private readonly onLine: (line: string) => void) {}

  push(chunk: string): void {
    const lines = `${this.pending}${chunk}`.split(LINE_BREAK);
    this.pending = lines.pop() ?? "";
    lines.forEach((line) => this.onLine(line));
  }

  /** Emits the last line when the stream ended without a newline. */
  flush(): void {
    if (this.pending !== "") this.onLine(this.pending);
    this.pending = "";
  }
}

/** The last lines of a child's output, older ones dropped. */
export class OutputTail {
  private readonly kept: string[] = [];

  constructor(private readonly capacity: number = KEPT_OUTPUT_LINES) {}

  push(line: string): void {
    this.kept.push(line);
    if (this.kept.length > this.capacity) this.kept.shift();
  }

  lines(): string[] {
    return [...this.kept];
  }
}

/**
 * The lines a failure report replays: the last non-blank ones, without Node's
 * deprecation notices, nor the stack frames of a crashed tool unless the run
 * is verbose.
 */
export function failureTail(
  lines: string[],
  count: number = FAILURE_TAIL_LINES,
  keepStack = false,
): string[] {
  const shown = lines
    .map((line) => stripAnsi(line).trimEnd())
    .filter((line) => line.trim() !== "")
    .filter(
      (line) => !NODE_DEPRECATION_LINES.some((notice) => notice.test(line)),
    )
    .filter((line) => keepStack || !STACK_FRAME.test(line));
  return shown.slice(Math.max(0, shown.length - count));
}

export interface ChildFailure {
  /** What failed, as the user reads it: `Dependency install failed`. */
  title: string;
  /** The command as the user would type it: `pnpm install`. */
  command: string;
  code: number;
  lines: string[];
  /** The output was streamed as it came, so it is not replayed. */
  isVerbose: boolean;
}

/** A child that exited non-zero: its exit code, then the end of its output. */
export function describeChildFailure(failure: ChildFailure): CliProblem {
  const { title, command, code, lines, isVerbose } = failure;
  if (isVerbose) {
    return {
      title,
      reason: `${command} exited with code ${code}; its output is above.`,
    };
  }
  return {
    title,
    reason: `${command} exited with code ${code}.`,
    details: [...failureTail(lines), VERBOSE_OUTPUT_HINT],
  };
}

// ============================================================================
// Paths
// ============================================================================

export type PathMapper = (line: string) => string;

export interface PathMapperOptions {
  /** How a layer source directory is shown; relative to the cwd by default. */
  showSource?: (path: string) => string;
  /** How the workspace directory itself is shown. */
  shownWorkspace?: string;
  platform?: NodeJS.Platform;
}

interface PathRule {
  pattern: RegExp;
  shown: string;
}

/** Not followed by more of the same file name. */
const PATH_END = "(?![\\w.@-])";
/** Not preceded by more of a path, for workspace-relative paths. */
const RELATIVE_START = "(?<![\\w.@/\\\\-])";
const LAYERS_SUBDIR = "frontend-modules";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matches a path written with either separator. */
function pathPattern(path: string): string {
  return path
    .split(/[\\/]/)
    .map((segment) => escapeRegExp(segment))
    .join("[\\\\/]");
}

/**
 * Where a materialized layer came from, as the user reads it: its source
 * directory when it is on this disk, its package name otherwise (a build from
 * a downloaded archive).
 */
function shownSource(
  layer: ResolvedLayer,
  showSource: (path: string) => string,
): string {
  const source = layer.sourcePath;
  if (source && existsSync(source)) return showSource(source);
  return layer.packageName ?? getLayerSafeName(layer);
}

/**
 * Rewrites every path into the generated workspace so it names the file the
 * user edits: `<workspace>/frontend-modules/<layer>/app/Callout.vue` becomes
 * `frontend-vue/app/Callout.vue`, and any other workspace path is shortened
 * to the workspace as `showWorkspace` prints it.
 */
export function createPathMapper(
  workspaceDir: string,
  layers: ResolvedLayer[],
  options: PathMapperOptions = {},
): PathMapper {
  const {
    showSource = showPath,
    shownWorkspace = showWorkspace(workspaceDir),
    platform = process.platform,
  } = options;
  const flags = platform === "win32" ? "gi" : "g";
  const layerRules = layers
    .filter((layer) => layer.packageName)
    .flatMap((layer) => {
      const shown = shownSource(layer, showSource);
      const copy = pathPattern(getLayerWorkspacePath(workspaceDir, layer));
      const relative = `${RELATIVE_START}${pathPattern(`${LAYERS_SUBDIR}/${getLayerSafeName(layer)}`)}`;
      return [copy, relative].map((pattern) => ({
        pattern: new RegExp(`${pattern}${PATH_END}`, flags),
        shown,
      }));
    });
  const rules: PathRule[] = [
    ...layerRules,
    {
      pattern: new RegExp(`${pathPattern(workspaceDir)}${PATH_END}`, flags),
      shown: shownWorkspace,
    },
  ];
  return (line) =>
    rules.reduce(
      (mapped, { pattern, shown }) => mapped.replace(pattern, () => shown),
      line,
    );
}

// ============================================================================
// Verbose streaming
// ============================================================================

function hasFeedbackColor(): boolean {
  return detectCapabilities(processCapabilityContext()).colors.feedback;
}

/**
 * Writes one line of a child's output above the running tasks, behind a dim
 * gutter naming the child: `pnpm │ Progress: resolved 12, …`.
 */
export function writeChildLine(
  name: string,
  line: string,
  ui: Ui = getProcessUi(),
): void {
  const isUnicode = ui.symbols === SYMBOL_SETS.unicode;
  const bar = isUnicode ? GUTTER_BARS.unicode : GUTTER_BARS.ascii;
  const text = hasFeedbackColor() ? line : stripAnsi(line);
  getProcessTasks().write(
    process.stderr,
    `${ui.palette().dim(`${name} ${bar}`)} ${text}\n`,
  );
}

// ============================================================================
// pnpm install
// ============================================================================

const PROGRESS_LINE =
  /^Progress: resolved (\d+), reused \d+, downloaded \d+, added (\d+)/;
const PACKAGES_LINE = /^Packages: \+(\d+)/;
const UP_TO_DATE_LINE = /^Already up to date/;

/**
 * Follows `pnpm install --reporter=append-only` through its output: the
 * counts its progress lines carry while it runs, and what it did once done.
 */
export class InstallProgress {
  private resolved?: number;
  private added?: number;
  private installed?: number;
  private isUpToDate = false;

  /** Reads one line of output; true when the running label changed. */
  read(line: string): boolean {
    const progress = PROGRESS_LINE.exec(line);
    if (progress) {
      this.resolved = Number(progress[1]);
      this.added = Number(progress[2]);
      return true;
    }
    const packages = PACKAGES_LINE.exec(line);
    if (packages) this.installed = Number(packages[1]);
    if (UP_TO_DATE_LINE.test(line)) this.isUpToDate = true;
    return false;
  }

  get label(): string {
    if (this.resolved === undefined) return "Installing dependencies";
    return `Installing dependencies · ${this.resolved} resolved, ${this.added ?? 0} added`;
  }

  get doneLabel(): string {
    if (this.installed !== undefined)
      return `Installed ${pluralize(this.installed, "package")}`;
    if (this.isUpToDate) return "Dependencies up to date";
    return "Installed the dependencies";
  }
}

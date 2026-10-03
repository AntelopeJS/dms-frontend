// A Ui writing to strings, and the text of a reported problem, for tests that
// check what the CLI says without a terminal.
import { CliError, createUi, type Ui } from "@antelopejs/core/cli";

export interface MemoryUi {
  ui: Ui;
  stdout(): string;
  stderr(): string;
  /** Forgets everything written so far. */
  clear(): void;
}

export interface MemoryUiOptions {
  isColored?: boolean;
  isUnicode?: boolean;
  isTerminal?: boolean;
}

export function memoryUi(options: MemoryUiOptions = {}): MemoryUi {
  const { isColored = false, isUnicode = true, isTerminal = false } = options;
  const written = { result: "", feedback: "" };
  const stream = (channel: keyof typeof written) => ({
    isTTY: isTerminal,
    write: (chunk: string) => {
      written[channel] += chunk;
      return true;
    },
  });
  const ui = createUi({
    streams: { result: stream("result"), feedback: stream("feedback") },
    capabilities: {
      hasUnicode: isUnicode,
      colors: { result: isColored, feedback: isColored },
      terminals: { result: isTerminal, feedback: isTerminal },
    },
  });
  return {
    ui,
    stdout: () => written.result,
    stderr: () => written.feedback,
    clear: () => {
      written.result = "";
      written.feedback = "";
    },
  };
}

/** What the error boundary prints for a `CliError`, without colors. */
export function problemText(error: unknown): string {
  if (!(error instanceof CliError)) {
    throw new Error(`expected a CliError, got ${String(error)}`);
  }
  const output = memoryUi();
  output.ui.problem(error.problem);
  return output.stderr();
}

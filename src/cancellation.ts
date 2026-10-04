// The error a run stopped by a signal ends with, kept apart from the code
// that spawns children so the entry point can catch it without loading them.
import { constants as osConstants } from "node:os";

/** Shell convention for "died from signal N", used when the child never exited on its own. */
export function exitCodeForSignal(signal: NodeJS.Signals): number {
  const number = osConstants.signals[signal];
  return 128 + (typeof number === "number" ? number : 15);
}

/**
 * The CLI received `signal` while a child was running: the child's process
 * tree has been stopped and the run is cancelled, not failed. The exit code
 * follows the shell convention, 130 for Ctrl+C.
 *
 * `stopped` says what was stopped (`Stopped the dev server`) and `context`
 * what follows it (`ran 14m 02s`).
 */
export class CancelledError extends Error {
  readonly exitCode: number;
  /** What was stopped, with the signal unless it was Ctrl+C. */
  readonly stopped: string;
  /** What follows it on the line, when anything does. */
  readonly context: string[];

  constructor(
    readonly signal: NodeJS.Signals,
    stopped = "Stopped",
    context?: string,
  ) {
    const cause = signal === "SIGINT" ? "" : ` (${signal})`;
    const parts = [`${stopped}${cause}`, ...(context ? [context] : [])];
    super(parts.join(" · "));
    this.name = "CancelledError";
    this.exitCode = exitCodeForSignal(signal);
    this.stopped = parts[0];
    this.context = parts.slice(1);
  }
}

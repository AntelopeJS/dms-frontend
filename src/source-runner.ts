import {
  CliError,
  type CliProblem,
  isVerboseRun,
  runWithErrorBoundary,
} from "@antelopejs/core/cli";
import { reapChildrenOnDeath } from "./child-reaper";
import { CancelledError } from "./common";
import { exitOnBrokenPipe, reportStopped } from "./output";

/** What a source runner sends the CLI that started it when it fails. */
export interface FailedRun {
  ok: false;
  problem: CliProblem;
}

const LINE_BREAK = /\r?\n/;
const STACK_TRACE_HINT = "Run with --verbose for the full trace.";

function problemOf(error: Error | string): CliProblem {
  if (error instanceof CliError) return error.problem;
  if (error instanceof Error) {
    const [title] = error.message.split(LINE_BREAK);
    const stack = (error.stack ?? "").split(LINE_BREAK);
    return {
      title: title || error.name,
      details: isVerboseRun() ? stack : [STACK_TRACE_HINT],
    };
  }
  return { title: error };
}

/**
 * Ends a runner whose CLI is gone, SIGKILL included: the IPC channel closes
 * with the CLI, and exiting stops the children `runCommand` started and lets
 * the reaper remove the workspace.
 */
function exitWithoutCli(): void {
  process.exit(1);
}

/**
 * Runs a source runner under the error boundary: `run` on the workspace
 * tools' own Node options, not those the runner was started with.
 * The children it starts die with it, even when it is killed with SIGKILL.
 *
 * Started by a CLI command, the runner sends its result over IPC for the CLI
 * to report, and the CLI reports a stop itself. Run on its own, it reports
 * the result itself.
 */
export function startSourceRunner<Success extends { ok: true }>(
  run: () => Promise<Success | FailedRun>,
  report: (result: Success | FailedRun, durationMs: number) => void,
): void {
  async function main(): Promise<void> {
    exitOnBrokenPipe();
    const startedAt = Date.now();
    delete process.env.NODE_OPTIONS;
    reapChildrenOnDeath();
    process.once("disconnect", exitWithoutCli);
    let result: Success | FailedRun;
    try {
      result = await run();
    } catch (error) {
      if (error instanceof CancelledError) {
        if (!process.send) reportStopped(error);
        process.exitCode = error.exitCode;
        return;
      }
      result = {
        ok: false,
        problem: problemOf(error instanceof Error ? error : String(error)),
      };
    }
    if (process.send) {
      process.exitCode = result.ok ? 0 : 1;
      await new Promise<void>((settle) => {
        process.send?.(result, undefined, undefined, () => settle());
      });
      return;
    }
    report(result, Date.now() - startedAt);
  }
  void runWithErrorBoundary(main, { verbose: isVerboseRun() }).then(() => {
    process.off("disconnect", exitWithoutCli);
    if (process.connected) process.disconnect();
  });
}

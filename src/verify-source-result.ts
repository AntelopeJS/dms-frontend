// What a source verification ends with: the result the runner sends the CLI
// that started it, and the way either of them reports it.

import {
  CliError,
  type CliProblem,
  getProcessUi,
  pluralize,
  type Ui,
} from "@antelopejs/core/cli";
import { writeBlankLine } from "./output";

export type VerificationResult =
  | { ok: true; modules: number }
  | { ok: false; problem: CliProblem };

/** The command a user runs again once a verification failure is fixed. */
export const VERIFY_SOURCE_COMMAND = "ajs dms verify-source";

export const LAYER_PATH_FIX =
  "Pass the root of a DMS frontend package (it contains dms.frontend.ts)";

/**
 * Ends a verification: one summary line when every check passed, otherwise
 * the failure, thrown for the error boundary to report once.
 */
export function reportVerification(
  result: VerificationResult,
  durationMs: number,
  ui: Ui = getProcessUi(),
): void {
  if (!result.ok) throw new CliError(result.problem);
  writeBlankLine();
  ui.summary({
    headline: `Verified ${pluralize(result.modules, "module")}`,
    durationMs,
  });
}

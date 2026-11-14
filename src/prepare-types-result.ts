import { relative } from "node:path";
import {
  CliError,
  type CliProblem,
  getProcessUi,
  pluralize,
  type Ui,
} from "@antelopejs/core/cli";
import { toPosixPath } from "./fs-sync";
import { showPath, writeBlankLine } from "./output";

/** What a type preparation ends with: the result the runner sends the CLI. */
export type PreparationResult =
  | { ok: true; modules: number; out: string; sources: string[] }
  | { ok: false; problem: CliProblem };

/** The `extends` value that reaches `out` from the directory of a module. */
function extendsPath(source: string, out: string): string {
  const path = toPosixPath(relative(source, out));
  return `${path.startsWith("..") ? path : `./${path}`}/tsconfig.json`;
}

/**
 * Ends a type preparation: one summary line, with the `extends` each module
 * adds to its tsconfig, or the failure, thrown for the error boundary.
 */
export function reportPreparation(
  result: PreparationResult,
  durationMs: number,
  ui: Ui = getProcessUi(),
): void {
  if (!result.ok) throw new CliError(result.problem);
  writeBlankLine();
  ui.summary({
    headline: `Wrote the types of ${pluralize(result.modules, "module")}`,
    artifact: showPath(result.out),
    durationMs,
    nextSteps: result.sources.map((source) => ({
      command: `{ "extends": "${extendsPath(source, result.out)}" }`,
      description: `in ${showPath(source)}/tsconfig.json`,
    })),
  });
}

import { relative, sep } from "node:path";
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

const INSTALL_DIRECTORY = "node_modules";

/** Whether `source` lies under `node_modules`, where no tsconfig of its own is edited. */
function isInstalled(source: string): boolean {
  return source.split(sep).includes(INSTALL_DIRECTORY);
}

/** The `extends` value that reaches `out` from the directory of a module. */
function extendsPath(source: string, out: string): string {
  const path = toPosixPath(relative(source, out));
  return `${path.startsWith("..") ? path : `./${path}`}/tsconfig.json`;
}

/**
 * Ends a type preparation: one summary line, with the `extends` each module
 * outside `node_modules` adds to its tsconfig, or the failure, thrown for the
 * error boundary.
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
    nextSteps: result.sources
      .filter((source) => !isInstalled(source))
      .map((source) => ({
        command: `{ "extends": "${extendsPath(source, result.out)}" }`,
        description: `in ${showPath(source)}/tsconfig.json`,
      })),
  });
}

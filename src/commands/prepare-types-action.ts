import { resolve } from "node:path";
import {
  outputProblems,
  PREPARE_TYPES_OUT_VARIABLE,
} from "../prepare-types-output";
import type { PreparationResult } from "../prepare-types-result";
import { reportPreparation } from "../prepare-types-result";
import {
  assertValidUsage,
  runSourceRunner,
  usageProblems,
  type VerifySourceOptions,
} from "./verify-source-action";

export interface PrepareTypesOptions extends VerifySourceOptions {
  out: string;
}

/**
 * The runner shows its steps as tasks while it works, then sends its result
 * here: the summary, or the failure the error boundary reports once.
 */
export async function runPrepareTypes(
  options: PrepareTypesOptions,
): Promise<void> {
  const startedAt = Date.now();
  assertValidUsage([
    ...usageProblems(options),
    ...outputProblems(options.out, process.cwd()),
  ]);
  const { result, code } = await runSourceRunner<PreparationResult>(
    "prepare-types-runner",
    options,
    { [PREPARE_TYPES_OUT_VARIABLE]: resolve(options.out) },
  );
  reportPreparation(
    result ?? {
      ok: false,
      problem: {
        title: "Preparing the types failed",
        reason: `The preparation exited with code ${code} before reporting a result; its output is above.`,
      },
    },
    Date.now() - startedAt,
  );
}

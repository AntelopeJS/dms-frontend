import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { type CliProblem, getProcessUi, type Ui } from "@antelopejs/core/cli";
import { runCommand, UsageError } from "../common";
import {
  LAYER_PATH_FIX,
  reportVerification,
  type VerificationResult,
} from "../verify-source-result";

export interface VerifySourceOptions {
  layer?: string;
  localPackage?: string[];
  module?: string[];
}

const COMMAND_PATH = "ajs dms verify-source";
const LAYER_OPTION = "-l, --layer <path>";

/** Where `=` splits a `name=path` value, or -1 when it is malformed. */
function localPackageSeparator(value: string): number {
  const separator = value.indexOf("=");
  return separator <= 0 || separator === value.length - 1 ? -1 : separator;
}

function localPackageProblem(value: string): CliProblem | undefined {
  if (localPackageSeparator(value) >= 0) return undefined;
  return {
    title: `Invalid local package '${value}'`,
    fixes: ["Pass it as name=path: --local-package @scope/package=../package"],
  };
}

export function parseLocalPackages(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const problem = localPackageProblem(value);
      if (problem) throw new UsageError(problem);
      const separator = localPackageSeparator(value);
      return [value.slice(0, separator), resolve(value.slice(separator + 1))];
    }),
  );
}

/**
 * A missing package root, found here: the runner would only find out after
 * creating its temporary workspace, and crash with a raw ENOENT stack.
 */
function directoryProblem(path: string, label: string): CliProblem | undefined {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory())
    return undefined;
  return { title: `${label} not found: ${path}`, fixes: [LAYER_PATH_FIX] };
}

/** -l is required; Commander would word its absence the same way. */
const MISSING_LAYER: CliProblem = {
  title: `Required option '${LAYER_OPTION}' not specified`,
  reason: `Usage: ${COMMAND_PATH} [options]`,
  fixes: [`Run ${COMMAND_PATH} --help for usage`],
};

/** Every problem with the options of a run, in the order they were given. */
export function usageProblems(options: VerifySourceOptions): CliProblem[] {
  const problems = [
    options.layer === undefined
      ? MISSING_LAYER
      : directoryProblem(options.layer, "Layer path"),
    ...(options.module ?? []).map((path) =>
      directoryProblem(path, "Module path"),
    ),
    ...(options.localPackage ?? []).map(localPackageProblem),
  ];
  return problems.filter((problem) => problem !== undefined);
}

/**
 * Reports every usage problem, so one run is enough to correct them all: the
 * last one ends the run, with the usage exit code, through the error boundary.
 */
export function assertValidUsage(
  problems: CliProblem[],
  ui: Ui = getProcessUi(),
): void {
  if (problems.length === 0) return;
  const last = problems[problems.length - 1];
  for (const problem of problems.slice(0, -1)) ui.problem(problem);
  throw new UsageError(last);
}

/** The output flags the core reads from the command line, for the runner. */
const FORWARDED_FLAGS = ["--no-color", "--verbose"];

/** How long the result may take to arrive once the runner has exited. */
const RESULT_TIMEOUT_MS = 2000;

/** Resolves once the runner closed its IPC channel, or soon after it exited. */
function channelClosed(child: ChildProcess): Promise<void> {
  return new Promise((settle) => {
    child.once("disconnect", settle);
    child.once("exit", () => setTimeout(settle, RESULT_TIMEOUT_MS).unref());
  });
}

/**
 * The runner shows its checks as tasks while it works, then sends its result
 * here: the summary, or the failure the error boundary reports once.
 */
export async function runVerifySource(
  options: VerifySourceOptions,
): Promise<void> {
  const startedAt = Date.now();
  assertValidUsage(usageProblems(options));
  const layer = options.layer ?? "";
  const modules = options.module ?? [];
  const localPackages = parseLocalPackages(options.localPackage ?? []);
  // Next to this module: the compiled runner, or its source under tsx.
  const runner = join(
    __dirname,
    "..",
    `verify-source-runner${extname(__filename)}`,
  );
  const flags = FORWARDED_FLAGS.filter((flag) => process.argv.includes(flag));
  let result: VerificationResult | undefined;
  let closed: Promise<void> = Promise.resolve();
  const code = await runCommand(
    process.execPath,
    [...process.execArgv, runner, ...flags],
    {
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        DMS_LAYER_SOURCE: resolve(layer),
        DMS_MODULE_SOURCES: JSON.stringify(
          modules.map((path) => resolve(path)),
        ),
        DMS_LOCAL_PACKAGES: JSON.stringify(localPackages),
      },
    },
    (child) => {
      child.on("message", (message: VerificationResult) => {
        result = message;
      });
      closed = channelClosed(child);
    },
  );
  await closed;
  reportVerification(
    result ?? {
      ok: false,
      problem: {
        title: "Source verification failed",
        reason: `The verification exited with code ${code} before reporting a result; its output is above.`,
      },
    },
    Date.now() - startedAt,
  );
}

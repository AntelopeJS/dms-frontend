import type { ChildProcess } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import {
  CliError,
  type CliProblem,
  getProcessUi,
  type Ui,
} from "@antelopejs/core/cli";
import { runCommand, UsageError } from "../common";
import { lockVerification } from "../verify-source-lock";
import {
  LAYER_PATH_FIX,
  reportVerification,
  VERIFY_SOURCE_COMMAND,
  type VerificationResult,
} from "../verify-source-result";

export interface VerifySourceOptions {
  layer?: string;
  localPackage?: string[];
  module?: string[];
}

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

/** Every problem with the options of a run, in the order they were given. */
export function usageProblems(options: VerifySourceOptions): CliProblem[] {
  const problems = [
    options.layer === undefined
      ? undefined
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

/**
 * The Node.js flags of this process the runner starts with: the loaders and
 * preloads that let it run from source, such as those of tsx. Each takes a
 * value. Every other flag stays here: `-e` or `-p` would make the runner
 * evaluate the caller's script again instead of running.
 */
const LOADER_FLAGS = new Set([
  "--import",
  "--require",
  "-r",
  "--loader",
  "--experimental-loader",
]);

/** The loader flags in `execArgv`, each with its value. */
function loaderFlags(execArgv: readonly string[]): string[] {
  return execArgv.flatMap((flag, index) => {
    const separator = flag.indexOf("=");
    if (separator > 0)
      return LOADER_FLAGS.has(flag.slice(0, separator)) ? [flag] : [];
    const value = execArgv[index + 1];
    return LOADER_FLAGS.has(flag) && value !== undefined ? [flag, value] : [];
  });
}

/** Set in the runner's environment to the pid of the process that started it. */
export const RUNNER_VARIABLE = "DMS_VERIFY_SOURCE_RUNNER";

/** A verification started from inside a runner, which would start a runner within a runner. */
export function assertOutsideRunner(): void {
  const parent = process.env[RUNNER_VARIABLE];
  if (parent === undefined) return;
  throw new CliError({
    title: "A verification cannot start inside another one",
    reason: `${RUNNER_VARIABLE} is set: this process runs under the verification started by process ${parent}.`,
    fixes: [
      `Run ${VERIFY_SOURCE_COMMAND} from a shell outside the verification`,
    ],
  });
}

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
 *
 * The runner is next to this module: the compiled one, or its source under tsx.
 * Without `-l`, it resolves the installed core layer.
 *
 * It starts one runner and never retries. It stops before starting one when
 * it runs inside a runner, or while another verification of the same layer,
 * or of the same project without `-l`, is running.
 */
export async function runVerifySource(
  options: VerifySourceOptions,
): Promise<void> {
  assertOutsideRunner();
  assertValidUsage(usageProblems(options));
  const release = lockVerification(
    realpathSync.native(options.layer ?? process.cwd()),
  );
  try {
    await verify(options);
  } finally {
    release();
  }
}

/** What a runner ended with: its result, if it sent one, and its exit code. */
export interface RunnerOutcome<Result> {
  result: Result | undefined;
  code: number;
}

/**
 * Runs the source runner `name` (`verify-source-runner`) on the sources
 * `options` select, with `extraEnvironment` added to its inputs. It starts
 * one runner, with only the loader flags of this process, and never retries.
 *
 * The runner is next to this module: the compiled one, or its source under tsx.
 * Without `-l`, it resolves the installed core layer.
 */
export async function runSourceRunner<Result>(
  name: string,
  options: VerifySourceOptions,
  extraEnvironment: Record<string, string> = {},
): Promise<RunnerOutcome<Result>> {
  const modules = options.module ?? [];
  const localPackages = parseLocalPackages(options.localPackage ?? []);
  const runner = join(__dirname, "..", `${name}${extname(__filename)}`);
  const flags = FORWARDED_FLAGS.filter((flag) => process.argv.includes(flag));
  let result: Result | undefined;
  let closed: Promise<void> = Promise.resolve();
  const code = await runCommand(
    process.execPath,
    [...loaderFlags(process.execArgv), runner, ...flags],
    {
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        ...extraEnvironment,
        [RUNNER_VARIABLE]: String(process.pid),
        DMS_LAYER_SOURCE:
          options.layer === undefined ? undefined : resolve(options.layer),
        DMS_MODULE_SOURCES: JSON.stringify(
          modules.map((path) => resolve(path)),
        ),
        DMS_LOCAL_PACKAGES: JSON.stringify(localPackages),
      },
    },
    (child) => {
      child.on("message", (message: Result) => {
        result = message;
      });
      closed = channelClosed(child);
    },
  );
  await closed;
  return { result, code };
}

async function verify(options: VerifySourceOptions): Promise<void> {
  const startedAt = Date.now();
  const { result, code } = await runSourceRunner<VerificationResult>(
    "verify-source-runner",
    options,
  );
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

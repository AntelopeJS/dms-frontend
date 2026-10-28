import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CliError,
  getProcessTasks,
  getProcessUi,
  pluralize,
} from "@antelopejs/core/cli";
import { describeChildFailure, type PathMapper } from "./child-output";
import { BUILD_STEPS, buildStepFailure } from "./commands/build-action";
import { runFramedCommand } from "./common";
import {
  describeTypeCheckErrors,
  parseTypeCheckOutput,
} from "./typecheck-output";
import { VERIFY_SOURCE_COMMAND } from "./verify-source-result";
import { reportViteWarnings, ViteWarnings } from "./vite-output";

export interface VerificationContext {
  workspace: string;
  env: NodeJS.ProcessEnv;
  mapLine: PathMapper;
  warnings: ViteWarnings;
  isVerbose: boolean;
}

/**
 * The bundles a verification builds. Compressing the client assets only
 * matters to a server that ships them, and a verification ships nothing.
 */
const VERIFY_BUILD_STEPS = BUILD_STEPS.filter(
  (step) => step.script !== "build:compress",
);

/**
 * Writes the files Vite generates for the type check, auto-imports.d.ts
 * above all, so the type check can start with the builds instead of after
 * the client bundle.
 */
export async function prepareTypes(
  context: VerificationContext,
): Promise<void> {
  await getProcessTasks().run(
    "Generating the type declarations",
    async (task) => {
      const result = await runFramedCommand(
        "pnpm",
        ["--silent", "run", "build:types"],
        {
          name: "types",
          cwd: context.workspace,
          env: context.env,
          mapLine: context.mapLine,
        },
      );
      if (result.code === 0) return;
      task.fail("Type declarations failed");
      throw new CliError(
        describeChildFailure({
          title: "Generating the type declarations failed",
          command: "pnpm run build:types",
          code: result.code,
          lines: result.lines,
          isVerbose: context.isVerbose,
        }),
      );
    },
    { done: "Generated the type declarations" },
  );
  snapshotTypeDeclarations(context.workspace);
}

const AUTO_IMPORTS_DECLARATIONS = "auto-imports.d.ts";
const AUTO_IMPORTS_SNAPSHOT = "auto-imports.verify.d.ts";
const TYPECHECK_CONFIG = "tsconfig.verify.json";

/**
 * The client and SSR builds rewrite auto-imports.d.ts while the type check
 * reads it: the type check reads a copy taken before they start, through a
 * tsconfig of its own, so it never sees a half-written file.
 */
function snapshotTypeDeclarations(workspace: string): void {
  cpSync(
    join(workspace, AUTO_IMPORTS_DECLARATIONS),
    join(workspace, AUTO_IMPORTS_SNAPSHOT),
  );
  const config = JSON.parse(
    readFileSync(join(workspace, "tsconfig.json"), "utf8"),
  ) as {
    files?: string[];
  };
  config.files = (config.files ?? []).map((file) =>
    file === AUTO_IMPORTS_DECLARATIONS ? AUTO_IMPORTS_SNAPSHOT : file,
  );
  if (!config.files.includes(AUTO_IMPORTS_SNAPSHOT))
    throw new CliError({
      title: `The workspace tsconfig.json does not list ${AUTO_IMPORTS_DECLARATIONS}`,
    });
  writeFileSync(
    join(workspace, TYPECHECK_CONFIG),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

/**
 * Builds one bundle. Its Vite warnings are kept apart, since the builds run
 * at once and their lines interleave.
 *
 * `--silent` drops pnpm's script echo and its ELIFECYCLE line: the failure is
 * reported here.
 */
async function buildBundle(
  context: VerificationContext,
  step: (typeof BUILD_STEPS)[number],
  warnings: ViteWarnings,
): Promise<void> {
  await getProcessTasks().run(
    step.running,
    async (task) => {
      const result = await runFramedCommand(
        "pnpm",
        ["--silent", "run", step.script],
        {
          name: step.name,
          cwd: context.workspace,
          env: context.env,
          mapLine: context.mapLine,
          onLine: (line) => warnings.read(line),
        },
      );
      if (result.code === 0) return;
      task.fail(step.failed);
      throw buildStepFailure(
        step,
        result,
        context.isVerbose,
        VERIFY_SOURCE_COMMAND,
      );
    },
    { done: step.done },
  );
}

/**
 * Builds the bundles and type-checks at once: the steps share no output,
 * and each is mostly one busy core. Every step runs to its end, so a failure
 * is reported once nothing else writes to the screen, and the first failing
 * step, in their usual order, is the one reported.
 *
 * The build and type-check steps of a source verification, run at once in the
 * temporary workspace `verify-source-runner` materialized.
 */
export async function buildAndTypeCheck(
  context: VerificationContext,
): Promise<void> {
  const stepWarnings = VERIFY_BUILD_STEPS.map(() => new ViteWarnings());
  const outcomes = await Promise.allSettled([
    ...VERIFY_BUILD_STEPS.map((step, index) =>
      buildBundle(context, step, stepWarnings[index]),
    ),
    typeCheck(context),
  ]);
  for (const warnings of stepWarnings)
    for (const line of warnings.lines()) context.warnings.read(line);
  const failure = outcomes.find((outcome) => outcome.status === "rejected");
  if (failure) throw failure.reason;
  reportViteWarnings(context.warnings, context.isVerbose, getProcessUi());
}

async function typeCheck(context: VerificationContext): Promise<void> {
  const typecheckArguments = [
    "--import",
    "./typecheck-loader.mjs",
    "./node_modules/vue-tsc/bin/vue-tsc.js",
    "--project",
    TYPECHECK_CONFIG,
    "--noEmit",
    "--pretty",
  ];
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.execPath : "env";
  const commandArguments = isWindows
    ? typecheckArguments
    : ["-u", "NODE_OPTIONS", process.execPath, ...typecheckArguments];
  await getProcessTasks().run(
    "Type checking",
    async (task) => {
      const result = await runFramedCommand(command, commandArguments, {
        name: "vue-tsc",
        cwd: context.workspace,
        mapLine: context.mapLine,
      });
      if (result.code === 0) return;
      const report = parseTypeCheckOutput(result.lines);
      const count = report.count > 0 ? [pluralize(report.count, "error")] : [];
      task.fail(
        ["Type check failed", ...count].join(getProcessUi().symbols.separator),
      );
      throw new CliError(
        describeTypeCheckErrors(report, VERIFY_SOURCE_COMMAND) ??
          describeChildFailure({
            title: "Type check failed",
            command: "vue-tsc --noEmit",
            code: result.code,
            lines: result.lines,
            isVerbose: context.isVerbose,
          }),
      );
    },
    { done: "Type check passed" },
  );
}

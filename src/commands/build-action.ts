import { join, resolve, sep } from "node:path";
import {
  CliError,
  formatDuration,
  getProcessTasks,
  getProcessUi,
  isVerboseRun,
  type SummaryBlock,
} from "@antelopejs/core/cli";
import { UsageError } from "../config";
import {
  forgetPreparedLayers,
  readPreparedWorkspace,
  type RecordedLayer,
  recordPreparedLayers,
} from "../internal/prepared-workspace";
import {
  createFileNamer,
  createPathMapper,
  describeChildFailure,
  type PathMapper,
} from "../child-output";
import {
  CancelledError,
  type FramedCommandResult,
  runFramedCommand,
} from "../common";
import {
  endInterruptedTask,
  showWorkspace,
  writeBlankLine,
  writeHeader,
} from "../output";
import {
  describeViteFailure,
  reportViteWarnings,
  VITE_LOG_LEVEL_VARIABLE,
  viteLogLevel,
  ViteWarnings,
} from "../vite-output";
import { entryWeightThreshold, reportEntryWeight } from "../entry-weight";
import { setUpWorkspace } from "./workspace-task";
import { serverNodeOptions } from "../node-options";

export interface BuildOptions {
  /** The AntelopeJS project the modules are read from. */
  project: string;
  /** The AntelopeJS environment whose configuration applies. */
  env: string;
  /** Workspace directory to build into, `<project>/.dms-frontend` by default. */
  workspace?: string;
  force?: boolean;
  /** Set the workspace up, then stop before the bundles. */
  setupOnly?: boolean;
  /** False (`--no-install`) leaves the dependencies of a `--setup-only` run uninstalled. */
  install?: boolean;
  /** Bundle the workspace a setup finished, without setting it up again. */
  prepared?: boolean;
}

/** What one run of `build` does, out of setting the workspace up and bundling it. */
type BuildPlan =
  | { kind: "full" }
  | { kind: "setup"; install: boolean }
  | { kind: "prepared" };

/** A production workspace and the layers written into it. */
interface ProductionWorkspace {
  workspaceDir: string;
  layers: RecordedLayer[];
}

/** Exit code of a `--prepared` build whose workspace no setup finished. */
const NOT_PREPARED_EXIT_CODE = 3;

function buildPlan(options: BuildOptions): BuildPlan {
  const install = options.install !== false;
  if (options.setupOnly) return { kind: "setup", install };
  if (!install)
    throw new UsageError({
      title: "--no-install needs --setup-only",
      fixes: ["Run ajs dms build --setup-only --no-install"],
    });
  return options.prepared ? { kind: "prepared" } : { kind: "full" };
}

/** The `--workspace` a printed command repeats. */
function workspaceFlag(options: BuildOptions): string {
  return options.workspace ? ` --workspace ${options.workspace}` : "";
}

/**
 * Sets the workspace up for the project, then records the layers it wrote so
 * a later `--prepared` build reads them.
 */
async function setUpProductionWorkspace(
  options: BuildOptions,
  workspace: string,
  install: boolean,
): Promise<ProductionWorkspace> {
  forgetPreparedLayers(workspace);
  const { workspaceDir, layers } = await setUpWorkspace({
    force: !!options.force,
    mode: "build",
    workspaceDir: workspace,
    project: { projectDir: options.project, environment: options.env },
    install,
  });
  recordPreparedLayers(workspaceDir, layers);
  return { workspaceDir, layers };
}

/** How a `--setup-only` run ends: what it left, and the command that follows. */
function setupSummary(
  options: BuildOptions,
  install: boolean,
  workspaceDir: string,
  startedAt: number,
): SummaryBlock {
  const flag = workspaceFlag(options);
  return {
    headline: install
      ? "Set up the production workspace"
      : "Wrote the production workspace without installing it",
    artifact: showWorkspace(workspaceDir),
    durationMs: Date.now() - startedAt,
    nextSteps: [
      install
        ? {
            command: `ajs dms build --prepared${flag}`,
            description: "builds this workspace as it is",
          }
        : {
            command: `ajs dms build --setup-only${flag}`,
            description: "installs its dependencies",
          },
    ],
  };
}

/** The workspace a setup finished, or the refusal that names the fix. */
function preparedProductionWorkspace(
  options: BuildOptions,
  workspace: string,
): ProductionWorkspace {
  const workspaceDir = resolve(workspace);
  const found = readPreparedWorkspace(workspaceDir);
  if (found.prepared) return { workspaceDir, layers: found.layers };
  throw new CliError({
    title: `${showWorkspace(workspaceDir)} is not prepared`,
    reason: found.reason,
    fixes: [
      `Run ajs dms build --setup-only${workspaceFlag(options)} first, or build without --prepared`,
    ],
    exitCode: NOT_PREPARED_EXIT_CODE,
  });
}

/** Where a project's production frontend is built, unless --workspace names one. */
export const DEFAULT_WORKSPACE_DIR = ".dms-frontend";

/** The workspace a production command uses for a project. */
export function productionWorkspace(options: {
  project: string;
  workspace?: string;
}): string {
  return options.workspace ?? join(options.project, DEFAULT_WORKSPACE_DIR);
}

interface BuildStep {
  /** The workspace script that runs the step; its `build` script chains them. */
  script: string;
  /** Names the step in the gutter of a verbose run. */
  name: string;
  /** What the step produces, for an error Vite reports without a file. */
  subject: string;
  running: string;
  done: string;
  failed: string;
  /** Left on screen when Ctrl+C stops the step. */
  stopped: string;
}

/** The production build, one task per step, in the order `build` runs them. */
export const BUILD_STEPS: BuildStep[] = [
  {
    script: "build:client",
    name: "client",
    subject: "client bundle",
    running: "Building the client bundle",
    done: "Built the client bundle",
    failed: "Client bundle failed",
    stopped: "Client bundle stopped",
  },
  {
    script: "build:compress",
    name: "compress",
    subject: "compressed assets",
    running: "Compressing the client assets",
    done: "Compressed the client assets",
    failed: "Asset compression failed",
    stopped: "Asset compression stopped",
  },
  {
    script: "build:ssr",
    name: "ssr",
    subject: "SSR bundle",
    running: "Building the SSR bundle",
    done: "Built the SSR bundle",
    failed: "SSR bundle failed",
    stopped: "SSR bundle stopped",
  },
  {
    script: "build:email",
    name: "email",
    subject: "e-mail bundle",
    running: "Building the e-mail bundle",
    done: "Built the e-mail bundle",
    failed: "E-mail bundle failed",
    stopped: "E-mail bundle stopped",
  },
  {
    script: "build:server",
    name: "server",
    subject: "server modules bundle",
    running: "Building the server modules",
    done: "Built the server modules",
    failed: "Server modules bundle failed",
    stopped: "Server modules bundle stopped",
  },
];

interface BuildContext {
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  mapLine: PathMapper;
  nameFile: (file: string) => string;
  warnings: ViteWarnings;
  isVerbose: boolean;
}

/**
 * A build step that exited non-zero: the error Vite reported, or the end of
 * the step's output. `rerun` is the command the user runs once it is fixed.
 */
export function buildStepFailure(
  step: BuildStep,
  result: FramedCommandResult,
  isVerbose: boolean,
  rerun?: string,
  nameFile?: (file: string) => string,
): CliError {
  const problem =
    describeViteFailure(
      result.lines,
      step.subject,
      isVerbose,
      rerun,
      nameFile,
    ) ??
    describeChildFailure({
      title: "The production build failed",
      command: `pnpm run ${step.script}`,
      code: result.code,
      lines: result.lines,
      isVerbose,
    });
  return new CliError(problem);
}

/**
 * `--silent` drops pnpm's script echo and its ELIFECYCLE line: the CLI
 * reports the failure itself.
 */
async function runBuildStep(
  step: BuildStep,
  context: BuildContext,
): Promise<void> {
  const task = getProcessTasks().start(step.running);
  let result: FramedCommandResult;
  try {
    result = await runFramedCommand("pnpm", ["--silent", "run", step.script], {
      name: step.name,
      cwd: context.workspaceDir,
      env: context.env,
      mapLine: context.mapLine,
      onLine: (line) => context.warnings.read(line),
    });
  } catch (error) {
    endInterruptedTask(
      task,
      error instanceof CancelledError ? error : undefined,
      step.stopped,
    );
    throw error;
  }
  if (result.code !== 0) {
    task.fail(step.failed);
    throw buildStepFailure(
      step,
      result,
      context.isVerbose,
      undefined,
      context.nameFile,
    );
  }
  task.succeed(step.done);
}

/**
 * Build the production frontend. A stop names the build and how long it ran,
 * as a stopped dev server does.
 */
export async function runBuild(options: BuildOptions): Promise<void> {
  const startedAt = Date.now();
  try {
    await buildProduction(options, startedAt);
  } catch (error) {
    if (!(error instanceof CancelledError)) throw error;
    throw new CancelledError(
      error.signal,
      "Stopped the production build",
      `ran ${formatDuration(Date.now() - startedAt)}`,
    );
  }
}

/**
 * The entry weight threshold is read before the build, so that a value it
 * cannot use fails at once.
 */
async function buildProduction(
  options: BuildOptions,
  startedAt: number,
): Promise<void> {
  const plan = buildPlan(options);
  entryWeightThreshold(process.env);
  const ui = getProcessUi();
  const workspace = productionWorkspace(options);

  writeHeader("build", [options.project, options.env]);
  if (plan.kind === "setup") {
    const { workspaceDir } = await setUpProductionWorkspace(
      options,
      workspace,
      plan.install,
    );
    writeBlankLine();
    ui.summary(setupSummary(options, plan.install, workspaceDir, startedAt));
    return;
  }
  const { workspaceDir, layers } =
    plan.kind === "prepared"
      ? preparedProductionWorkspace(options, workspace)
      : await setUpProductionWorkspace(options, workspace, true);

  ui.message("info", "Building for production", {
    detail: `Workspace  ${showWorkspace(workspaceDir)}`,
  });

  const isVerbose = isVerboseRun();
  const context: BuildContext = {
    workspaceDir,
    isVerbose,
    warnings: new ViteWarnings(),
    mapLine: createPathMapper(workspaceDir, layers),
    nameFile: createFileNamer(layers),
    env: {
      ...process.env,
      NODE_OPTIONS: serverNodeOptions(process.env.NODE_OPTIONS),
      NODE_PATH: join(workspaceDir, "node_modules"),
      [VITE_LOG_LEVEL_VARIABLE]: viteLogLevel(isVerbose),
    },
  };
  for (const step of BUILD_STEPS) await runBuildStep(step, context);
  reportViteWarnings(context.warnings, isVerbose, ui);
  reportEntryWeight(ui, workspaceDir, process.env);

  writeBlankLine();
  ui.summary({
    headline: "Built the production frontend",
    artifact: `${showWorkspace(workspaceDir)}${sep}dist`,
    durationMs: Date.now() - startedAt,
    nextSteps: [
      {
        command: options.workspace
          ? `ajs dms start -b <backend> --workspace ${options.workspace}`
          : "ajs dms start -b <backend>",
        description:
          "from the project, with DMS_SESSION_SECRET, the server's secrets and the deployment's variables in its environment",
      },
    ],
  });
}

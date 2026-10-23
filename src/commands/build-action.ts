import { join, sep } from "node:path";
import {
  CliError,
  formatDuration,
  getProcessTasks,
  getProcessUi,
  isVerboseRun,
} from "@antelopejs/core/cli";
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

export interface BuildOptions {
  /** The AntelopeJS project the modules are read from. */
  project: string;
  /** The AntelopeJS environment whose configuration applies. */
  env: string;
  /** Workspace directory to build into, `<project>/.dms-frontend` by default. */
  workspace?: string;
  force?: boolean;
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

async function runBuildStep(
  step: BuildStep,
  context: BuildContext,
): Promise<void> {
  const task = getProcessTasks().start(step.running);
  let result: FramedCommandResult;
  try {
    // --silent drops pnpm's script echo and its ELIFECYCLE line: the CLI
    // reports the failure itself.
    result = await runFramedCommand("pnpm", ["--silent", "run", step.script], {
      name: step.name,
      cwd: context.workspaceDir,
      env: context.env,
      mapLine: context.mapLine,
      onLine: (line) => context.warnings.read(line),
    });
  } catch (error) {
    endInterruptedTask(task, error, step.stopped);
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

async function buildProduction(
  options: BuildOptions,
  startedAt: number,
): Promise<void> {
  // Read before the build, so that a value it cannot use fails at once.
  entryWeightThreshold(process.env);
  const ui = getProcessUi();
  const workspace = productionWorkspace(options);

  writeHeader("build", [options.project, options.env]);
  const { workspaceDir, layers } = await setUpWorkspace({
    force: !!options.force,
    mode: "build",
    workspaceDir: workspace,
    project: { projectDir: options.project, environment: options.env },
  });

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
      NODE_OPTIONS: "--max-old-space-size=4096",
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

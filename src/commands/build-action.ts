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
  flagOrEnv,
  type FramedCommandResult,
  normalizeBootstrapSecret,
  parseBackendUrl,
  requireBackendUrl,
  runFramedCommand,
} from "../common";
import { type FrontendSnapshot, readSnapshot } from "../snapshot";
import {
  cachedAge,
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
import { setUpWorkspace } from "./workspace-task";

export interface BuildOptions {
  backendUrl?: string;
  force?: boolean;
  offline?: boolean;
  bootstrapSecret?: string;
  /** Snapshot directory to build from, without the backend. */
  from?: string;
  /** Workspace directory to build into, instead of the one under the home. */
  workspace?: string;
}

/**
 * The snapshot a build reads, and the backend URL it is for: the one given,
 * or the one the snapshot was taken from.
 */
function buildSource(options: BuildOptions): {
  backendUrl: string;
  snapshot?: { dir: string; snapshot: FrontendSnapshot };
} {
  if (!options.from) {
    return { backendUrl: requireBackendUrl(options.backendUrl) };
  }
  if (options.offline) {
    throw new CliError({
      title: "--from and --offline cannot be combined",
      reason: "A snapshot build never asks the backend already.",
      fixes: ["Drop --offline"],
    });
  }
  const snapshot = readSnapshot(options.from);
  return {
    backendUrl: options.backendUrl
      ? parseBackendUrl(options.backendUrl)
      : snapshot.backendUrl,
    snapshot: { dir: options.from, snapshot },
  };
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
  const { backendUrl, snapshot } = buildSource(options);
  const bootstrapSecret = snapshot
    ? undefined
    : normalizeBootstrapSecret(options.bootstrapSecret);
  const ui = getProcessUi();

  writeHeader("build", [backendUrl, "production"]);
  const { workspaceDir, layers, manifestFromCache, manifestFetchedAt } =
    await setUpWorkspace({
      backendUrl,
      force: !!options.force,
      mode: "build",
      offline: snapshot ? false : flagOrEnv(options.offline, "DMS_OFFLINE"),
      bootstrapSecret,
      workspaceDir: options.workspace,
      snapshot,
    });

  if (snapshot) {
    ui.message(
      "info",
      `Building from the snapshot of ${snapshot.snapshot.backendUrl}${cachedAge(snapshot.snapshot.takenAt)}`,
      { detail: `Modules digest ${snapshot.snapshot.digest}` },
    );
  } else if (manifestFromCache) {
    ui.message(
      "warn",
      `Building from the manifest and layers archive${cachedAge(manifestFetchedAt)}`,
      { detail: "The output may not match the current backend." },
    );
  }

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

  writeBlankLine();
  ui.summary({
    headline: "Built the production frontend",
    artifact: `${showWorkspace(workspaceDir)}${sep}dist`,
    durationMs: Date.now() - startedAt,
    nextSteps: [
      {
        command: options.workspace
          ? `ajs dms start -b ${backendUrl} --workspace ${options.workspace}`
          : `ajs dms start -b ${backendUrl}`,
        description:
          "with DMS_SESSION_SECRET and the server's secrets in its environment",
      },
    ],
  });
}

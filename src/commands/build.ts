import { join } from "node:path";
import {
  CliError,
  getProcessTasks,
  getProcessUi,
  isVerboseRun,
  pluralize,
  type Ui,
} from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  createPathMapper,
  describeChildFailure,
  type PathMapper,
} from "../child-output";
import {
  type FramedCommandResult,
  normalizeBootstrapSecret,
  Options,
  requireBackendUrl,
  resolveSessionSecret,
  runFramedCommand,
} from "../common";
import {
  cachedAge,
  isTerminalFeedback,
  showWorkspace,
  writeHeader,
} from "../output";
import {
  describeViteFailure,
  VITE_LOG_LEVEL_VARIABLE,
  viteLogLevel,
  ViteWarnings,
} from "../vite-output";
import { setUpWorkspace } from "./workspace-task";

interface BuildOptions {
  backendUrl?: string;
  force?: boolean;
  offline?: boolean;
  bootstrapSecret?: string;
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
  },
  {
    script: "build:compress",
    name: "compress",
    subject: "compressed assets",
    running: "Compressing the client assets",
    done: "Compressed the client assets",
    failed: "Asset compression failed",
  },
  {
    script: "build:ssr",
    name: "ssr",
    subject: "SSR bundle",
    running: "Building the SSR bundle",
    done: "Built the SSR bundle",
    failed: "SSR bundle failed",
  },
  {
    script: "build:email",
    name: "email",
    subject: "e-mail bundle",
    running: "Building the e-mail bundle",
    done: "Built the e-mail bundle",
    failed: "E-mail bundle failed",
  },
];

interface BuildContext {
  workspaceDir: string;
  env: NodeJS.ProcessEnv;
  mapLine: PathMapper;
  warnings: ViteWarnings;
  isVerbose: boolean;
}

function stepFailure(
  step: BuildStep,
  result: FramedCommandResult,
  isVerbose: boolean,
): CliError {
  const problem =
    describeViteFailure(result.lines, step.subject, isVerbose) ??
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
    task.dismiss();
    throw error;
  }
  if (result.code !== 0) {
    task.fail(step.failed);
    throw stepFailure(step, result, context.isVerbose);
  }
  task.succeed(step.done);
}

/**
 * Counts Vite's warnings on a terminal, where the steps are read now, and
 * lists them in full elsewhere, since CI logs are read later. A verbose run
 * has already streamed them.
 */
function reportWarnings(warnings: ViteWarnings, isVerbose: boolean, ui: Ui) {
  if (isVerbose || warnings.count === 0) return;
  const title = pluralize(warnings.count, "Vite warning");
  const details = isTerminalFeedback()
    ? [`${ui.symbols.levels.hint} Run with --verbose to list them`]
    : warnings.lines();
  ui.message("warn", title, { details });
}

export function cmdBuild(): Command {
  return new Command("build")
    .description("Build for production (downloads layers via ZIP from backend)")
    .addOption(Options.backendUrl)
    .addOption(Options.force)
    .addOption(Options.offline)
    .addOption(Options.bootstrapSecret)
    .action(async (options: BuildOptions) => {
      const backendUrl = requireBackendUrl(options.backendUrl);
      const sessionSecret = resolveSessionSecret("build");
      const bootstrapSecret = normalizeBootstrapSecret(options.bootstrapSecret);
      const ui = getProcessUi();

      writeHeader("build", [backendUrl, "production"]);
      const { workspaceDir, layers, manifestFromCache, manifestFetchedAt } =
        await setUpWorkspace({
          backendUrl,
          force: !!options.force,
          mode: "build",
          offline: options.offline,
          bootstrapSecret,
        });

      if (manifestFromCache) {
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
        env: {
          ...process.env,
          DMS_SESSION_SECRET: sessionSecret,
          NODE_OPTIONS: "--max-old-space-size=4096",
          NODE_PATH: join(workspaceDir, "node_modules"),
          [VITE_LOG_LEVEL_VARIABLE]: viteLogLevel(isVerbose),
        },
      };
      for (const step of BUILD_STEPS) await runBuildStep(step, context);
      reportWarnings(context.warnings, isVerbose, ui);

      ui.message("success", "Built the production frontend");
      ui.message("hint", "Run ajs dms start to start the production server");
    });
}

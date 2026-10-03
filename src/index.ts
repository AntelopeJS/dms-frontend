#!/usr/bin/env node
import {
  formatUsageErrors,
  isVerboseRun,
  runWithErrorBoundary,
} from "@antelopejs/core/cli";
import { Command } from "commander";
import { cmdBuild } from "./commands/build";
import { cmdClean } from "./commands/clean";
import { cmdDev } from "./commands/dev";
import { cmdPrepare } from "./commands/prepare";
import { cmdStart } from "./commands/start";
import { cmdVerifySource } from "./commands/verify-source";
import { ENV_FILE_NAMES, loadProjectEnv } from "./env-file";
import { reportStopped } from "./output";
import { checkForUpdate, stripUpdateCheckFlag } from "./update-check";
import { CancelledError } from "./workspace-setup";

const { version } = require("../package.json");

/**
 * Options shared with `ajs` itself. A run given nothing else prints the help,
 * like a bare `ajs dms`.
 */
const GLOBAL_FLAGS = ["--no-color", "--verbose"];

const runCLI = async () => {
  // Before anything reads the environment: every command option binds to an
  // environment variable that Commander resolves while parsing, the commands
  // below are only constructed after this point, and each child process the
  // CLI spawns inherits `process.env` as it stands here.
  loadProjectEnv();

  const argv = process.argv.slice(2);

  // Fire and forget: the registry socket is unref'd, so a short command
  // never waits for the answer and a long one prints the notice when it
  // arrives.
  void checkForUpdate({ currentVersion: version, argv });

  const program = new Command()
    .name("ajs dms")
    .description(
      `Antelope DMS - Frontend Loader v${version}\n\n` +
        `Materializes frontend modules from an AntelopeJS backend and starts a Vue or React Vite and Inertia application.`,
    )
    .version(version, "-v, --version", "Display version number")
    // Read by the core output module straight from the command line and the
    // environment; declared so Commander accepts them after a command name.
    .option("--no-color", "Disable colors (also NO_COLOR=1)")
    .option(
      "--verbose",
      "Show stack traces in failures (also ANTELOPEJS_VERBOSE)",
    )
    // Registered for `--help` only: `stripUpdateCheckFlag` removes the flag
    // before Commander parses, so it is accepted after a subcommand name too.
    .option(
      "--no-update-check",
      "Skip the daily check for a newer DMS frontend release",
    )
    .helpCommand("help [command]", "Display help for a specific command")
    .addHelpText(
      "after",
      `
Environment:
  Every command reads ${ENV_FILE_NAMES.join(" then ")} from the current directory before parsing
  its options, so DMS_API_BASE_URL, DMS_BOOTSTRAP_SECRET, DMS_SESSION_SECRET and
  the other variables below can live in the project's .env. A variable already
  set in the environment always wins over a file, and .env.local wins over .env.
  The generated workspace never loads a .env of its own.
  'dev' generates an ephemeral 32-byte DMS_SESSION_SECRET when it is absent;
  restarting dev invalidates its sessions. 'build' and 'start' require a
  configured secret of at least 32 characters.

Workspaces:
  Each canonical backend URL gets its own workspace under
  ~/.antelopejs/dms-frontend. 'dev' without -b is the exception: it keys the
  workspace on the antelope project directory instead, so a backend that lands
  on a different port between runs keeps its node_modules and manifest cache.
  Pass -b to 'dev' to share one workspace with 'build' and 'start'.`,
    );

  program.addCommand(cmdDev());
  program.addCommand(cmdBuild());
  program.addCommand(cmdStart());
  program.addCommand(cmdPrepare());
  program.addCommand(cmdClean());
  program.addCommand(cmdVerifySource());
  formatUsageErrors(program);

  const args = stripUpdateCheckFlag(argv);
  if (args.every((arg) => GLOBAL_FLAGS.includes(arg))) {
    program.outputHelp();
    return;
  }
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (!(err instanceof CancelledError)) throw err;
    reportStopped(err.message, err.signal);
    process.exitCode = err.exitCode;
  }
};

// The commands leave their exit code in process.exitCode. Exiting here stops
// what a finished command may leave behind, such as the update check.
void runWithErrorBoundary(runCLI, { verbose: isVerboseRun() }).then(() =>
  process.exit(),
);

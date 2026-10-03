#!/usr/bin/env node
import {
  formatUsageErrors,
  getProcessPalette,
  getProcessUi,
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
import { cmdWorkspaces } from "./commands/workspaces";
import { loadProjectEnv } from "./env-file";
import {
  applyHelpConventions,
  ENVIRONMENT_TOPIC,
  formatEnvironmentHelp,
  formatExamples,
  type HelpExample,
} from "./help";
import { reportStopped } from "./output";
import { checkForUpdate, stripUpdateCheckFlag } from "./update-check";
import { CancelledError } from "./workspace-setup";

const { version } = require("../package.json");

/**
 * Options shared with `ajs` itself. A run given nothing else prints the help,
 * like a bare `ajs dms`.
 */
const GLOBAL_FLAGS = ["--no-color", "--verbose"];

const ROOT_EXAMPLES: HelpExample[] = [
  {
    description: "Inside a project started with ajs project dev",
    command: "ajs dms dev",
  },
  {
    description: "Build for production, then serve the build",
    command: "ajs dms build -b https://dms.example.com",
  },
  {
    description: "Serve it on another port",
    command: "ajs dms start -b https://dms.example.com -p 3001",
  },
];

function describeVersion(version: string): string {
  return `${getProcessPalette("result").bold(`ajs dms ${version}`)} · DMS frontend for AntelopeJS (Vue 3, Vite, Inertia)\n`;
}

function describeHelpFooter(): string {
  return (
    `\n${formatExamples(ROOT_EXAMPLES)}\n\n` +
    `Run ajs dms <command> --help for its options and examples, and\n` +
    `ajs dms help ${ENVIRONMENT_TOPIC} for the variables read from the environment.`
  );
}

/** Whether the arguments, global flags aside, are exactly `rest`. */
function isInvocation(args: string[], rest: string[]): boolean {
  const own = args.filter((arg) => !GLOBAL_FLAGS.includes(arg));
  return own.length === rest.length && own.every((arg, i) => arg === rest[i]);
}

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
    .version(version, "-v, --version", "Print the version")
    // Read by the core output module straight from the command line and the
    // environment; declared so Commander accepts them after a command name.
    .option("--no-color", "Disable colors (also NO_COLOR=1)")
    .option(
      "--verbose",
      "Show full output and stack traces (also ANTELOPEJS_VERBOSE)",
    )
    // Registered for `--help` only: `stripUpdateCheckFlag` removes the flag
    // before Commander parses, so it is accepted after a subcommand name too.
    .option(
      "--no-update-check",
      "Skip the daily update check (also NO_UPDATE_NOTIFIER=1)",
    )
    .addHelpText("before", describeVersion(version))
    .addHelpText("after", describeHelpFooter());

  program.addCommand(cmdDev());
  program.addCommand(cmdBuild());
  program.addCommand(cmdStart());
  program.addCommand(cmdPrepare());
  program.addCommand(cmdWorkspaces());
  program.addCommand(cmdClean());
  program.addCommand(cmdVerifySource());
  applyHelpConventions(program);
  formatUsageErrors(program);

  const args = stripUpdateCheckFlag(argv);
  if (isInvocation(args, [])) {
    program.outputHelp();
    return;
  }
  if (isInvocation(args, ["help", ENVIRONMENT_TOPIC])) {
    getProcessUi().value(formatEnvironmentHelp());
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

#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { cmdBuild } from "./commands/build";
import { cmdClean } from "./commands/clean";
import { cmdDev } from "./commands/dev";
import { cmdPrepare } from "./commands/prepare";
import { cmdStart } from "./commands/start";
import { cmdVerifySource } from "./commands/verify-source";
import { ENV_FILE_NAMES, loadProjectEnv } from "./env-file";
import { checkForUpdate, stripUpdateCheckFlag } from "./update-check";
import { displayBanner } from "./utils/cli-ui";

const { version } = require("../package.json");

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

  // Display banner if no args
  if (process.argv.length <= 2) {
    displayBanner("Antelope DMS");
    console.log(
      chalk.dim(`  Frontend Loader for AntelopeJS DMS - v${version}\n`),
    );
  }

  const program = new Command()
    .name("ajs dms")
    .description(
      `Antelope DMS - Frontend Loader v${version}\n\n` +
        `Materializes frontend modules from an AntelopeJS backend and starts a Vue or React Vite and Inertia application.`,
    )
    .version(version, "-v, --version", "Display version number")
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

  await program.parseAsync(stripUpdateCheckFlag(argv), { from: "user" });
};

// Handle SIGINT gracefully
process.on("SIGINT", () => process.exit(0));

// Run CLI
runCLI().catch((err) => {
  console.error(chalk.red("Error:"), err.message || err);
  process.exit(1);
});

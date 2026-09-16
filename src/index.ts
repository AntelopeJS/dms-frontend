#!/usr/bin/env node
import chalk from "chalk";
import { Command } from "commander";
import { cmdBuild } from "./commands/build";
import { cmdClean } from "./commands/clean";
import { cmdDev } from "./commands/dev";
import { cmdPrepare } from "./commands/prepare";
import { cmdStart } from "./commands/start";
import { cmdVerifySource } from "./commands/verify-source";
import { checkForUpdate, stripUpdateCheckFlag } from "./update-check";
import { displayBanner } from "./utils/cli-ui";

const { version } = require("../package.json");

const runCLI = async () => {
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
    .name("ajs-dms")
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
    .helpCommand("help [command]", "Display help for a specific command");

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

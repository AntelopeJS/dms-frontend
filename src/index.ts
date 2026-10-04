#!/usr/bin/env node
import {
  formatExamples,
  formatUsageErrors,
  getProcessPalette,
  getProcessUi,
  type HelpExample,
  helpTextWidth,
  isVerboseRun,
  runWithErrorBoundary,
  unbreakable,
  wrapText,
} from "@antelopejs/core/cli";
import { Command } from "commander";
import { CancelledError } from "./cancellation";
import { cmdBuild } from "./commands/build";
import { cmdClean } from "./commands/clean";
import { cmdDev } from "./commands/dev";
import { cmdPrepare } from "./commands/prepare";
import { cmdStart } from "./commands/start";
import { cmdVerifySource } from "./commands/verify-source";
import { cmdWorkspaces } from "./commands/workspaces";
import { loadProjectEnv } from "./env-file";
import { applyDmsHelp, ENVIRONMENT_TOPIC, formatEnvironmentHelp } from "./help";
import { exitOnBrokenPipe, reportStopped } from "./output";
import {
  reportAvailableUpdate,
  startProcessUpdateCheck,
  stripUpdateCheckFlag,
} from "./update-check";

const { version } = require("../package.json");

const QUIET_FLAGS = ["-q", "--quiet"];
/**
 * Options shared with `ajs` itself, `--verbose` aside. A run given nothing
 * else prints the help, like a bare `ajs dms`.
 */
const GLOBAL_FLAGS = ["--no-color", ...QUIET_FLAGS];
const VERBOSE_FLAG = "--verbose";
/** Only this spelling takes channels, as in `ajs`: `--verbose=vite`. */
const VERBOSE_ASSIGNMENT = `${VERBOSE_FLAG}=`;
const ALL_CHANNELS = "*";
const END_OF_OPTIONS = "--";

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

function describeVersion(version: string, width: number): string {
  const name = `ajs dms ${version}`;
  const line = [
    unbreakable(name),
    "DMS frontend for AntelopeJS (Vue 3, Vite, Inertia)",
  ].join(getProcessUi().symbols.separator);
  const [first, ...rest] = wrapText(line, width);
  const title = first.replace(name, getProcessPalette("result").bold(name));
  return `${[title, ...rest].join("\n")}\n`;
}

function describeHelpFooter(width: number): string {
  const pointer =
    `Run ${unbreakable("ajs dms <command> --help")} for its options and examples, and ` +
    `${unbreakable(`ajs dms help ${ENVIRONMENT_TOPIC}`)} for the variables read from the environment.`;
  return [
    "",
    formatExamples(ROOT_EXAMPLES, width),
    "",
    ...wrapText(pointer, width),
  ].join("\n");
}

/** Whether `arg` is a global flag, once `--verbose` is spelled `--verbose=*`. */
function isGlobalFlag(arg: string): boolean {
  return GLOBAL_FLAGS.includes(arg) || arg.startsWith(VERBOSE_ASSIGNMENT);
}

/** The arguments, global flags aside. */
function ownArguments(args: string[]): string[] {
  return args.filter((arg) => !isGlobalFlag(arg));
}

/** The options of the command line, without the operands after `--`. */
function optionArguments(args: string[]): string[] {
  const end = args.indexOf(END_OF_OPTIONS);
  return end === -1 ? args : args.slice(0, end);
}

/**
 * Spells a bare `--verbose` as `--verbose=*`, so that it never takes the
 * next argument as its channels: `ajs dms --verbose build` runs `build`.
 */
function normalizeVerboseArguments(args: string[]): string[] {
  const optionCount = optionArguments(args).length;
  return args.map((arg, index) =>
    index < optionCount && arg === VERBOSE_FLAG
      ? `${VERBOSE_ASSIGNMENT}${ALL_CHANNELS}`
      : arg,
  );
}

/**
 * Hands `-q` and `--verbose=<channels>` given to dms on to the processes it
 * starts, through the variables `ajs` sets for the same flags given before
 * the plugin name: `ANTELOPEJS_QUIET=1` and `ANTELOPEJS_VERBOSE=<channels>`.
 */
function exportOutputFlags(args: string[]): void {
  const options = optionArguments(args);
  if (options.some((arg) => QUIET_FLAGS.includes(arg))) {
    process.env.ANTELOPEJS_QUIET = "1";
  }
  const verbose = options.filter((arg) => arg.startsWith(VERBOSE_ASSIGNMENT));
  if (verbose.length > 0) {
    const channels = verbose[verbose.length - 1].slice(
      VERBOSE_ASSIGNMENT.length,
    );
    process.env.ANTELOPEJS_VERBOSE = channels || ALL_CHANNELS;
  }
}

/** Whether the arguments, global flags aside, are exactly `rest`. */
function isInvocation(args: string[], rest: string[]): boolean {
  const own = ownArguments(args);
  return own.length === rest.length && own.every((arg, i) => arg === rest[i]);
}

/**
 * The name in `help <name>` when it is neither a command nor a topic.
 * Commander would answer it with the whole root help, as an error.
 */
function unknownHelpSubject(
  program: Command,
  args: string[],
): string | undefined {
  const [first, subject, ...rest] = ownArguments(args);
  if (first !== "help" || subject === undefined || rest.length > 0) {
    return undefined;
  }
  const known = [
    ...program.commands.map((command) => command.name()),
    "help",
    ENVIRONMENT_TOPIC,
  ];
  return known.includes(subject) ? undefined : subject;
}

const runCLI = async () => {
  exitOnBrokenPipe();
  // Before anything reads the environment: every command option binds to an
  // environment variable that Commander resolves while parsing, the commands
  // below are only constructed after this point, and each child process the
  // CLI spawns inherits `process.env` as it stands here.
  loadProjectEnv();

  const argv = process.argv.slice(2);

  // Before the command, so the lookup has all of it to answer in; the
  // registry socket is unref'd, so a short command never waits for it.
  startProcessUpdateCheck({ currentVersion: version, argv });

  const program = new Command()
    .name("ajs dms")
    .version(version, "-v, --version", "Print the version")
    // Read by the core output module straight from the command line and the
    // environment; declared so Commander accepts them after a command name.
    .option("--no-color", "Disable colors (also NO_COLOR=1)")
    .option(
      `${VERBOSE_FLAG} [=channels]`,
      "Show full output and stack traces (also ANTELOPEJS_VERBOSE); any channels turn all of it on",
    )
    .option(
      "-q, --quiet",
      "Print only results, warnings and errors (also ANTELOPEJS_QUIET=1)",
    )
    // Registered for `--help` only: `stripUpdateCheckFlag` removes the flag
    // before Commander parses, so it is accepted after a subcommand name too.
    .option(
      "--no-update-check",
      "Skip the daily update check (also NO_UPDATE_NOTIFIER=1)",
    )
    .addHelpText("before", (context) =>
      describeVersion(version, helpTextWidth(context)),
    )
    .addHelpText("after", (context) =>
      describeHelpFooter(helpTextWidth(context)),
    );

  program.addCommand(cmdDev());
  program.addCommand(cmdBuild());
  program.addCommand(cmdStart());
  program.addCommand(cmdPrepare());
  program.addCommand(cmdWorkspaces());
  program.addCommand(cmdClean());
  program.addCommand(cmdVerifySource());
  applyDmsHelp(program);
  formatUsageErrors(program);

  const args = normalizeVerboseArguments(stripUpdateCheckFlag(argv));
  exportOutputFlags(args);
  if (isInvocation(args, [])) {
    program.outputHelp();
    return;
  }
  if (isInvocation(args, ["help", ENVIRONMENT_TOPIC])) {
    getProcessUi().value(formatEnvironmentHelp());
    return;
  }
  const helpSubject = unknownHelpSubject(program, args);
  if (helpSubject !== undefined) {
    program.error(`error: unknown command '${helpSubject}'`, {
      code: "commander.unknownCommand",
    });
  }
  try {
    await program.parseAsync(args, { from: "user" });
  } catch (err) {
    if (!(err instanceof CancelledError)) throw err;
    reportStopped(err);
    process.exitCode = err.exitCode;
    return;
  }
  // Last, and only after a success: a failure ends on its own problem.
  if (!process.exitCode) await reportAvailableUpdate();
};

// The commands leave their exit code in process.exitCode. Exiting here stops
// what a finished command may leave behind, such as the update lookup.
void runWithErrorBoundary(runCLI, { verbose: isVerboseRun() }).then(() =>
  process.exit(),
);

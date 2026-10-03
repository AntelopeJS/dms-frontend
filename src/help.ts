// What the help prints besides Commander's own sections: the conventions of
// the core CLI's help, the examples a command ends with, and the environment
// topic `ajs dms help environment` prints.
//
// The core keeps its help helpers out of `@antelopejs/core/cli`, so the
// conventions are restated here, in the same words and layout.

import type { Command } from "commander";
import { ENV_FILE_NAMES } from "./env-file";

export interface HelpExample {
  description: string;
  command: string;
}

const HELP_FLAGS = "-h, --help";
const HELP_DESCRIPTION = "Show help for a command";
const HELP_COMMAND = "help [command]";
const EXAMPLES_TITLE = "Examples:";
const EXAMPLE_INDENT = "  ";
const COMMENT_PREFIX = "# ";
const PROMPT_PREFIX = "$ ";

/** The help argument that names a topic rather than a command. */
export const ENVIRONMENT_TOPIC = "environment";

const HELP_WIDTH = 80;
const TABLE_INDENT = "  ";
const COLUMN_GAP = "  ";

/** Every variable a user may set, in the order the topic lists them. */
export const ENVIRONMENT_VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["DMS_API_BASE_URL", "Backend URL, same as -b; clean ignores it"],
  ["DMS_BOOTSTRAP_SECRET", "Same as --bootstrap-secret"],
  [
    "DMS_SESSION_SECRET",
    "Session key, 32 characters or more; build and start need one, dev makes one when unset",
  ],
  ["DMS_OFFLINE", "Same as --offline, unless 0, false, no or off"],
  ["DMS_PREPARE_STRICT", "Same as prepare --strict, read like DMS_OFFLINE"],
  ["PORT", "Same as -p"],
  ["HOST", "Address the server binds to (default: 0.0.0.0)"],
  [
    "DMS_COOKIE_SECURE",
    "Secure cookies unless false (default: false in dev, true in start)",
  ],
  [
    "DMS_TRUSTED_PROXY_HOPS",
    "Trusted reverse-proxy hops, counted from the right (default: 0)",
  ],
  [
    "DMS_HTML_RENDER_SECRET",
    "Overrides the e-mail render secret the backend publishes",
  ],
  [
    "DMS_OAUTH_RELAY_SECRET",
    "Overrides the OAuth relay secret the backend publishes",
  ],
  [
    "DMS_AUTH_ESTABLISH_ENDPOINTS",
    "More backend endpoints /auth/establish may open a session from, comma-separated",
  ],
  ["DMS_CLIENT_BASE_URL", "Public frontend URL used in links and e-mails"],
  ["NO_COLOR", "Same as --no-color"],
  ["ANTELOPEJS_VERBOSE", "Same as --verbose"],
  ["NO_UPDATE_NOTIFIER, CI", "Either one turns the update check off"],
];

const ENVIRONMENT_NOTES = [
  "A variable set in the shell wins over both files, and .env.local wins over .env. Only the current directory is read: the generated workspace never loads a .env of its own.",
  "Workspaces live in ~/.antelopejs/dms-frontend, one per backend URL. dev without -b keys its own on the project directory instead; pass -b to share one with build and start. ajs dms workspaces lists them.",
];

function formatExample(example: HelpExample): string[] {
  return [
    `${EXAMPLE_INDENT}${COMMENT_PREFIX}${example.description}`,
    `${EXAMPLE_INDENT}${PROMPT_PREFIX}${example.command}`,
  ];
}

export function formatExamples(examples: HelpExample[]): string {
  return [EXAMPLES_TITLE, ...examples.flatMap(formatExample)].join("\n");
}

export function withExamples(
  command: Command,
  examples: HelpExample[],
): Command {
  return command.addHelpText("after", `\n${formatExamples(examples)}`);
}

/** A command's name and arguments, without Commander's `[options]`. */
function subcommandTerm(command: Command): string {
  const args = command.registeredArguments.map((argument) =>
    argument.required ? `<${argument.name()}>` : `[${argument.name()}]`,
  );
  return [command.name(), ...args].join(" ");
}

/**
 * The help option and command of the core CLI, on `program` and on every
 * command under it.
 */
export function applyHelpConventions(program: Command): void {
  program
    .helpCommand(HELP_COMMAND, HELP_DESCRIPTION)
    .configureHelp({ subcommandTerm });
  const apply = (command: Command): void => {
    command.helpOption(HELP_FLAGS, HELP_DESCRIPTION);
    command.commands.forEach(apply);
  };
  apply(program);
}

/** Break `text` into lines of at most `width` characters, between words. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  return [...lines, line];
}

/** The text of `ajs dms help environment`. */
export function formatEnvironmentHelp(): string {
  const files = ENV_FILE_NAMES.map((name) => `./${name}`).join(", then ");
  const nameWidth = Math.max(
    ...ENVIRONMENT_VARIABLES.map(([name]) => name.length),
  );
  const descriptionIndent = " ".repeat(
    TABLE_INDENT.length + nameWidth + COLUMN_GAP.length,
  );
  const rows = ENVIRONMENT_VARIABLES.flatMap(([name, description]) => {
    const [first, ...rest] = wrap(
      description,
      HELP_WIDTH - descriptionIndent.length,
    );
    return [
      `${TABLE_INDENT}${name.padEnd(nameWidth)}${COLUMN_GAP}${first}`,
      ...rest.map((line) => `${descriptionIndent}${line}`),
    ];
  });
  return [
    `Environment (read from the shell, then ${files})`,
    "",
    ...rows,
    ...ENVIRONMENT_NOTES.flatMap((note) => ["", ...wrap(note, HELP_WIDTH)]),
  ].join("\n");
}

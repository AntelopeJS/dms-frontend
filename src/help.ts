// What the help prints besides Commander's own sections: the conventions of
// the core CLI's help, the examples a command ends with, and the environment
// topic `ajs dms help environment` prints.
//
// The core keeps its help helpers out of `@antelopejs/core/cli`, so the
// conventions are restated here, in the same words and layout. Everything is
// wrapped to the terminal, up to 80 columns.

import { type Command, Help } from "commander";
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
/** Narrower than this, a description goes under its option rather than beside it. */
const MIN_DESCRIPTION_WIDTH = 30;
const STACKED_INDENT = "      ";
/** Commander's indent before an option and gap after it. */
const ITEM_MARGINS = 4;
/** Joins the words a line must not break between, such as those of a command. */
const UNBREAKABLE_SPACE = "\u00a0";

interface HelpStream {
  isTTY?: boolean;
  columns?: number;
}

/** The width help is wrapped to: the terminal's, up to 80 columns. */
export function helpWidth(stream: HelpStream = process.stdout): number {
  const columns = stream.isTTY ? stream.columns : undefined;
  return columns ? Math.min(columns, HELP_WIDTH) : HELP_WIDTH;
}

/** `text` with its spaces kept on one line by `wrapText`. */
export function unbreakable(text: string): string {
  return text.replaceAll(" ", UNBREAKABLE_SPACE);
}

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

/** An example: its comment wrapped, its command whole, to be copied. */
function formatExample(example: HelpExample, width: number): string[] {
  const comment = `${EXAMPLE_INDENT}${COMMENT_PREFIX}`;
  return [
    ...wrapText(example.description, width - comment.length).map(
      (line) => `${comment}${line}`,
    ),
    `${EXAMPLE_INDENT}${PROMPT_PREFIX}${example.command}`,
  ];
}

export function formatExamples(
  examples: HelpExample[],
  width: number = helpWidth(),
): string {
  return [
    EXAMPLES_TITLE,
    ...examples.flatMap((example) => formatExample(example, width)),
  ].join("\n");
}

export function withExamples(
  command: Command,
  examples: HelpExample[],
): Command {
  return command.addHelpText("after", () => `\n${formatExamples(examples)}`);
}

/** A command's name and arguments, without Commander's `[options]`. */
function subcommandTerm(command: Command): string {
  const args = command.registeredArguments.map((argument) =>
    argument.required ? `<${argument.name()}>` : `[${argument.name()}]`,
  );
  return [command.name(), ...args].join(" ");
}

/**
 * An option or command with its description: beside it, wrapped, as
 * Commander lays it out; under it when the terminal leaves the description
 * too little room beside it.
 */
function formatItem(
  this: Help,
  term: string,
  termWidth: number,
  description: string,
  helper: Help,
): string {
  const width = helper.helpWidth ?? HELP_WIDTH;
  if (!description || width - termWidth - ITEM_MARGINS >= MIN_DESCRIPTION_WIDTH)
    return Help.prototype.formatItem.call(
      this,
      term,
      termWidth,
      description,
      helper,
    );
  return [
    `${TABLE_INDENT}${term}`,
    ...wrapText(description, width - STACKED_INDENT.length).map(
      (line) => `${STACKED_INDENT}${line}`,
    ),
  ].join("\n");
}

/**
 * The help option and command of the core CLI, on `program` and on every
 * command under it, wrapped to the terminal.
 */
export function applyHelpConventions(program: Command): void {
  program.helpCommand(HELP_COMMAND, HELP_DESCRIPTION);
  const apply = (command: Command): void => {
    command
      .helpOption(HELP_FLAGS, HELP_DESCRIPTION)
      .configureHelp({
        subcommandTerm,
        formatItem,
        minWidthToWrap: MIN_DESCRIPTION_WIDTH,
      })
      .configureOutput({
        getOutHelpWidth: () => helpWidth(process.stdout),
        getErrHelpWidth: () => helpWidth(process.stderr),
      });
    command.commands.forEach(apply);
  };
  apply(program);
}

/**
 * Break `text` into lines of at most `width` characters, between words; the
 * words of an `unbreakable` run stay on one line.
 */
export function wrapText(text: string, width: number): string[] {
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
  return [...lines, line].map((shown) =>
    shown.replaceAll(UNBREAKABLE_SPACE, " "),
  );
}

/**
 * A variable and its description, in two columns; the description under the
 * name when the columns leave it too little room.
 */
function formatVariable(
  name: string,
  description: string,
  nameWidth: number,
  width: number,
): string[] {
  const indent = TABLE_INDENT.length + nameWidth + COLUMN_GAP.length;
  if (width - indent < MIN_DESCRIPTION_WIDTH) {
    return [
      `${TABLE_INDENT}${name}`,
      ...wrapText(description, width - STACKED_INDENT.length).map(
        (line) => `${STACKED_INDENT}${line}`,
      ),
    ];
  }
  const [first, ...rest] = wrapText(description, width - indent);
  return [
    `${TABLE_INDENT}${name.padEnd(nameWidth)}${COLUMN_GAP}${first}`,
    ...rest.map((line) => `${" ".repeat(indent)}${line}`),
  ];
}

/** The text of `ajs dms help environment`, wrapped to `width`. */
export function formatEnvironmentHelp(width: number = helpWidth()): string {
  const files = ENV_FILE_NAMES.map((name) => `./${name}`).join(", then ");
  const nameWidth = Math.max(
    ...ENVIRONMENT_VARIABLES.map(([name]) => name.length),
  );
  return [
    ...wrapText(`Environment (read from the shell, then ${files})`, width),
    "",
    ...ENVIRONMENT_VARIABLES.flatMap(([name, description]) =>
      formatVariable(name, description, nameWidth, width),
    ),
    ...ENVIRONMENT_NOTES.flatMap((note) => ["", ...wrapText(note, width)]),
  ].join("\n");
}

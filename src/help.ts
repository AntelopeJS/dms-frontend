// What the help prints besides Commander's own sections and the conventions
// of the core CLI's help: the environment topic `ajs dms help environment`
// prints, and command names listed without Commander's `[options]`.
// Everything is wrapped to the terminal, up to 80 columns.

import {
  applyHelpConventions,
  formatHelpItem,
  helpWidth,
  wrapText,
} from "@antelopejs/core/cli";
import type { Command } from "commander";
import { ENV_FILE_NAMES } from "./env-file";

/** The help argument that names a topic rather than a command. */
export const ENVIRONMENT_TOPIC = "environment";

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

/** A command's name and arguments, without Commander's `[options]`. */
function subcommandTerm(command: Command): string {
  const args = command.registeredArguments.map((argument) =>
    argument.required ? `<${argument.name()}>` : `[${argument.name()}]`,
  );
  return [command.name(), ...args].join(" ");
}

/**
 * The help of the core CLI on `program` and on every command under it,
 * commands listed by name and arguments.
 */
export function applyDmsHelp(program: Command): void {
  applyHelpConventions(program);
  const apply = (command: Command): void => {
    command.configureHelp({ ...command.configureHelp(), subcommandTerm });
    command.commands.forEach(apply);
  };
  apply(program);
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
      formatHelpItem(name, nameWidth, description, width),
    ),
    ...ENVIRONMENT_NOTES.flatMap((note) => ["", ...wrapText(note, width)]),
  ].join("\n");
}

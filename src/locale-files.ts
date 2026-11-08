import { readFileSync } from "node:fs";
import { CliError } from "@antelopejs/core/cli";
import { baseCompile, type CompileError } from "@intlify/message-compiler";
import { isObjectLike, isText } from "./internal/guards";
import {
  isLocaleValue,
  isMessageGroup,
  type LocaleMessages,
  type LocaleValue,
} from "./internal/locale-catalogs";

/**
 * A locale file that does not parse, or holds a message vue-i18n cannot
 * compile: in development an editor can save a catalog half-written. Carries
 * the file, which the dev watcher shows as the source the user edits, why, and
 * one detail line per message naming its key and its fix, which the CLI prints
 * without `--verbose`.
 */
export class InvalidLocaleFileError extends CliError {
  constructor(
    readonly path: string,
    readonly reason: string,
    readonly details: readonly string[] = [],
  ) {
    super({
      title: `Invalid locale file ${path}: ${reason}`,
      details: [...details],
    });
    this.name = "InvalidLocaleFileError";
  }
}

/** The characters vue-i18n's syntax reserves, as a message writes them literally. */
const LITERAL_ESCAPES = {
  "@": "{'@'}",
  "{": "{'{'}",
  "}": "{'}'}",
  "|": "{'|'}",
};

type ReservedCharacter = keyof typeof LITERAL_ESCAPES;

function isReservedCharacter(
  character: string,
): character is ReservedCharacter {
  return Object.prototype.hasOwnProperty.call(LITERAL_ESCAPES, character);
}

/** One message that does not compile, with the key that holds it. */
interface MessageProblem {
  key: string;
  message: string;
  error: CompileError;
}

/**
 * The reserved character the compiler stopped on: the nearest one at or
 * before where it reports the error.
 */
function reservedCharacterAt(
  message: string,
  offset: number,
): ReservedCharacter | null {
  for (let index = Math.min(offset, message.length - 1); index >= 0; index--) {
    const character = message[index];
    if (isReservedCharacter(character)) return character;
  }
  return null;
}

function describeProblem({ key, message, error }: MessageProblem): string {
  const where = `${key}: ${error.message} in ${JSON.stringify(message)}`;
  const character = reservedCharacterAt(
    message,
    error.location?.start.offset ?? message.length,
  );
  if (!character) {
    return `${where}. Write ${Object.values(LITERAL_ESCAPES).join(", ")} for a literal ${Object.keys(LITERAL_ESCAPES).join(", ")}.`;
  }
  const fixed = message.replaceAll(character, LITERAL_ESCAPES[character]);
  return `${where}. Write a literal ${character} as ${LITERAL_ESCAPES[character]}: ${JSON.stringify(fixed)}.`;
}

function firstCompileError(message: string): CompileError | undefined {
  let first: CompileError | undefined;
  baseCompile(message, {
    location: true,
    onError: (error) => {
      first ??= error;
    },
  });
  return first;
}

/** Every message under `value` that does not compile, by its dotted key. */
function messageProblems(value: LocaleValue, key: string): MessageProblem[] {
  if (isText(value)) {
    const error = firstCompileError(value);
    return error ? [{ key, message: value, error }] : [];
  }
  if (!isObjectLike(value)) return [];
  return Object.entries(value).flatMap(([child, nested]) =>
    messageProblems(nested, key ? `${key}.${child}` : child),
  );
}

/**
 * A locale file's catalog, once it parses and each message compiles.
 *
 * The locale files of the asset roots are read and checked: each one must
 * parse, and each of its messages must compile with vue-i18n's message
 * compiler, so a message the application could not show stops the build and
 * dev instead of reaching a page.
 */
export function readLocaleFile(path: string): LocaleMessages {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidLocaleFileError(path, reason);
  }
  if (!isLocaleValue(value) || !isMessageGroup(value)) {
    throw new InvalidLocaleFileError(
      path,
      "a locale file must hold a JSON object of messages",
    );
  }
  const problems = messageProblems(value, "");
  if (problems.length) {
    throw new InvalidLocaleFileError(
      path,
      `${problems.length} message(s) vue-i18n cannot compile:`,
      problems.map(describeProblem),
    );
  }
  return value;
}

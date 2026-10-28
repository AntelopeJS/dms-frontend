import { readFileSync } from "node:fs";
import { baseCompile, type CompileError } from "@intlify/message-compiler";

/**
 * A locale file that does not parse, or holds a message vue-i18n cannot
 * compile: in development an editor can save a catalog half-written. Carries
 * the file, which the dev watcher shows as the source the user edits, and why,
 * naming each message and its fix.
 */
export class InvalidLocaleFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Invalid locale file ${path}: ${reason}`);
    this.name = "InvalidLocaleFileError";
  }
}

/** The characters vue-i18n's syntax reserves, as a message writes them literally. */
const LITERAL_ESCAPES: Record<string, string> = {
  "@": "{'@'}",
  "{": "{'{'}",
  "}": "{'}'}",
  "|": "{'|'}",
};

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
function reservedCharacterAt(message: string, offset: number): string | null {
  for (let index = Math.min(offset, message.length - 1); index >= 0; index--) {
    if (message[index] in LITERAL_ESCAPES) return message[index];
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
function messageProblems(value: unknown, key: string): MessageProblem[] {
  if (typeof value === "string") {
    const error = firstCompileError(value);
    return error ? [{ key, message: value, error }] : [];
  }
  if (typeof value !== "object" || value === null) return [];
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
export function readLocaleFile(path: string): Record<string, unknown> {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidLocaleFileError(path, reason);
  }
  const problems = messageProblems(value, "");
  if (problems.length) {
    const reason = [
      `${problems.length} message(s) vue-i18n cannot compile:`,
      ...problems.map(describeProblem),
    ].join("\n");
    throw new InvalidLocaleFileError(path, reason);
  }
  return value;
}

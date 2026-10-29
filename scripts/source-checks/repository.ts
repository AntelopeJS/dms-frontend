import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve(__dirname, "..", "..");
export const TEMPLATE_DIR = join(ROOT, "templates", "vue");

/** A violation of an invariant, worded for the person who must fix it. */
export type Problem = string;

/** An invariant over repository files: the violations it finds, none when it holds. */
export interface SourceCheck {
  name: string;
  run: () => Problem[] | Promise<Problem[]>;
}

/** The UTF-8 text of a file of `templates/vue`. */
export function templateText(...parts: string[]): string {
  return readFileSync(join(TEMPLATE_DIR, ...parts), "utf8");
}

/** Every file under `path`, or `path` itself when it is a file. */
export function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

export function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** One problem when `text` does not match `pattern`. */
export function expectMatch(
  text: string,
  pattern: RegExp,
  problem: Problem,
): Problem[] {
  return pattern.test(text) ? [] : [problem];
}

/** One problem when `text` matches `pattern`. */
export function expectNoMatch(
  text: string,
  pattern: RegExp,
  problem: Problem,
): Problem[] {
  return pattern.test(text) ? [problem] : [];
}

/** Narrows a parsed JSON value to an object, arrays included. */
export function isJsonObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/** Narrows a value to a list of strings. */
export function isStringList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) if (typeof entry !== "string") return false;
  return true;
}

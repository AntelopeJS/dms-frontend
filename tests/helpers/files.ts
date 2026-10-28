import { readdirSync, readFileSync } from "node:fs";

type FilePath = string | URL;

/** The UTF-8 text of a file the code under test wrote, or a fixture. */
export function readText(path: FilePath): string {
  return readFileSync(path, "utf8");
}

/** The bytes of a file the code under test wrote. */
export function readBytes(path: FilePath): Buffer {
  return readFileSync(path);
}

/** The names directly inside a directory. */
export function listNames(path: string): string[] {
  return readdirSync(path);
}

/** The paths below a directory, relative to it, at every depth. */
export function listTree(path: string): string[] {
  return readdirSync(path, { recursive: true, encoding: "utf8" });
}

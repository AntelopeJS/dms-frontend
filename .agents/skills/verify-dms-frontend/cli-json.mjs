/**
 * Reads the JSON the CLI and its files hold, without assuming a shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { at, keysOf, listAt, numberAt, parseJson, textAt } from "./json.mjs";

/**
 * @param {string} file A JSON file
 * @returns {unknown} What it holds, or undefined when it is not JSON
 */
export function readJson(file) {
  return parseJson(readFileSync(file, "utf8"));
}

/**
 * @typedef {object} ListedWorkspace
 * @property {string | undefined} id
 * @property {string | undefined} dir
 * @property {string | undefined} backendUrl
 * @property {unknown} key
 * @property {number | undefined} sizeBytes
 * @property {string | undefined} lastUsedAt
 * @property {string[]} fields The keys the entry has, sorted
 */

/**
 * @param {string} text The stdout of `ajs dms workspaces --json`
 * @returns {ListedWorkspace[]} The workspaces it lists
 */
export function listedWorkspaces(text) {
  return listAt(parseJson(text)).map((entry) => ({
    id: textAt(entry, "id"),
    dir: textAt(entry, "dir"),
    backendUrl: textAt(entry, "backendUrl"),
    key: at(entry, "key"),
    sizeBytes: numberAt(entry, "sizeBytes"),
    lastUsedAt: textAt(entry, "lastUsedAt"),
    fields: keysOf(entry).sort(),
  }));
}

/**
 * @param {string} file A package.json
 * @returns {string | undefined} Its version
 */
export function versionOf(file) {
  return textAt(readJson(file), "version");
}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @returns {string} The release of the renderer checkout the run serves, as its package.json names it
 */
export function rendererVersion(ctx) {
  const file = join(ctx.state.renderer ?? "", "package.json");
  const version = versionOf(file);
  if (version === undefined) throw new Error(`${file} names no version`);
  return version;
}

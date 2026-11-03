/**
 * Workspaces written by hand under a journey's home, in the shape the CLI stamps them: a directory
 * named after the SHA-256 of its key, with a `.ajs-dms-meta.json`.
 */
import { createHash } from "node:crypto";
import { linkSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const META_FILE = ".ajs-dms-meta.json";

/**
 * @param {string} key A workspace key
 * @returns {string} Its SHA-256, hex
 */
export function sha256(key) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * @param {string} home The home directory
 * @returns {string} The directory the CLI keeps workspaces in
 */
export function workspacesRoot(home) {
  return join(home, ".antelopejs", "dms-frontend");
}

/**
 * @typedef {object} WorkspaceSpec
 * @property {string} key The exact key hashed into the directory name
 * @property {string} backendUrl The backend url the meta file records
 * @property {string} [updatedAt] The recorded last use; left out of the meta file when absent
 * @property {Record<string, number>} [files] Extra files by relative path, each of that many bytes
 * @property {string} [linked] A relative path that is a hard link to the first extra file
 * @property {number} [padTo] Total bytes the workspace takes, met with a `pad.bin`
 * @property {Date} [modified] The modification time given to the meta file
 */

/**
 * @param {string} home The home directory
 * @param {WorkspaceSpec} spec The workspace
 * @returns {{ dir: string, id: string, sizeBytes: number }} Where it is, its id and the bytes it takes
 */
export function writeWorkspace(home, spec) {
  const id = sha256(spec.key);
  const dir = join(workspacesRoot(home), id);
  mkdirSync(dir, { recursive: true });
  const meta = JSON.stringify(spec.updatedAt ? { backendUrl: spec.backendUrl, workspaceKey: spec.key, updatedAt: spec.updatedAt } : { backendUrl: spec.backendUrl, workspaceKey: spec.key });
  writeFileSync(join(dir, META_FILE), meta);
  if (spec.modified) utimesSync(join(dir, META_FILE), spec.modified, spec.modified);
  let sizeBytes = Buffer.byteLength(meta);
  if (spec.padTo !== undefined) {
    writeFileSync(join(dir, "pad.bin"), Buffer.alloc(spec.padTo - sizeBytes, 97));
    sizeBytes = spec.padTo;
  }
  let first;
  for (const [relative, bytes] of Object.entries(spec.files ?? {})) {
    const file = join(dir, relative);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, Buffer.alloc(bytes, 97));
    first ??= file;
    sizeBytes += bytes;
  }
  if (spec.linked && first) {
    const file = join(dir, spec.linked);
    mkdirSync(join(file, ".."), { recursive: true });
    linkSync(first, file);
  }
  return { dir, id, sizeBytes };
}

/**
 * @param {string} home The home directory
 * @param {string} name A directory name under the workspaces root
 * @param {Record<string, string>} [files] Files by relative path
 * @returns {string} The directory
 */
export function writeForeign(home, name, files = {}) {
  const dir = join(workspacesRoot(home), name);
  mkdirSync(dir, { recursive: true });
  for (const [relative, text] of Object.entries(files)) writeFileSync(join(dir, relative), text);
  return dir;
}

/**
 * Writes a minimal frontend module and returns the manifest entry that serves it.
 *
 * @param {string} dir The module's source directory
 * @param {{ name?: string, engines?: string, scripts?: Record<string, string>, privateOptions?: Record<string, string>, renderer?: { name: string, version: string } }} [options] What it declares
 * @returns {Record<string, unknown>} The module as a manifest lists it
 */
export function writeModule(dir, options = {}) {
  const name = options.name ?? "@fixture/mod";
  mkdirSync(dir, { recursive: true });
  const manifest = { name: `${name}-frontend-vue`, version: "1.0.0", type: "module", scripts: options.scripts, engines: options.engines ? { "@antelopejs/dms-frontend": options.engines } : undefined };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "dms.frontend.ts"), "export default {};\n");
  return {
    name,
    renderer: options.renderer ?? { name: "vue", version: "3" },
    path: dir,
    priority: 10,
    options: { a: 1 },
    privateOptions: options.privateOptions,
  };
}

/**
 * @param {number} bytes A size
 * @returns {string} The size as the CLI words it: bytes below 1024, then KB, MB, GB with one decimal below 10
 */
export function humanSize(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = unit > 0 && value < 10 ? String(Math.round(value * 10) / 10) : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}

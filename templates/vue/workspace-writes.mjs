/**
 * Preloaded with `--import`, refuses every file or directory the process would
 * create or write outside its working directory through the synchronous
 * `node:fs` calls TypeScript writes with. TypeScript writes the declaration of
 * a file outside `rootDir` beside that file, such as a `.ts` file a component
 * imports from another drive than the sources; the refusal reaches it as a
 * write error, which it reports as a diagnostic and moves on.
 *
 * @packageDocumentation
 */
import fs from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.cwd();
/** @type {Set<fs.OpenMode | undefined>} */
const READ_ONLY_FLAGS = new Set([
  undefined,
  "r",
  "rs",
  "sr",
  fs.constants.O_RDONLY,
]);

/**
 * Throws unless `target` lies in the working directory. A file descriptor
 * passes: only an open the guard allowed returns one.
 *
 * @param {fs.PathOrFileDescriptor} target
 * @param {string} syscall
 */
function assertInside(target, syscall) {
  if (Number.isInteger(target)) return;
  const path = resolve(
    target instanceof URL ? fileURLToPath(target) : String(target),
  );
  const inside = relative(ROOT, path);
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    return;
  throw new Error(`${syscall} refused outside ${ROOT}: ${path}`);
}

const { mkdirSync, openSync, writeFileSync } = fs;

fs.mkdirSync = (path, options) => {
  assertInside(path, "mkdir");
  return mkdirSync(path, options);
};
fs.openSync = (path, flags, mode) => {
  if (!READ_ONLY_FLAGS.has(flags)) assertInside(path, "open");
  return openSync(path, flags, mode);
};
fs.writeFileSync = (file, data, options) => {
  assertInside(file, "write");
  writeFileSync(file, data, options);
};

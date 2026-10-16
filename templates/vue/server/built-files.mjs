// The built files the production server hands to a browser: what the client
// build wrote to `dist/client`, except a file or directory whose name starts
// with a dot. Vite keeps its build metadata there (`.vite/manifest.json`, the
// source path of every module file), and a module's `public/` may hold dot
// files too. `/.well-known/`, which RFC 8615 reserves for files meant to be
// public, stays served.

import { existsSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const PUBLIC_DOT_DIRECTORY = ".well-known";

/**
 * Whether a path relative to the build root may be served: no segment starts
 * with a dot, but a leading `.well-known`. Split on both separators: on
 * Windows, `relative` answers with backslashes, and a decoded `%5C` is one.
 */
export function isPublicBuildPath(relativePath) {
  return relativePath
    .split(/[\\/]/)
    .every(
      (segment, index) =>
        !segment.startsWith(".") ||
        (index === 0 && segment === PUBLIC_DOT_DIRECTORY),
    );
}

/**
 * The file under `root` a request path names, or `undefined` when the server
 * serves none there: the path is malformed, leaves `root`, names a dot file or
 * directory, or is not a regular file. Decoded first, as the browser encoded
 * it, so the file checked is the file served.
 */
export function publicBuildFile(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const base = resolve(root);
  const file = resolve(base, `.${decoded}`);
  // Native separator: `resolve` answers with backslashes on Windows.
  if (!file.startsWith(`${base}${sep}`)) return undefined;
  if (!isPublicBuildPath(relative(base, file))) return undefined;
  if (!existsSync(file) || !statSync(file).isFile()) return undefined;
  return file;
}

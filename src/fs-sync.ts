// The file primitives the workspace materialization and the dev watcher both
// use: comparing, copying, mirroring and pruning directories.
//
// They live in their own module because both callers need them; putting them
// in either one made the two import each other.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { layerCopyIgnore, PNPM_LIFECYCLE_SCRIPTS } from "./config";

/**
 * Strip the Windows extended-length path prefix (`\\?\`). Node's `cpSync`
 * hands the filter callback the source of top-level entries in this device
 * form (e.g. `\\?\C:\...\tsconfig.json`). Since `src` carries no such
 * prefix, `relative()` cannot relativize the two and returns the full
 * absolute path instead of a layer-relative one — so the blocklist match
 * silently misses the module's root `tsconfig.json` and copies it. POSIX never
 * sees this prefix.
 */
export function stripExtendedLengthPrefix(p: string): string {
  return p.replace(/^\\\\\?\\/, "");
}

/**
 * Rewrite a native path onto POSIX separators.
 *
 * For the places where a path stops being something Node opens and becomes
 * text instead: a module specifier, a glob pattern, a CSS `@source` directive.
 * All three read a backslash as an escape character rather than a separator,
 * so a native Windows path inlined into them is silently mangled.
 *
 * A backslash is a legal character in a POSIX filename, so the rewrite is
 * conditioned on the platform separator rather than applied blindly — the same
 * rule as Vite's `normalizePath`, which the generated Vite configs use and
 * which the CLI cannot import (`vite` is a development dependency here, not a
 * runtime one).
 *
 * @param path The path to rewrite
 * @param separator The platform separator, overridable so the Windows
 * behaviour stays testable from a POSIX host
 * @returns The path with POSIX separators
 */
export function toPosixPath(path: string, separator: string = sep): string {
  return separator === "/" ? path : path.split(separator).join("/");
}

/**
 * True when `srcPath` (an absolute path under `src`) matches any
 * gitignore-style pattern in `LAYER_COPY_BLOCKLIST`. Used by both
 * `copyLayerSource` (via `cpSync`'s filter) and the dev watcher (via
 * chokidar's `ignored`) to guarantee a single source of truth.
 */
export function isBlocklistedCopyPath(src: string, srcPath: string): boolean {
  const rel = relative(
    resolve(stripExtendedLengthPrefix(src)),
    resolve(stripExtendedLengthPrefix(srcPath)),
  );
  if (!rel || rel.startsWith("..")) return false;
  // `ignore` expects POSIX separators; on Windows `relative()` yields `\`.
  return layerCopyIgnore.ignores(toPosixPath(rel));
}

export function sanitizedPackageContent(raw: string): string {
  const pkg = JSON.parse(raw);
  delete pkg.devDependencies;
  if (pkg.scripts) {
    for (const name of PNPM_LIFECYCLE_SCRIPTS) {
      delete pkg.scripts[name];
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * True when `srcPath` and `destPath` both exist as files holding
 * byte-identical content. Lets callers skip rewrites that would only
 * churn the destination's mtime: a no-op rewrite of a module entry, an email
 * template, or any watched module file otherwise forces a full Vite rebuild.
 */
export function filesIdentical(srcPath: string, destPath: string): boolean {
  if (!existsSync(destPath)) return false;
  try {
    const a = statSync(srcPath);
    const b = statSync(destPath);
    if (!a.isFile() || !b.isFile()) return false;
    if (a.size !== b.size) return false;
    return readFileSync(srcPath).equals(readFileSync(destPath));
  } catch {
    return false;
  }
}

/**
 * In-memory analogue of `applyFile`: write `content` to `destPath` atomically
 * and only when it differs from what is already there. Used when the
 * destination is a *transformed* copy of the source (e.g. a stripped
 * package.json) — `applyFile` would always copy in that case because the
 * on-disk dest is never byte-identical to the untransformed source, defeating
 * the content-gate for that file.
 */
export function applyContent(content: string, destPath: string): void {
  const buf = Buffer.from(content);
  if (existsSync(destPath)) {
    try {
      if (readFileSync(destPath).equals(buf)) return;
    } catch {
      // unreadable dest — fall through and overwrite
    }
  }
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.ajs-dms-tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, buf);
    renameSync(tmp, destPath);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

/**
 * Copy `srcPath` -> `destPath` atomically and only when the bytes differ.
 * Writes to a temp sibling then `rename`s into place, so a reader (e.g.
 * unimport's export scanner during `regenerateImports`) never observes a
 * half-written file — the root of the `ENOENT ... scanExports` crashes.
 */
export function applyFile(srcPath: string, destPath: string): void {
  if (filesIdentical(srcPath, destPath)) return;
  mkdirSync(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.ajs-dms-tmp-${process.pid}-${Date.now()}`;
  try {
    cpSync(srcPath, tmp, { force: true, dereference: true });
    renameSync(tmp, destPath);
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  }
}

function loadGitignore(layerPath: string): ReturnType<typeof ignore> {
  const ig = ignore();
  const gitignorePath = join(layerPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf-8"));
  }
  return ig;
}

export function collectFiles(dir: string, baseDir: string = dir): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const { relative } = require("node:path");
    const relPath = relative(baseDir, fullPath);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, baseDir));
    } else {
      files.push(relPath);
    }
  }
  return files;
}

export function syncDirectories(src: string, dest: string): void {
  const ig = loadGitignore(src);
  const srcFiles = collectFiles(src).filter((f: string) => !ig.ignores(f));
  const destFiles = collectFiles(dest);

  // Content-gated + atomic upserts first: unchanged files keep their mtime
  // so an incremental re-sync doesn't churn the whole tree (and trip a full
  // Vite rebuild) when only a handful of files actually changed.
  for (const file of srcFiles) {
    applyFile(join(src, file), join(dest, file));
  }

  // Deletions last, mirroring the watcher's apply order.
  for (const file of destFiles) {
    if (ig.ignores(file)) continue;
    if (!srcFiles.includes(file)) {
      rmSync(join(dest, file), { force: true });
    }
  }

  cleanEmptyDirs(dest);
}

function cleanEmptyDirs(dir: string): void {
  const { statSync } = require("node:fs");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cleanEmptyDirs(full);
  }

  if (readdirSync(dir).length === 0) {
    rmSync(dir, { recursive: true, force: true });
  }
}

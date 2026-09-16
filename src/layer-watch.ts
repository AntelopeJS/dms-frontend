// Watching the layer sources in dev and mirroring their changes into the
// materialized workspace.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { getLayerWorkspacePath } from "./layers";

import { ResolvedLayer } from "./workspace";
import {
  applyContent,
  applyFile,
  isBlocklistedCopyPath,
  sanitizedPackageContent,
} from "./fs-sync";

// ============================================================================
// Constants
// ============================================================================

const WATCH_DEBOUNCE_MS = 80;

/**
 * Per-layer event batcher. Watcher events are coalesced over
 * `WATCH_DEBOUNCE_MS` and applied as one ordered pass: create dirs, upsert
 * files (content-gated + atomic), then deletions LAST. Applying deletes
 * last — and only when the entry is truly gone from the source — means a
 * rapid delete+recreate (common during editor saves and re-materialize)
 * never leaves the workspace tree transiently missing a file the Vite importer
 * is mid-scan over.
 */
function createLayerSync(src: string, dest: string) {
  const fileUpserts = new Set<string>();
  const fileDeletes = new Set<string>();
  const dirCreates = new Set<string>();
  const dirDeletes = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const toRel = (p: string): string | null => {
    const r = relative(src, p);
    return r ? r : null;
  };

  // Per-entry isolation: a single file racing the flush (deleted between the
  // existsSync guard and the copy, or a locked dest on Windows) must not abort
  // the rest of the batch — and crucially must not escape as an uncaught
  // exception out of the setTimeout(flush) callback, which would crash the dev
  // process (there is no global uncaughtException handler). Log and continue.
  const warnFailure = (rel: string, err: unknown): void => {
    console.warn(`[ajs-dms] layer sync skipped ${rel}:`, err);
  };

  const flush = (): void => {
    timer = null;
    for (const rel of [...dirCreates].sort((a, b) => a.length - b.length)) {
      try {
        mkdirSync(join(dest, rel), { recursive: true });
      } catch (err) {
        warnFailure(rel, err);
      }
    }
    dirCreates.clear();
    for (const rel of fileUpserts) {
      try {
        const srcPath = join(src, rel);
        if (!existsSync(srcPath)) continue; // vanished before flush
        const destPath = join(dest, rel);
        if (rel === "package.json") {
          // dest is the post-stripped form, so applyFile would always copy
          // (src still has its scripts); gate on the stripped bytes instead so
          // an unchanged package.json doesn't churn the dest mtime.
          applyContent(
            sanitizedPackageContent(readFileSync(srcPath, "utf-8")),
            destPath,
          );
        } else {
          applyFile(srcPath, destPath);
        }
      } catch (err) {
        warnFailure(rel, err);
      }
    }
    fileUpserts.clear();
    for (const rel of fileDeletes) {
      try {
        if (existsSync(join(src, rel))) continue; // re-created; keep
        const destPath = join(dest, rel);
        if (existsSync(destPath)) rmSync(destPath, { force: true });
      } catch (err) {
        warnFailure(rel, err);
      }
    }
    fileDeletes.clear();
    for (const rel of [...dirDeletes].sort((a, b) => b.length - a.length)) {
      try {
        if (existsSync(join(src, rel))) continue;
        const destPath = join(dest, rel);
        if (existsSync(destPath))
          rmSync(destPath, { recursive: true, force: true });
      } catch (err) {
        warnFailure(rel, err);
      }
    }
    dirDeletes.clear();
  };

  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS);
  };

  return {
    upsertFile(p: string) {
      const r = toRel(p);
      if (!r) return;
      fileDeletes.delete(r);
      fileUpserts.add(r);
      arm();
    },
    deleteFile(p: string) {
      const r = toRel(p);
      if (!r) return;
      fileUpserts.delete(r);
      fileDeletes.add(r);
      arm();
    },
    createDir(p: string) {
      const r = toRel(p);
      if (!r) return;
      dirDeletes.delete(r);
      dirCreates.add(r);
      arm();
    },
    deleteDir(p: string) {
      const r = toRel(p);
      if (!r) return;
      dirCreates.delete(r);
      dirDeletes.add(r);
      arm();
    },
    flushNow() {
      if (timer) clearTimeout(timer);
      flush();
    },
  };
}

/**
 * Start one chokidar watcher per layer that mirrors filesystem changes
 * from the frontend-module source tree into its materialized copy inside the
 * workspace. Vite HMR then picks up the change through the workspace
 * copy exactly as if we were developing inside the workspace itself.
 *
 * Returns an async stop function that flushes any pending batch and closes
 * every watcher. Callers should invoke it on SIGINT/SIGTERM and before
 * exiting.
 *
 * Why this exists: we copy layer sources into the workspace instead of
 * symlinking (pnpm follows realpath for workspace packages, so a symlink
 * would make it install transitive deps in the source directory and
 * defeat the whole fix). The copy means HMR is blind to edits in the real
 * source tree — the watcher closes that gap by propagating every change
 * through a debounced, content-gated, atomic applier (see
 * `createLayerSync`).
 */
export function startLayerWatchers(
  workspaceDir: string,
  layers: ResolvedLayer[],
): () => Promise<void> {
  const watchers: FSWatcher[] = [];
  const syncs: Array<ReturnType<typeof createLayerSync>> = [];

  for (const layer of layers) {
    if (!layer.packageName) continue;
    const dest = getLayerWorkspacePath(workspaceDir, layer);
    const src = layer.path;
    const sync = createLayerSync(src, dest);
    syncs.push(sync);

    const watcher = chokidar.watch(src, {
      ignoreInitial: true,
      ignored: (path: string) => isBlocklistedCopyPath(src, path),
      persistent: true,
    });

    watcher.on("add", (p) => sync.upsertFile(p));
    watcher.on("change", (p) => sync.upsertFile(p));
    watcher.on("unlink", (p) => sync.deleteFile(p));
    watcher.on("addDir", (p) => sync.createDir(p));
    watcher.on("unlinkDir", (p) => sync.deleteDir(p));

    watchers.push(watcher);
  }

  return async () => {
    await Promise.all(watchers.map((w) => w.close().catch(() => {})));
    for (const sync of syncs) sync.flushNow();
  };
}

// ============================================================================
// Directory Sync Utilities (for ZIP extract preserving mode)
// ============================================================================

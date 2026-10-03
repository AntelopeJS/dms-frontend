// Watching the layer sources in dev and mirroring their changes into the
// materialized workspace.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { getProcessUi, type Ui } from "@antelopejs/core/cli";
import chokidar, { type FSWatcher } from "chokidar";
import { getLayerWorkspacePath } from "./layers";
import {
  createFrontendModuleRegistry,
  DERIVED_OUTPUTS,
  type DerivedOutput,
  type FrontendModuleRegistry,
} from "./derived-outputs";

import { failureDetails } from "./output";
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
 * Delay between the last pass that touched the sources of a derived output and
 * its regeneration, shared by every layer. It must stay above the 50 ms during
 * which Vite's file watcher (chokidar, without FSEvents, so on Linux) drops a
 * second change to the same file: two regenerations closer than that would
 * leave the dev server on the first one.
 */
const DERIVED_REFRESH_DEBOUNCE_MS = 100;

/** Reports a failure the watcher survives, with the error that caused it. */
type WarnFunction = (message: string, error?: unknown) => void;

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * Per-layer event batcher. Watcher events are coalesced over
 * `WATCH_DEBOUNCE_MS` and applied as one ordered pass: create dirs, upsert
 * files (content-gated + atomic), then deletions LAST. Applying deletes
 * last — and only when the entry is truly gone from the source — means a
 * rapid delete+recreate (common during editor saves and re-materialize)
 * never leaves the workspace tree transiently missing a file the Vite importer
 * is mid-scan over. `onFlushed` then receives every path the pass touched.
 */
function createLayerSync(
  src: string,
  dest: string,
  onFlushed: (paths: string[]) => void,
  warn: WarnFunction,
) {
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
    warn(`Layer sync skipped ${rel}`, err);
  };

  const flush = (): void => {
    timer = null;
    const touched = [
      ...dirCreates,
      ...fileUpserts,
      ...fileDeletes,
      ...dirDeletes,
    ];
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
    onFlushed(touched);
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
 * Regenerate the derived outputs whose sources the passes touched, from the
 * workspace copies, once those passes have settled. Each output merges every
 * layer, so passes of several layers flushed together (a checkout, an editor
 * saving several files) make one regeneration per output with all of their
 * changes, and an output no pass touched is left alone. Only the files whose
 * content changed are rewritten, and Vite's own watcher takes it from there,
 * except for an output it reads at startup only: that one says a restart is
 * needed.
 */
function createDerivedOutputRefresher(
  workspaceDir: string,
  layers: ResolvedLayer[],
  warn: WarnFunction,
) {
  const pending = new Set<DerivedOutput>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const regenerate = (
    output: DerivedOutput,
    registry: FrontendModuleRegistry,
  ): void => {
    try {
      if (output.write(workspaceDir, registry) && output.restartNotice)
        warn(output.restartNotice);
    } catch (err) {
      // Same reason as `warnFailure`: a file saved half-written, a catalog
      // for instance, must not take the dev process down. The previous
      // output stays in place.
      warn(`${capitalize(output.name)} not regenerated`, err);
    }
  };

  const refresh = (): void => {
    timer = null;
    const outputs = DERIVED_OUTPUTS.filter((output) => pending.has(output));
    pending.clear();
    let registry: FrontendModuleRegistry;
    try {
      // Built again: a module may have added or removed its entry since.
      registry = createFrontendModuleRegistry(workspaceDir, layers);
    } catch (err) {
      warn("Derived files not regenerated", err);
      return;
    }
    for (const output of outputs) regenerate(output, registry);
  };

  return {
    schedule(paths: string[]) {
      const affected = DERIVED_OUTPUTS.filter((output) =>
        paths.some((path) => output.affects(path)),
      );
      if (affected.length === 0) return;
      for (const output of affected) pending.add(output);
      if (timer) clearTimeout(timer);
      timer = setTimeout(refresh, DERIVED_REFRESH_DEBOUNCE_MS);
    },
    flushNow() {
      if (!timer) return;
      clearTimeout(timer);
      refresh();
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
 *
 * Mirroring is not enough for the files materialization derives from every
 * module (the locale catalogs, the public assets, the aggregated shortcuts,
 * the module loader and the type paths): the app reads those, never a
 * module's own copy, so a pass that touches their sources regenerates them
 * (see `createDerivedOutputRefresher`).
 */
export function startLayerWatchers(
  workspaceDir: string,
  layers: ResolvedLayer[],
  ui: Ui = getProcessUi(),
): () => Promise<void> {
  const warn: WarnFunction = (message, error) =>
    ui.message("warn", message, {
      details: error === undefined ? [] : failureDetails(error, ui),
    });
  const watchers: FSWatcher[] = [];
  const syncs: Array<ReturnType<typeof createLayerSync>> = [];
  const refresher = createDerivedOutputRefresher(workspaceDir, layers, warn);

  for (const layer of layers) {
    if (!layer.packageName) continue;
    const dest = getLayerWorkspacePath(workspaceDir, layer);
    const src = layer.path;
    const sync = createLayerSync(
      src,
      dest,
      (paths) => refresher.schedule(paths),
      warn,
    );
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
    refresher.flushNow();
  };
}

// ============================================================================
// Directory Sync Utilities (for ZIP extract preserving mode)
// ============================================================================

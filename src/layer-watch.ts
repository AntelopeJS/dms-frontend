// Watching the layer sources in dev and mirroring their changes into the
// materialized workspace.
//
// Split out of common.ts, which stays the barrel every command imports from.

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getProcessUi, isQuietRun, type Ui } from "@antelopejs/core/cli";
import chokidar, { type FSWatcher } from "chokidar";
import { createPathMapper, type PathMapper } from "./child-output";
import { getLayerWorkspacePath } from "./layers";
import {
  createFrontendModuleRegistry,
  DERIVED_OUTPUTS,
  type DerivedOutput,
  type FrontendModuleRegistry,
  InvalidLocaleFileError,
} from "./derived-outputs";

import {
  failureDetails,
  formatTimedMessage,
  showPath,
  type TimedMessageOptions,
  writeFeedback,
} from "./output";
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

/**
 * What the watcher tells the user while dev runs: a failure it survives, the
 * save that fixed it, a change that needs a restart.
 */
interface WatchReporter {
  warn(text: string, options?: TimedMessageOptions): void;
  succeed(text: string): void;
  /** The lines of an error, with workspace paths shown as their sources. */
  describe(error: unknown): string[];
  /** A path into the layer sources, as the user reads it. */
  show(path: string): string;
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * The entries of a layer a pass failed to apply: each failure is reported,
 * and confirmed over once a later pass applies the entry.
 */
function createSyncFailures(src: string, reporter: WatchReporter) {
  const failed = new Set<string>();
  const show = (rel: string) => reporter.show(join(src, rel));
  return {
    fail(rel: string, err: unknown): void {
      failed.add(rel);
      reporter.warn(`${show(rel)} not copied to the workspace`, {
        details: [
          ...reporter.describe(err),
          "The dev server keeps its previous version until the next save.",
        ],
      });
    },
    applied(rel: string): void {
      if (failed.delete(rel))
        reporter.succeed(`${show(rel)} copied to the workspace`);
    },
  };
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
  reporter: WatchReporter,
) {
  const fileUpserts = new Set<string>();
  const fileDeletes = new Set<string>();
  const dirCreates = new Set<string>();
  const dirDeletes = new Set<string>();
  const failures = createSyncFailures(src, reporter);
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
        failures.applied(rel);
      } catch (err) {
        failures.fail(rel, err);
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
        failures.applied(rel);
      } catch (err) {
        failures.fail(rel, err);
      }
    }
    fileUpserts.clear();
    for (const rel of fileDeletes) {
      try {
        if (existsSync(join(src, rel))) continue; // re-created; keep
        const destPath = join(dest, rel);
        if (existsSync(destPath)) rmSync(destPath, { force: true });
        failures.applied(rel);
      } catch (err) {
        failures.fail(rel, err);
      }
    }
    fileDeletes.clear();
    for (const rel of [...dirDeletes].sort((a, b) => b.length - a.length)) {
      try {
        if (existsSync(join(src, rel))) continue;
        const destPath = join(dest, rel);
        if (existsSync(destPath))
          rmSync(destPath, { recursive: true, force: true });
        failures.applied(rel);
      } catch (err) {
        failures.fail(rel, err);
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

/** What a regeneration that failed said, and what to say once one succeeds. */
interface OutputFailure {
  text: string;
  options: TimedMessageOptions;
  fixed: string;
}

function describeOutputFailure(
  output: DerivedOutput,
  err: unknown,
  reporter: WatchReporter,
): OutputFailure {
  const kept = `The dev server keeps the previous ${output.name} until the file is fixed.`;
  if (err instanceof InvalidLocaleFileError) {
    const file = reporter.show(err.path);
    return {
      text: `${file} is not a valid locale file`,
      options: { details: [err.reason, kept] },
      fixed: [`${file} fixed`, `${output.name} regenerated`].join(
        getProcessUi().symbols.separator,
      ),
    };
  }
  return {
    text: `${capitalize(output.name)} not regenerated`,
    options: { details: [...reporter.describe(err), kept] },
    fixed: `${capitalize(output.name)} regenerated`,
  };
}

/**
 * The warning for layer directories added or removed while dev runs, which
 * only a restart applies.
 */
function describeLayerDirectories(
  paths: string[],
  reporter: WatchReporter,
): string {
  // A new `layers/extra` brings `layers` with it: name the layer only.
  const layers = [...new Set(paths)].filter(
    (path) => !paths.some((other) => other.startsWith(`${path}${sep}`)),
  );
  const shown = layers.map((path) => reporter.show(path));
  if (shown.length !== 1)
    return `Layer directories added or removed: ${shown.join(", ")}`;
  return existsSync(layers[0])
    ? `New layer directory ${shown[0]}`
    : `Layer directory ${shown[0]} removed`;
}

/**
 * Regenerate the derived outputs whose sources the passes touched, from the
 * workspace copies, once those passes have settled. Each output merges every
 * layer, so passes of several layers flushed together (a checkout, an editor
 * saving several files) make one regeneration per output with all of their
 * changes, and an output no pass touched is left alone. Only the files whose
 * content changed are rewritten, and Vite's own watcher takes it from there,
 * except for an output it reads at startup only: that one says, once per
 * run, that a restart is needed.
 *
 * A regeneration that fails leaves the previous output in place and says so;
 * the one that succeeds next says the failure is over.
 */
function createDerivedOutputRefresher(
  workspaceDir: string,
  layers: ResolvedLayer[],
  reporter: WatchReporter,
) {
  /** Each pending output, with the touched source paths it depends on. */
  const pending = new Map<DerivedOutput, string[]>();
  const failures = new Map<DerivedOutput | "registry", OutputFailure>();
  let hasRestartNotice = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const fail = (key: DerivedOutput | "registry", failure: OutputFailure) => {
    failures.set(key, failure);
    reporter.warn(failure.text, failure.options);
  };
  const recover = (key: DerivedOutput | "registry") => {
    const failure = failures.get(key);
    if (!failure) return;
    failures.delete(key);
    reporter.succeed(failure.fixed);
  };

  const noticeRestart = (output: DerivedOutput, paths: string[]): void => {
    if (!output.restartHint || hasRestartNotice) return;
    hasRestartNotice = true;
    reporter.warn(describeLayerDirectories(paths, reporter), {
      fixes: [output.restartHint],
    });
  };

  const regenerate = (
    output: DerivedOutput,
    paths: string[],
    registry: FrontendModuleRegistry,
  ): void => {
    try {
      const isChanged = output.write(workspaceDir, registry);
      recover(output);
      if (isChanged) noticeRestart(output, paths);
    } catch (err) {
      // Same reason as the layer sync's: a file saved half-written, a catalog
      // for instance, must not take the dev process down. The previous
      // output stays in place.
      fail(output, describeOutputFailure(output, err, reporter));
    }
  };

  const refresh = (): void => {
    timer = null;
    const outputs = DERIVED_OUTPUTS.filter((output) => pending.has(output)).map(
      (output) => [output, pending.get(output) ?? []] as const,
    );
    pending.clear();
    let registry: FrontendModuleRegistry;
    try {
      // Built again: a module may have added or removed its entry since.
      registry = createFrontendModuleRegistry(workspaceDir, layers);
      recover("registry");
    } catch (err) {
      fail("registry", {
        text: "Derived files not regenerated",
        options: {
          details: [
            ...reporter.describe(err),
            "The dev server keeps the previous ones until the module is fixed.",
          ],
        },
        fixed: "Derived files regenerated",
      });
      return;
    }
    for (const [output, paths] of outputs) regenerate(output, paths, registry);
  };

  return {
    /** `paths` are relative to `src`, the layer source they were touched in. */
    schedule(src: string, paths: string[]) {
      let isAffected = false;
      for (const output of DERIVED_OUTPUTS) {
        const affected = paths.filter((path) => output.affects(path));
        if (affected.length === 0) continue;
        isAffected = true;
        pending.set(output, [
          ...(pending.get(output) ?? []),
          ...affected.map((path) => join(src, path)),
        ]);
      }
      if (!isAffected) return;
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
 * A quiet run keeps the warnings and leaves out the notices that say a
 * failure is over, as the core leaves out its success messages.
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
  write: (text: string) => void = writeFeedback,
  isQuiet: boolean = isQuietRun(),
): () => Promise<void> {
  // The watched layers are their own sources: workspace paths in messages
  // name the files the user edits.
  const mapPath: PathMapper = createPathMapper(
    workspaceDir,
    layers.map((layer) => ({ ...layer, sourcePath: layer.path })),
  );
  const reporter: WatchReporter = {
    warn: (text, options) =>
      write(formatTimedMessage("warn", text, options, ui)),
    succeed: (text) => {
      if (!isQuiet) write(formatTimedMessage("success", text, {}, ui));
    },
    describe: (error) => failureDetails(error, ui).map((line) => mapPath(line)),
    show: (path) => {
      const mapped = mapPath(path);
      return mapped === path ? showPath(path) : mapped;
    },
  };
  const watchers: FSWatcher[] = [];
  const syncs: Array<ReturnType<typeof createLayerSync>> = [];
  const refresher = createDerivedOutputRefresher(
    workspaceDir,
    layers,
    reporter,
  );

  for (const layer of layers) {
    if (!layer.packageName) continue;
    const dest = getLayerWorkspacePath(workspaceDir, layer);
    const src = layer.path;
    const sync = createLayerSync(
      src,
      dest,
      (paths) => refresher.schedule(src, paths),
      reporter,
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

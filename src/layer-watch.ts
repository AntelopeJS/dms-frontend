import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { getProcessUi, isQuietRun, type Ui } from "@antelopejs/core/cli";
import chokidar, { type FSWatcher } from "chokidar";
import { createPathMapper, type PathMapper } from "./child-output";
import { FRONTEND_BUILD_ENTRY } from "./config";
import { getLayerWorkspacePath } from "./layers";
import {
  createFrontendModuleRegistry,
  DERIVED_OUTPUTS,
  type DerivedOutput,
  type FrontendModuleRegistry,
} from "./derived-outputs";
import { InvalidLocaleFileError } from "./locale-files";

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
  sanitizedBuildDeclaration,
  sanitizedPackageContent,
} from "./fs-sync";

/**
 * Quiet time after the last watcher event, of any layer, before the pass that
 * applies them all.
 */
const WATCH_DEBOUNCE_MS = 80;

/**
 * Least time between a pass that regenerated a derived output and the next
 * pass. It must stay above the 50 ms during which Vite's file watcher
 * (chokidar, without FSEvents, so on Linux) drops a second change to the same
 * file: two regenerations closer than that would leave the dev server on the
 * first one.
 */
const DERIVED_REFRESH_GAP_MS = 100;

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
    fail(rel: string, errorLines: string[]): void {
      failed.add(rel);
      reporter.warn(`${show(rel)} not copied to the workspace`, {
        details: [
          ...errorLines,
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
 * Per-layer event stager. Watcher events are coalesced, with those of every
 * other layer, over `WATCH_DEBOUNCE_MS` (see `createPassScheduler`) and
 * applied as one ordered pass: create dirs, upsert files (content-gated +
 * atomic), then deletions LAST. Applying deletes last — and only when the
 * entry is truly gone from the source — means a rapid delete+recreate (common
 * during editor saves and re-materialize) never leaves the workspace tree
 * transiently missing a file the Vite importer is mid-scan over. A pass may
 * apply a layer's changes in two rounds (see `runPass`), each in that order.
 *
 * Each file is isolated: one racing the pass (deleted between the `existsSync`
 * guard and the copy, or a locked destination on Windows) must not abort the
 * rest of the batch, and must not escape as an uncaught exception out of the
 * `setTimeout(flush)` callback, which would crash the dev process (there is no
 * global uncaughtException handler). The failure is logged and the pass
 * continues.
 *
 * `package.json` is gated on its stripped bytes: the destination holds the
 * post-stripped form, so a plain copy would always rewrite it (the source still
 * has its scripts) and churn the destination mtime. The frontend build
 * declaration is likewise compared in its rewritten form.
 */
function createLayerSync(
  src: string,
  dest: string,
  reporter: WatchReporter,
  onStaged: () => void,
) {
  const fileUpserts = new Set<string>();
  const fileDeletes = new Set<string>();
  const dirCreates = new Set<string>();
  const dirDeletes = new Set<string>();
  const failures = createSyncFailures(src, reporter);

  const toRel = (p: string): string | null => {
    const r = relative(src, p);
    return r ? r : null;
  };

  /** Removes the staged entries `select` picks, and returns them. */
  const take = (
    staged: Set<string>,
    select: (rel: string) => boolean,
  ): string[] => {
    const taken = [...staged].filter(select);
    for (const rel of taken) staged.delete(rel);
    return taken;
  };

  const upsert = (rel: string): void => {
    try {
      const srcPath = join(src, rel);
      if (!existsSync(srcPath)) return;
      const destPath = join(dest, rel);
      if (rel === "package.json") {
        applyContent(
          sanitizedPackageContent(readFileSync(srcPath, "utf-8")),
          destPath,
        );
      } else if (rel === FRONTEND_BUILD_ENTRY) {
        applyContent(
          sanitizedBuildDeclaration(readFileSync(srcPath, "utf-8")),
          destPath,
        );
      } else {
        applyFile(srcPath, destPath);
      }
      failures.applied(rel);
    } catch (err) {
      failures.fail(rel, reporter.describe(err));
    }
  };

  const remove = (rel: string, recursive: boolean): void => {
    try {
      if (existsSync(join(src, rel))) return;
      const destPath = join(dest, rel);
      if (existsSync(destPath)) rmSync(destPath, { recursive, force: true });
      failures.applied(rel);
    } catch (err) {
      failures.fail(rel, reporter.describe(err));
    }
  };

  const stage = (p: string, add: Set<string>, cancel: Set<string>): void => {
    const r = toRel(p);
    if (!r) return;
    cancel.delete(r);
    add.add(r);
    onStaged();
  };

  return {
    src,
    upsertFile: (p: string) => stage(p, fileUpserts, fileDeletes),
    deleteFile: (p: string) => stage(p, fileDeletes, fileUpserts),
    createDir: (p: string) => stage(p, dirCreates, dirDeletes),
    deleteDir: (p: string) => stage(p, dirDeletes, dirCreates),
    /** Every path the next pass touches, relative to `src`. */
    pending(): string[] {
      return [...dirCreates, ...fileUpserts, ...fileDeletes, ...dirDeletes];
    },
    /** Creates every staged directory, parents first. */
    createDirs(): void {
      for (const rel of take(dirCreates, () => true).sort(
        (a, b) => a.length - b.length,
      )) {
        try {
          mkdirSync(join(dest, rel), { recursive: true });
          failures.applied(rel);
        } catch (err) {
          failures.fail(rel, reporter.describe(err));
        }
      }
    },
    /** Applies the staged file and directory changes `select` picks. */
    apply(select: (rel: string) => boolean): void {
      for (const rel of take(fileUpserts, select)) upsert(rel);
      for (const rel of take(fileDeletes, select)) remove(rel, false);
      for (const rel of take(dirDeletes, select).sort(
        (a, b) => b.length - a.length,
      ))
        remove(rel, true);
    },
  };
}

type LayerSync = ReturnType<typeof createLayerSync>;

/** What a regeneration that failed said, and what to say once one succeeds. */
interface OutputFailure {
  text: string;
  options: TimedMessageOptions;
  fixed: string;
}

/**
 * The warning for layer directories added or removed while dev runs, which
 * only a restart applies.
 *
 * A new `layers/extra` brings `layers` with it, so only the layer is named.
 */
function describeLayerDirectories(
  paths: string[],
  reporter: WatchReporter,
): string {
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
 * Regenerate the derived outputs whose sources a pass touched, from the
 * workspace copies. A pass applies the changes of every layer at once, so a
 * checkout or an editor saving several files makes one regeneration per output
 * with all of them, and an output the pass did not touch is left alone. Only
 * the files whose content changed are rewritten, and Vite's own watcher takes
 * it from there, except for an output it reads at startup only: that one says,
 * once per run, that a restart is needed.
 *
 * A regeneration that fails leaves the previous output in place and says so;
 * the one that succeeds next says the failure is over.
 *
 * Same reason as the layer sync's: a file saved half-written, a catalog for
 * instance, must not take the dev process down. The previous output stays in
 * place.
 *
 * The registry is built again because a module may have added or removed its
 * entry since.
 */
function createDerivedOutputRefresher(
  workspaceDir: string,
  layers: ResolvedLayer[],
  reporter: WatchReporter,
) {
  const failures = new Map<DerivedOutput | "registry", OutputFailure>();
  let hasRestartNotice = false;

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
  ): boolean => {
    try {
      const isChanged = output.write(workspaceDir, registry);
      recover(output);
      if (isChanged) noticeRestart(output, paths);
      return isChanged;
    } catch (err) {
      const kept = `The dev server keeps the previous ${output.name} until the file is fixed.`;
      if (err instanceof InvalidLocaleFileError) {
        const file = reporter.show(err.path);
        fail(output, {
          text: `${file} is not a valid locale file`,
          options: { details: [...err.reason.split("\n"), kept] },
          fixed: [`${file} fixed`, `${output.name} regenerated`].join(
            getProcessUi().symbols.separator,
          ),
        });
      } else {
        fail(output, {
          text: `${capitalize(output.name)} not regenerated`,
          options: { details: [...reporter.describe(err), kept] },
          fixed: `${capitalize(output.name)} regenerated`,
        });
      }
      return false;
    }
  };

  const buildRegistry = (): FrontendModuleRegistry | undefined => {
    try {
      const registry = createFrontendModuleRegistry(workspaceDir, layers);
      recover("registry");
      return registry;
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
      return undefined;
    }
  };

  return {
    /**
     * Prepares the regenerations of a pass, before it copies anything.
     * `touched` holds, for each layer source, the paths relative to it that
     * the pass touches. Returns what writes the outputs `select` picks among
     * those, and tells whether any changed.
     */
    plan(
      touched: ReadonlyArray<{ src: string; paths: string[] }>,
    ): (select: (output: DerivedOutput) => boolean) => boolean {
      const pending = new Map<DerivedOutput, string[]>();
      for (const output of DERIVED_OUTPUTS) {
        const affected = touched.flatMap(({ src, paths }) =>
          paths
            .filter((path) => output.affects(path))
            .map((path) => join(src, path)),
        );
        if (affected.length > 0) pending.set(output, affected);
      }
      const registry = pending.size > 0 ? buildRegistry() : undefined;
      return (select) => {
        let isChanged = false;
        if (!registry) return isChanged;
        for (const [output, paths] of pending) {
          if (select(output))
            isChanged = regenerate(output, paths, registry) || isChanged;
        }
        return isChanged;
      };
    },
  };
}

type DerivedOutputRefresher = ReturnType<typeof createDerivedOutputRefresher>;

/** Whether a change at `relativePath` feeds an output that reads it as data. */
function isReadAsData(relativePath: string): boolean {
  return DERIVED_OUTPUTS.some(
    (output) => output.readsSourcesAsData && output.affects(relativePath),
  );
}

/**
 * Apply what every layer staged, and regenerate the derived outputs it
 * affects, in an order that never shows the dev server a file referring to
 * one not written yet. The sources an output reads as data, a public file or a
 * catalog, are copied and that output regenerated first: a component or an
 * app config saved with them, which may name the new file or translation, is
 * copied after, so the page Vite updates never asks for a file the dev server
 * does not serve yet. The outputs that import module copies, the module loader
 * or the app configs, come last, once the copies they import are in place.
 *
 * Returns whether a derived output changed.
 */
function runPass(
  syncs: LayerSync[],
  refresher: DerivedOutputRefresher,
): boolean {
  const writeOutputs = refresher.plan(
    syncs.map((sync) => ({ src: sync.src, paths: sync.pending() })),
  );
  const isDataOutput = (output: DerivedOutput) =>
    output.readsSourcesAsData === true;
  for (const sync of syncs) sync.createDirs();
  for (const sync of syncs) sync.apply(isReadAsData);
  const isDataChanged = writeOutputs(isDataOutput);
  for (const sync of syncs) sync.apply((path) => !isReadAsData(path));
  const isChanged = writeOutputs((output) => !isDataOutput(output));
  return isDataChanged || isChanged;
}

/**
 * Runs `pass` once the watchers have been quiet for `WATCH_DEBOUNCE_MS`, and
 * never within `DERIVED_REFRESH_GAP_MS` of a pass that regenerated a derived
 * output. One pass for every layer, rather than one per layer, is what makes
 * the changes of several layers saved together one regeneration.
 */
function createPassScheduler(pass: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRegeneration = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    timer = null;
    if (pass()) lastRegeneration = Date.now();
  };

  return {
    arm: (): void => {
      if (timer) clearTimeout(timer);
      const gap = lastRegeneration + DERIVED_REFRESH_GAP_MS - Date.now();
      timer = setTimeout(flush, Math.max(WATCH_DEBOUNCE_MS, gap));
    },
    flushNow: (): void => {
      if (!timer) return;
      clearTimeout(timer);
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
 * the module loader, the app configs and the type paths): the app reads
 * those, never a module's own copy, so a pass that touches their sources
 * regenerates them (see `createDerivedOutputRefresher` and `runPass`).
 *
 * The watched layers are their own sources: workspace paths in messages name
 * the files the user edits.
 */
export function startLayerWatchers(
  workspaceDir: string,
  layers: ResolvedLayer[],
  ui: Ui = getProcessUi(),
  write: (text: string) => void = writeFeedback,
  isQuiet: boolean = isQuietRun(),
): () => Promise<void> {
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
  const syncs: LayerSync[] = [];
  const refresher = createDerivedOutputRefresher(
    workspaceDir,
    layers,
    reporter,
  );
  const passes = createPassScheduler(() => runPass(syncs, refresher));

  for (const layer of layers) {
    if (!layer.packageName) continue;
    const dest = getLayerWorkspacePath(workspaceDir, layer);
    const src = layer.path;
    const sync = createLayerSync(src, dest, reporter, passes.arm);
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
    passes.flushNow();
  };
}

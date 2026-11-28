import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as nativePath from "node:path";
import { CliError, type CliProblem } from "@antelopejs/core/cli";
import { LAYERS_SUBDIR } from "./config";
import { isJsonObject } from "./internal/json";
import { isPlainObject } from "./internal/plain-object";
import { isTextList } from "./internal/text-list";
import {
  filesystemRoot,
  isAtOrBelow,
  layerTable,
  relocateAutoImports,
  relocateTsconfig,
  type Tsconfig,
  TYPES_ENTRY_FILE,
  typesEntry,
  VUE_SHIMS,
  VUE_SHIMS_FILE,
} from "./prepare-types-relocate";
import { dependencyRoots, readManifest } from "./prepare-types-packages";
import type { ResolvedLayer } from "./common";

type PathApi = typeof nativePath.win32;

/** The file that marks a directory as one `prepare-types` wrote. */
export const TYPES_MARKER = "dms-types.json";

/** The variable `ajs dms prepare-types` passes the runner its `--out` in. */
export const PREPARE_TYPES_OUT_VARIABLE = "DMS_PREPARE_TYPES_OUT";

const INSTALL_DIRECTORY = "node_modules";
const GENERATED_PATHS = "frontend-paths.generated.json";
const WORKSPACE_TSCONFIG = "tsconfig.json";
const AUTO_IMPORTS = "auto-imports.d.ts";
const WORKSPACE_PACKAGE = "package.json";
/** The files the workspace build writes that name the removed copies by their absolute path, which no type check reads. */
const COPY_DESCRIPTIONS = [
  "generated-frontend-modules.json",
  "sfc-global-types.generated.d.ts",
];

function isEmptyDirectory(path: string): boolean {
  return readdirSync(path).length === 0;
}

/**
 * Every problem with the directory `--out` names: one that holds files this
 * command did not write is never emptied, and a workspace under
 * `node_modules` or on another drive than the project loses the
 * auto-imports of the sources it is read with.
 */
export function outputProblems(
  out: string,
  projectDir: string,
  path: PathApi = nativePath,
): CliProblem[] {
  const target = path.resolve(out);
  const problems: CliProblem[] = [];
  if (target.split(path.sep).includes("node_modules"))
    problems.push({
      title: `--out is under node_modules: ${target}`,
      reason: "The auto-importers skip every file under node_modules.",
      fixes: ["Pass a directory outside node_modules, such as .dms-types"],
    });
  const root = (directory: string) =>
    path.parse(path.resolve(directory)).root.toLowerCase();
  if (root(target) !== root(projectDir))
    problems.push({
      title: `--out is on another drive than the project: ${target}`,
      reason: "A workspace on another drive loses the auto-imports.",
      fixes: ["Pass a directory on the drive of the project"],
    });
  const stats = statSync(target, { throwIfNoEntry: false });
  if (stats && !stats.isDirectory())
    problems.push({ title: `--out is not a directory: ${target}` });
  else if (
    stats &&
    !isEmptyDirectory(target) &&
    statSync(path.join(target, TYPES_MARKER), { throwIfNoEntry: false }) ===
      undefined
  )
    problems.push({
      title: `--out is not empty and was not written by prepare-types: ${target}`,
      reason: `A directory it wrote holds a ${TYPES_MARKER} file, and the command replaces such a directory.`,
      fixes: ["Pass an empty or new directory"],
    });
  return problems;
}

/** A directory a run reads from: a module's sources or a local package. */
export interface RunInput {
  /** What the input is named in the error, a package name or its path. */
  label: string;
  path: string;
}

/** Every directory a run reads: each module's sources, named or not, and each local package. */
export function runInputs(
  layers: ResolvedLayer[],
  localPackages: Record<string, string>,
): RunInput[] {
  return [
    ...layers.map((layer) => ({
      label: layer.packageName ?? layer.path,
      path: layer.sourcePath ?? layer.path,
    })),
    ...Object.entries(localPackages).map(([label, path]) => ({ label, path })),
  ];
}

/** `path` with every symlink resolved, those of its existing ancestors when it is missing. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    const absolute = nativePath.resolve(path);
    const parent = nativePath.dirname(absolute);
    if (parent === absolute) return absolute;
    return nativePath.join(realPath(parent), nativePath.basename(absolute));
  }
}

/**
 * Refuses an `out` that is or holds an input of the run, which a reset would
 * then empty. Both sides are compared with their symlinks resolved.
 */
export function assertOutsideSources(out: string, inputs: RunInput[]): void {
  const target = realPath(out);
  const holder = inputs.find(({ path }) => isAtOrBelow(target, realPath(path)));
  if (holder)
    throw new CliError({
      title: `--out holds the sources of ${holder.label}: ${holder.path}`,
      reason: "Writing it again would empty the sources.",
      fixes: ["Pass a directory outside the sources, or below them"],
    });
}

/** Removes everything in `directory` but its `node_modules`. */
function emptyButInstall(directory: string): void {
  for (const entry of readdirSync(directory))
    if (entry !== INSTALL_DIRECTORY)
      rmSync(nativePath.join(directory, entry), {
        recursive: true,
        force: true,
      });
}

/**
 * Removes the sibling `path` of `--out` when it is missing, empty or marked as
 * written by `prepare-types`, and refuses any other.
 */
function removeWrittenSibling(path: string): void {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (
    !stats.isDirectory() ||
    (!isEmptyDirectory(path) &&
      !existsSync(nativePath.join(path, TYPES_MARKER)))
  )
    throw new CliError({
      title: `${path} was not written by prepare-types`,
      reason:
        "The run writes and removes this sibling of --out to replace --out.",
      fixes: ["Move or remove it"],
    });
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Creates the directory a run writes before it takes the place of `out`: the
 * sibling `<out>.next`, emptied of what a failed run left there and holding
 * the marker that lets a later run replace `out` again. A sibling resolves
 * every path relative to it as `out` does.
 *
 * @returns The absolute path of the staging directory
 */
export function resetStaging(out: string): string {
  const staging = `${nativePath.resolve(out)}.next`;
  removeWrittenSibling(staging);
  mkdirSync(staging, { recursive: true });
  writeFileSync(
    nativePath.join(staging, TYPES_MARKER),
    `${JSON.stringify({ command: "ajs dms prepare-types" }, null, 2)}\n`,
  );
  return staging;
}

/**
 * Moves `staging` to the sibling `<target>.next`, on the filesystem of
 * `target`: by a copy when `target` is on another one, such as the directory a
 * symlinked `out` links to on another mount. Symlinks are copied as they are.
 *
 * @returns The path the staged set now sits at
 */
function stageBeside(staging: string, target: string): string {
  const next = `${target}.next`;
  if (realPath(staging) === next) return staging;
  removeWrittenSibling(next);
  try {
    renameSync(staging, next);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EXDEV"))
      throw error;
    try {
      cpSync(staging, next, { recursive: true, verbatimSymlinks: true });
    } catch (copyError) {
      rmSync(next, { recursive: true, force: true, maxRetries: 3 });
      throw copyError;
    }
    rmSync(staging, { recursive: true, force: true, maxRetries: 3 });
  }
  return next;
}

/**
 * Renames `staging` into the place of `out`, or of the directory `out` links
 * to, so a reader beside the run finds the files of the previous run or those
 * of this one, and never a directory being written. When the new set cannot
 * take its place, the previous one is put back.
 */
export function publishStaging(staging: string, out: string): void {
  const target = realPath(out);
  const ready = stageBeside(staging, target);
  const previous = `${target}.previous`;
  removeWrittenSibling(previous);
  if (existsSync(target)) renameSync(target, previous);
  try {
    renameSync(ready, target);
  } catch (error) {
    if (existsSync(previous)) renameSync(previous, target);
    throw error;
  }
  rmSync(previous, { recursive: true, force: true, maxRetries: 3 });
}

function readWorkspaceTsconfig(path: string): Tsconfig {
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    isPlainObject(config) &&
    isJsonObject(config.compilerOptions) &&
    isTextList(config.files) &&
    isTextList(config.include) &&
    isTextList(config.exclude)
  )
    return {
      compilerOptions: config.compilerOptions,
      files: config.files,
      include: config.include,
      exclude: config.exclude,
    };
  throw new CliError({
    title: `${WORKSPACE_TSCONFIG} does not hold compiler options and lists of paths`,
  });
}

function readGeneratedPaths(path: string): Record<string, string[]> {
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  const paths =
    isPlainObject(config) && isPlainObject(config.compilerOptions)
      ? config.compilerOptions.paths
      : undefined;
  const entries = isPlainObject(paths) ? Object.entries(paths) : [];
  const targets = entries.filter((entry): entry is [string, string[]] =>
    isTextList(entry[1]),
  );
  if (targets.length > 0 && targets.length === entries.length)
    return Object.fromEntries(targets);
  throw new CliError({ title: `${GENERATED_PATHS} holds no paths` });
}

/** The names in the `dependencies` of the `package.json` in `directory`. */
function readDependencyNames(directory: string): string[] {
  const config: unknown = JSON.parse(
    readFileSync(nativePath.join(directory, WORKSPACE_PACKAGE), "utf8"),
  );
  return isPlainObject(config) && isPlainObject(config.dependencies)
    ? Object.keys(config.dependencies)
    : [];
}

/**
 * Turns the workspace at `out` into the tsconfig and auto-imports of the
 * sources: writes `tsconfig.json`, `types.d.ts`, `vue-shims.d.ts` and the
 * relocated `auto-imports.d.ts`, and removes the copied sources of the
 * modules and the files that name them by their absolute path, so nothing
 * resolves a stale one and no path of the machine stays. Each copy keeps its
 * `node_modules`, where the dependencies of its module are installed.
 *
 * The `tsconfig.json` it writes lays `vue-declarations/` out from the
 * filesystem root, as the declarations emit does. It returns the function
 * that writes it again with the mirror laid out from another directory, the
 * one the emitted tree is lifted to.
 */
export function writeRelocatedTypes(
  out: string,
  layers: ResolvedLayer[],
): (rootDir: string) => void {
  const table = layerTable(out, layers);
  const template = readWorkspaceTsconfig(
    nativePath.join(out, WORKSPACE_TSCONFIG),
  );
  const roots = dependencyRoots({
    outDir: out,
    workspace: readDependencyNames(out),
    layers: table.map(({ id, copy }) => ({
      id,
      dependencies: readDependencyNames(copy),
    })),
    modules: layers.map(({ packageName }) => packageName),
  });
  const paths = readGeneratedPaths(nativePath.join(out, GENERATED_PATHS));
  const dependencies = roots.map((root) => ({
    ...root,
    manifest: readManifest(root.root),
  }));
  const writeTsconfig = (rootDir: string) =>
    writeFileSync(
      nativePath.join(out, WORKSPACE_TSCONFIG),
      `${JSON.stringify(
        relocateTsconfig({
          template,
          paths,
          layers: table,
          outDir: out,
          dependencies,
          rootDir,
        }),
        null,
        2,
      )}\n`,
    );
  const autoImports = nativePath.join(out, AUTO_IMPORTS);
  writeFileSync(
    autoImports,
    relocateAutoImports(readFileSync(autoImports, "utf8"), table, out),
  );
  writeFileSync(nativePath.join(out, VUE_SHIMS_FILE), VUE_SHIMS);
  writeFileSync(nativePath.join(out, TYPES_ENTRY_FILE), typesEntry(template));
  writeTsconfig(filesystemRoot(table));
  const copies = nativePath.join(out, LAYERS_SUBDIR);
  for (const copy of readdirSync(copies, { withFileTypes: true }))
    if (copy.isDirectory()) emptyButInstall(nativePath.join(copies, copy.name));
  for (const file of COPY_DESCRIPTIONS)
    rmSync(nativePath.join(out, file), { force: true });
  return writeTsconfig;
}

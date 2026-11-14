import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
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
  commonAncestor,
  layerTable,
  relocateAutoImports,
  relocateTsconfig,
  sharedDependencies,
  type Tsconfig,
  VUE_SHIMS,
  VUE_SHIMS_FILE,
} from "./prepare-types-relocate";
import type { ResolvedLayer } from "./common";

type PathApi = typeof nativePath.win32;

/** The file that marks a directory as one `prepare-types` wrote. */
export const TYPES_MARKER = "dms-types.json";

/** The variable `ajs dms prepare-types` passes the runner its `--out` in. */
export const PREPARE_TYPES_OUT_VARIABLE = "DMS_PREPARE_TYPES_OUT";

const KEPT_ON_RESET = "node_modules";
const GENERATED_PATHS = "frontend-paths.generated.json";
const WORKSPACE_TSCONFIG = "tsconfig.json";
const AUTO_IMPORTS = "auto-imports.d.ts";
const WORKSPACE_PACKAGE = "package.json";

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
      reason: `A directory it wrote holds a ${TYPES_MARKER} file, and the command empties such a directory before it writes it again.`,
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

/** `path` with every symlink resolved, or `path` itself when it is missing. */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return nativePath.resolve(path);
  }
}

/** Whether `path` is `directory` or lies below it. */
function isAtOrBelow(directory: string, path: string): boolean {
  const rel = nativePath.relative(directory, path);
  return (
    rel === "" ||
    (rel !== ".." &&
      !rel.startsWith(`..${nativePath.sep}`) &&
      !nativePath.isAbsolute(rel))
  );
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

/**
 * Empties `out` but for its `node_modules`, which a new run installs into, and
 * writes the marker that lets a later run empty it again. The marker comes
 * first: a run that fails halfway leaves a directory the next run may reuse.
 */
export function resetOutput(out: string): void {
  mkdirSync(out, { recursive: true });
  for (const entry of readdirSync(out))
    if (entry !== KEPT_ON_RESET)
      rmSync(nativePath.join(out, entry), { recursive: true, force: true });
  writeFileSync(
    nativePath.join(out, TYPES_MARKER),
    `${JSON.stringify({ command: "ajs dms prepare-types" }, null, 2)}\n`,
  );
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

/** The names in the `dependencies` of the `package.json` at `path`. */
function readDependencyNames(path: string): string[] {
  const config: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isPlainObject(config) && isPlainObject(config.dependencies)
    ? Object.keys(config.dependencies)
    : [];
}

/**
 * Turns the workspace at `out` into the tsconfig and auto-imports of the
 * sources: writes `tsconfig.json`, `vue-shims.d.ts` and the relocated
 * `auto-imports.d.ts`, and removes the copies of the modules, so nothing
 * resolves a stale one.
 */
export function writeRelocatedTypes(
  out: string,
  layers: ResolvedLayer[],
): void {
  const table = layerTable(out, layers);
  const tsconfig = relocateTsconfig({
    template: readWorkspaceTsconfig(nativePath.join(out, WORKSPACE_TSCONFIG)),
    paths: readGeneratedPaths(nativePath.join(out, GENERATED_PATHS)),
    layers: table,
    outDir: out,
    rootDir: commonAncestor(table.map(({ source }) => source)),
    dependencies: sharedDependencies(
      readDependencyNames(nativePath.join(out, WORKSPACE_PACKAGE)),
      layers.map(({ packageName }) => packageName),
    ),
  });
  const autoImports = nativePath.join(out, AUTO_IMPORTS);
  writeFileSync(
    autoImports,
    relocateAutoImports(readFileSync(autoImports, "utf8"), table, out),
  );
  writeFileSync(nativePath.join(out, VUE_SHIMS_FILE), VUE_SHIMS);
  writeFileSync(
    nativePath.join(out, WORKSPACE_TSCONFIG),
    `${JSON.stringify(tsconfig, null, 2)}\n`,
  );
  rmSync(nativePath.join(out, LAYERS_SUBDIR), { recursive: true, force: true });
}

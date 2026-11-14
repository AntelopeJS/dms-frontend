import { realpathSync } from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import type { ResolvedLayer } from "./common";
import { LAYERS_SUBDIR } from "./config";
import { toPosixPath } from "./fs-sync";
import type { JsonValue } from "./internal/json";
import { getLayerSafeName, getLayerWorkspacePath } from "./layers";
import { type InstalledPackage, packagePaths } from "./prepare-types-packages";

/** A module of the workspace: its copy there, and the sources it came from. */
export interface RelocatedLayer {
  /** The directory name of the copy under `frontend-modules/`. */
  id: string;
  /** Absolute path of the copy in the workspace. */
  copy: string;
  /** Absolute path of the module's source tree, with its symlinks resolved. */
  source: string;
}

/**
 * The modules that have a copy in `workspace`, with where each came from.
 * Each source is its real path: TypeScript names a file it reaches through a
 * symlink, such as a module pnpm installed, by its real path, so any other
 * path to it would miss the declarations of its `.vue` files.
 */
export function layerTable(
  workspace: string,
  layers: ResolvedLayer[],
): RelocatedLayer[] {
  return layers
    .filter((layer) => layer.packageName)
    .map((layer) => ({
      id: getLayerSafeName(layer),
      copy: getLayerWorkspacePath(workspace, layer),
      source: realpathSync.native(layer.sourcePath ?? layer.path),
    }));
}

/** The shims file declaring the `.vue` modules a type-aware linter cannot read. */
export const VUE_SHIMS_FILE = "vue-shims.d.ts";
export const VUE_SHIMS = `declare module "*.vue" {\n  const component: import("vue").DefineComponent;\n  export default component;\n}\n`;

/** The Vite client types, listed as a file: `types` resolves from the extending config. */
const VITE_CLIENT_TYPES = "node_modules/vite/client.d.ts";
/** The declaration that references every other one, the single file a config that lists its own `files` adds. */
export const TYPES_ENTRY_FILE = "types.d.ts";
const COPY_ROOT = `./${LAYERS_SUBDIR}/`;
const GENERATED_FRONTEND_ALIAS = "@frontend/*";
const EVERY_DIRECTORY = "**/";
const COPY_GLOB_PREFIX = `${LAYERS_SUBDIR}/`;
/** The directory under `outDir` that holds the declarations emitted for the `.vue` files of the sources. */
export const VUE_DECLARATIONS_DIR = "vue-declarations";
const VUE_DECLARATION_SUFFIX = ".vue.d.ts";
/** Excludes `outDir` itself: the directory a tsconfig `exclude` entry names, from its own directory. */
const THIS_DIRECTORY = ".";

/** A path in a tsconfig: POSIX, relative to `outDir`, `./` before a path below it. */
function configPath(outDir: string, target: string): string {
  const relativePath = toPosixPath(relative(outDir, target));
  if (relativePath.startsWith("..") || isAbsolute(relativePath))
    return relativePath;
  return `./${relativePath}`;
}

function isWithin(directory: string, path: string): boolean {
  return path === directory || path.startsWith(`${directory}${sep}`);
}

/** `path` with the copy it lies in swapped for that copy's sources. */
function toSource(path: string, layers: RelocatedLayer[]): string {
  const layer = layers.find(({ copy }) => isWithin(copy, path));
  return layer ? `${layer.source}${path.slice(layer.copy.length)}` : path;
}

/**
 * `target`, an absolute path inside a module's sources, followed by where the
 * declarations emitted for the `.vue` files of those sources mirror it.
 * Anything else, such as a file of the workspace, has no such mirror.
 */
function withDeclarations(
  target: string,
  { layers, outDir, rootDir }: Mirroring,
): string[] {
  const own = configPath(outDir, target);
  if (!layers.some(({ source }) => isWithin(source, target))) return [own];
  const mirror = join(
    resolve(outDir, VUE_DECLARATIONS_DIR),
    relative(rootDir, target),
  );
  return [own, configPath(outDir, mirror)];
}

function dependencyPaths(
  dependencies: InstalledPackage[],
  outDir: string,
): Record<string, string[]> {
  return Object.fromEntries(
    dependencies.flatMap(({ name, root, manifest }) =>
      packagePaths(name, configPath(outDir, root), manifest),
    ),
  );
}

function remapPaths(
  paths: Record<string, string[]>,
  context: Mirroring,
): Record<string, string[]> {
  const { layers, outDir } = context;
  return Object.fromEntries(
    Object.entries(paths).flatMap(([alias, targets]) =>
      alias === GENERATED_FRONTEND_ALIAS
        ? layers.map(({ id, source }): [string, string[]] => [
            `@frontend/${id}/*`,
            withDeclarations(join(source, "*"), context),
          ])
        : [
            [
              alias,
              targets.flatMap((target) =>
                withDeclarations(
                  toSource(resolve(outDir, target), layers),
                  context,
                ),
              ),
            ],
          ],
    ),
  );
}

/**
 * The filesystem root the sources lie on: the `rootDir` of the `.vue`
 * declarations. TypeScript writes the declaration of a file outside `rootDir`
 * beside that file, so a narrower root would let a `.ts` file a component
 * imports from outside the sources be emitted outside `vue-declarations/`.
 * From the root, every file of the drive has its place under it.
 */
function declarationsRoot(layers: RelocatedLayer[]): string {
  const [root, ...others] = layers.map(({ source }) => parse(source).root);
  if (root === undefined)
    throw new CliError({ title: "There is no module to find a directory for" });
  if (others.some((other) => other.toLowerCase() !== root.toLowerCase()))
    throw new CliError({
      title: "The modules share no directory",
      reason: "They lie on different drives.",
    });
  return root;
}

/** Where the declarations of the `.vue` files of `layers` mirror their sources. */
interface Mirroring {
  layers: RelocatedLayer[];
  outDir: string;
  /** The directory the mirror is laid out from: the filesystem root of the sources. */
  rootDir: string;
}

/** Whether `file` is the declaration `vue-tsc` emits for a `.vue` file. */
export function isVueDeclaration(file: string): boolean {
  return file.endsWith(VUE_DECLARATION_SUFFIX);
}

/** The parts of a tsconfig.json that `relocateTsconfig` reads and writes. */
export interface Tsconfig {
  compilerOptions: { [option: string]: JsonValue };
  files: string[];
  include: string[];
  exclude: string[];
}

/** What `relocateTsconfig` reads. */
export interface TypesRelocation {
  /** The parsed `tsconfig.json` of the workspace. */
  template: Tsconfig;
  /** The `compilerOptions.paths` of `frontend-paths.generated.json`. */
  paths: Record<string, string[]>;
  layers: RelocatedLayer[];
  /** The workspace the tsconfig is written to. */
  outDir: string;
  /** The dependencies that no module owns, each resolved from where it is installed. */
  dependencies: InstalledPackage[];
}

/**
 * The tsconfig that type-checks the sources of `layers` with the workspace's
 * generated files: the workspace's own, with its `paths` inlined and aimed at
 * the sources, one `@frontend/<id>/*` entry per module, and the globs of the
 * copies replaced by those of the sources.
 *
 * Every alias into the sources also lists where the declarations of their
 * `.vue` files are emitted, and `rootDirs` joins the two trees for relative
 * imports. Each dependency resolves from where the workspace installed it, as
 * its `exports` map it, so the sources and the generated declarations share one
 * copy of it. `files` lists the entry declaration only.
 */
export function relocateTsconfig({
  template,
  paths,
  layers,
  outDir,
  dependencies,
}: TypesRelocation): Tsconfig {
  const rootDir = declarationsRoot(layers);
  const sources = layers.map(({ source }) => configPath(outDir, source));
  const insideSources = layers.some(({ source }) => isWithin(source, outDir));
  return {
    compilerOptions: {
      ...template.compilerOptions,
      types: [],
      allowArbitraryExtensions: true,
      rootDirs: [
        configPath(outDir, rootDir),
        configPath(outDir, resolve(outDir, VUE_DECLARATIONS_DIR)),
      ],
      paths: {
        ...dependencyPaths(dependencies, outDir),
        ...remapPaths(paths, { layers, outDir, rootDir }),
      },
    },
    files: [TYPES_ENTRY_FILE],
    include: template.include.flatMap((glob) =>
      glob.startsWith(COPY_GLOB_PREFIX)
        ? sources.map(
            (source) => `${source}/${glob.slice(COPY_GLOB_PREFIX.length)}`,
          )
        : [glob],
    ),
    exclude: [
      ...template.exclude.flatMap((glob) =>
        glob.startsWith(EVERY_DIRECTORY)
          ? sources.map((source) => `${source}/${glob}`)
          : [glob],
      ),
      ...(insideSources ? [THIS_DIRECTORY] : []),
    ],
  };
}

/**
 * The text of the entry declaration: a reference to each file the workspace's
 * tsconfig lists, then to the Vite client types and the `.vue` shims.
 */
export function typesEntry(template: Pick<Tsconfig, "files">): string {
  return [...template.files, VITE_CLIENT_TYPES, VUE_SHIMS_FILE]
    .map((file) => `/// <reference path="./${file}" />\n`)
    .join("");
}

/**
 * The throwaway tsconfig that emits one declaration per `.vue` file of the
 * sources, under `vue-declarations/` and laid out from the filesystem root, so
 * a file the emit reaches outside the sources is written under it too. It extends the
 * relocated one, so the excludes and the resolution carry over. A declaration
 * a file cannot have, one that names a type it does not export, is a
 * diagnostic, not a stop: `noEmitOnError` is off.
 */
export function vueDeclarationsConfig({
  layers,
  outDir,
}: Pick<TypesRelocation, "layers" | "outDir">) {
  return {
    extends: "./tsconfig.json",
    compilerOptions: {
      noEmit: false,
      declaration: true,
      emitDeclarationOnly: true,
      noEmitOnError: false,
      outDir: configPath(outDir, resolve(outDir, VUE_DECLARATIONS_DIR)),
      rootDir: configPath(outDir, declarationsRoot(layers)),
    },
    include: layers.map(
      ({ source }) => `${configPath(outDir, source)}/**/*.vue`,
    ),
  };
}

const MODULE_SPECIFIER = /(import\(|\bfrom )(['"])([^'"\n]*)\2/g;
const COPY_SPECIFIER = /(['"])\.\/frontend-modules\/[^'"\n]*/g;

/**
 * `auto-imports.d.ts` with each `import('./frontend-modules/<id>/…')` and
 * `from './frontend-modules/<id>/…'` aimed at the sources instead. A specifier of no module of `layers` is a copy it
 * would resolve against a directory that no longer exists.
 */
export function relocateAutoImports(
  text: string,
  layers: RelocatedLayer[],
  outDir: string,
): string {
  const relocated = text.replace(
    MODULE_SPECIFIER,
    (statement, lead: string, quote: string, specifier: string) => {
      const layer = layers.find(({ id }) =>
        specifier.startsWith(`${COPY_ROOT}${id}/`),
      );
      if (!layer) return statement;
      const inside = specifier.slice(`${COPY_ROOT}${layer.id}/`.length);
      return `${lead}${quote}${configPath(outDir, join(layer.source, inside))}${quote}`;
    },
  );
  const left = [...relocated.matchAll(COPY_SPECIFIER)].map((match) =>
    match[0].slice(1),
  );
  if (left.length > 0)
    throw new CliError({
      title: "auto-imports.d.ts still imports from a copy of a module",
      reason: `${left.slice(0, 3).join(", ")} belongs to no module of this run.`,
    });
  return relocated;
}

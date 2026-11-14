import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import type { ResolvedLayer } from "./common";
import { LAYERS_SUBDIR } from "./config";
import { toPosixPath } from "./fs-sync";
import type { JsonValue } from "./internal/json";
import { getLayerSafeName, getLayerWorkspacePath } from "./layers";

/** A module of the workspace: its copy there, and the sources it came from. */
export interface RelocatedLayer {
  /** The directory name of the copy under `frontend-modules/`. */
  id: string;
  /** Absolute path of the copy in the workspace. */
  copy: string;
  /** Absolute path of the module's source tree. */
  source: string;
}

/** The modules that have a copy in `workspace`, with where each came from. */
export function layerTable(
  workspace: string,
  layers: ResolvedLayer[],
): RelocatedLayer[] {
  return layers
    .filter((layer) => layer.packageName)
    .map((layer) => ({
      id: getLayerSafeName(layer),
      copy: getLayerWorkspacePath(workspace, layer),
      source: layer.sourcePath ?? layer.path,
    }));
}

/** The shims file declaring the `.vue` modules a type-aware linter cannot read. */
export const VUE_SHIMS_FILE = "vue-shims.d.ts";
export const VUE_SHIMS = `declare module "*.vue" {\n  const component: import("vue").DefineComponent;\n  export default component;\n}\n`;

/** The Vite client types, listed as a file: `types` resolves from the extending config. */
const VITE_CLIENT_TYPES = "node_modules/vite/client.d.ts";
const COPY_ROOT = `./${LAYERS_SUBDIR}/`;
const GENERATED_FRONTEND_ALIAS = "@frontend/*";
const EVERY_DIRECTORY = "**/";
const COPY_GLOB_PREFIX = `${LAYERS_SUBDIR}/`;
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

function remapPaths(
  paths: Record<string, string[]>,
  layers: RelocatedLayer[],
  outDir: string,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(paths).flatMap(([alias, targets]) =>
      alias === GENERATED_FRONTEND_ALIAS
        ? layers.map(({ id, source }): [string, string[]] => [
            `@frontend/${id}/*`,
            [`${configPath(outDir, source)}/*`],
          ])
        : [
            [
              alias,
              targets.map((target) =>
                configPath(outDir, toSource(resolve(outDir, target), layers)),
              ),
            ],
          ],
    ),
  );
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
}

/**
 * The tsconfig that type-checks the sources of `layers` with the workspace's
 * generated files: the workspace's own, with its `paths` inlined and aimed at
 * the sources, one `@frontend/<id>/*` entry per module, and the globs of the
 * copies replaced by those of the sources.
 */
export function relocateTsconfig({
  template,
  paths,
  layers,
  outDir,
}: TypesRelocation): Tsconfig {
  const sources = layers.map(({ source }) => configPath(outDir, source));
  const insideSources = layers.some(({ source }) => isWithin(source, outDir));
  return {
    compilerOptions: {
      ...template.compilerOptions,
      types: [],
      allowArbitraryExtensions: true,
      paths: remapPaths(paths, layers, outDir),
    },
    files: [...template.files, VITE_CLIENT_TYPES, VUE_SHIMS_FILE],
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

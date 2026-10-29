import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { toPosixPath } from "./fs-sync";

/** The subdirectory of a frontend module root that holds its layers. */
export const MODULE_LAYERS_DIRNAME = "layers";

/** The prefix every layer specifier carries. */
const LAYER_ALIAS_PREFIX = "#";

export interface FrontendLayer {
  /** The layer directory name, e.g. `dms-core`. */
  name: string;
  /** The import specifier the layer answers to, e.g. `#dms-core`. */
  alias: string;
  /** Absolute path of the layer directory on disk. */
  directory: string;
}

export interface FrontendLayerPathOptions {
  /**
   * Emit specifiers relative to this directory instead of absolute ones.
   * A tsconfig `paths` map is read relative to its `baseUrl`, so the generated
   * workspace passes its own root here.
   */
  relativeTo?: string;
}

/**
 * `statSync`, not the dirent: a layer reached through a symlink is still a
 * layer, and a module root can legitimately be a link farm.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readModuleLayers(moduleRoot: string): FrontendLayer[] {
  const layersRoot = join(resolve(moduleRoot), MODULE_LAYERS_DIRNAME);
  if (!existsSync(layersRoot)) return [];
  return readdirSync(layersRoot)
    .map((name) => ({
      name,
      alias: `${LAYER_ALIAS_PREFIX}${name}`,
      directory: join(layersRoot, name),
    }))
    .filter((layer) => isDirectory(layer.directory));
}

/**
 * The layers reachable from one or more frontend module roots.
 *
 * A module without a `layers/` directory contributes nothing, which is the
 * normal shape for a module that ships a single flat source tree.
 *
 * Roots are read in **increasing precedence**: when two modules expose a layer
 * of the same name, the last root wins the directory, and the alias keeps the
 * position of its first appearance. That is the order the loader already feeds
 * every overlay -- public assets, locale messages -- so the highest-priority
 * module is the one materialized last.
 *
 * The layer alias convention, free of the loader: every frontend module may
 * carry a `layers/<name>/` directory, and each layer is addressable as
 * `#<name>` from anywhere in the generated Vue workspace, which is what makes
 * `#dms-core/composables/...` resolve. The functions of this module derive it
 * from a module root on disk, with no backend, manifest or workspace, so the
 * workspace and anything outside it, such as a module's own Vitest run, read
 * the same definition instead of restating the aliases by hand.
 *
 * @param moduleRoots One module root, or several in increasing precedence
 * @returns One entry per distinct layer name, in first-appearance order
 */
export function resolveFrontendLayers(
  moduleRoots: string | readonly string[],
): FrontendLayer[] {
  const roots = typeof moduleRoots === "string" ? [moduleRoots] : moduleRoots;
  const layers = new Map<string, FrontendLayer>();
  for (const root of roots) {
    for (const layer of readModuleLayers(root)) {
      layers.set(layer.name, layer);
    }
  }
  return [...layers.values()];
}

/**
 * The layer aliases in the shape a bundler resolver expects -- Vite's and
 * Vitest's `resolve.alias`, esbuild, Rollup: a bare specifier mapped to the
 * directory it stands for.
 *
 * ```ts
 * resolve: { alias: frontendLayerAliases(moduleRoot) }
 * // { "#dms-core": "<abs>/layers/dms-core", "#dms-ui": "<abs>/layers/dms-ui" }
 * ```
 *
 * @param moduleRoots One module root, or several in increasing precedence
 */
export function frontendLayerAliases(
  moduleRoots: string | readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    resolveFrontendLayers(moduleRoots).map((layer) => [
      layer.alias,
      layer.directory,
    ]),
  );
}

/**
 * The same aliases in the shape a tsconfig `paths` map expects: the glob
 * suffix on both sides, and one target per key.
 *
 * The specifiers are POSIX even when they are produced on Windows -- a
 * tsconfig path is text read by the compiler, not a filesystem path, and a
 * native separator there resolves nothing.
 *
 * @param moduleRoots One module root, or several in increasing precedence
 * @param options `relativeTo` to emit workspace-relative specifiers
 */
export function frontendLayerTypePaths(
  moduleRoots: string | readonly string[],
  options: FrontendLayerPathOptions = {},
): Record<string, string[]> {
  const base = options.relativeTo;
  return Object.fromEntries(
    resolveFrontendLayers(moduleRoots).map((layer) => {
      const target =
        base === undefined
          ? toPosixPath(layer.directory)
          : toPosixPath(relative(resolve(base), layer.directory));
      const specifier =
        base === undefined || target.startsWith("..") ? target : `./${target}`;
      return [`${layer.alias}/*`, [`${specifier}/*`]];
    }),
  );
}

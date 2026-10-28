import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toPosixPath } from "./fs-sync";
import { MODULE_LAYERS_DIRNAME } from "./layer-aliases";

export interface AssetRoot {
  absolutePath: string;
  relativePrefix: string;
}

/**
 * The module root when it has no `layers/` directory, else each layer in it,
 * sorted by name: where two of a module's layers hold the same file, the last
 * one wins, the same one on every system.
 *
 * Where a frontend module keeps the files the workspace derives its own from:
 * the module root, or each of its layers.
 */
export function moduleAssetRoots(moduleRoot: string): AssetRoot[] {
  const layersRoot = join(moduleRoot, "layers");
  if (!existsSync(layersRoot)) {
    return [{ absolutePath: moduleRoot, relativePrefix: "" }];
  }
  return readdirSync(layersRoot)
    .sort()
    .map((name) => ({
      absolutePath: join(layersRoot, name),
      relativePrefix: `layers/${name}/`,
    }));
}

/**
 * Whether `relativePath`, relative to a module root, names its `layers/`
 * directory or one of the layers in it, whose creation or removal adds or
 * removes an asset root with everything in it.
 */
export function isLayerDirectory(relativePath: string): boolean {
  const segments = toPosixPath(relativePath).split("/");
  return segments[0] === MODULE_LAYERS_DIRNAME && segments.length <= 2;
}

/**
 * Whether a change at `relativePath`, relative to a module root, can change
 * what its asset roots hold under `directory`: anything under it, or a
 * directory on the way to it, whose creation or removal brings or takes a
 * whole set of files at once.
 */
export function affectsAssetDirectory(
  directory: string,
  relativePath: string,
): boolean {
  if (isLayerDirectory(relativePath)) return true;
  const segments = toPosixPath(relativePath).split("/");
  const withinRoot =
    segments[0] === MODULE_LAYERS_DIRNAME ? segments.slice(2) : segments;
  return directory
    .split("/")
    .every(
      (segment, index) =>
        index >= withinRoot.length || withinRoot[index] === segment,
    );
}

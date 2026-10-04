// Reads the packages a source verification builds: the DMS core layer and
// the frontend modules verified on top of it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliProblem } from "@antelopejs/core/cli";
import { type ResolvedLayer, UsageError } from "./common";
import { showPath } from "./output";
import { LAYER_PATH_FIX, VERIFY_SOURCE_COMMAND } from "./verify-source-result";

interface LayerPackage {
  name?: string;
}

/** The package of the frontend-vue directory of `@antelopejs/dms`. */
const DMS_CORE_LAYER_PACKAGE = "@antelopejs/dms-frontend-vue";
/** Where a project that depends on `@antelopejs/dms` finds its core layer. */
const INSTALLED_CORE_LAYER = "node_modules/@antelopejs/dms/frontend-vue";

function readName(packagePath: string): string | undefined {
  return (JSON.parse(readFileSync(packagePath, "utf8")) as LayerPackage).name;
}

function readLayer(root: string): ResolvedLayer {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath))
    throw new UsageError({
      title: `No package.json in ${showPath(root)}`,
      fixes: [LAYER_PATH_FIX],
    });
  return { path: root, sourcePath: root, packageName: readName(packagePath) };
}

/**
 * The packages to verify: the one at DMS_LAYER_SOURCE, or each directory in
 * it, then those of DMS_MODULE_SOURCES. The first ones include the DMS core
 * layer, which the checks run against.
 */
export function readSources(): ResolvedLayer[] {
  const layerSource = process.env.DMS_LAYER_SOURCE;
  if (!layerSource)
    throw new UsageError({
      title: "DMS_LAYER_SOURCE is not set",
      fixes: [
        `Set it to the root of the DMS core layer, or run ${VERIFY_SOURCE_COMMAND} -l <path>`,
      ],
    });
  const sourceRoot = resolve(layerSource);
  if (!statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory())
    throw new UsageError({
      title: `Layer path not found: ${showPath(sourceRoot)}`,
      fixes: [LAYER_PATH_FIX],
    });
  const extraSources = JSON.parse(
    process.env.DMS_MODULE_SOURCES ?? "[]",
  ) as string[];
  const layerRoots = existsSync(join(sourceRoot, "dms.frontend.ts"))
    ? [sourceRoot]
    : readdirSync(sourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sourceRoot, entry.name));
  if (layerRoots.length === 0)
    throw new UsageError({
      title: `No frontend package in ${showPath(sourceRoot)}`,
      fixes: [LAYER_PATH_FIX],
    });
  const layers = layerRoots.map(readLayer);
  const modules = extraSources.map((root) => readLayer(resolve(root)));
  if (!layers.some(isCoreLayer))
    throw new UsageError(missingCoreLayer(sourceRoot, layers, modules));
  return [...layers, ...modules];
}

/** The packages bound with --local-package, by name. */
export function readLocalPackages(): Record<string, string> {
  return JSON.parse(process.env.DMS_LOCAL_PACKAGES ?? "{}") as Record<
    string,
    string
  >;
}

function isCoreLayer(layer: ResolvedLayer): boolean {
  return layer.packageName === DMS_CORE_LAYER_PACKAGE;
}

/** A path as an argument to paste in a shell. */
function shellArgument(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : JSON.stringify(path);
}

/** Whether the project depends on `@antelopejs/dms`, and so has its core layer. */
function hasInstalledCoreLayer(): boolean {
  const packagePath = join(INSTALLED_CORE_LAYER, "package.json");
  return (
    existsSync(packagePath) && readName(packagePath) === DMS_CORE_LAYER_PACKAGE
  );
}

/**
 * The checks look for what the DMS core layer ships (its lazily loaded
 * libraries, its pages, its e-mail templates), so a frontend module passed as
 * --layer would build, then fail on a chunk it never had. Stops the run before
 * anything is installed, with the command that verifies the same packages on
 * top of the core layer.
 */
function missingCoreLayer(
  sourceRoot: string,
  layers: ResolvedLayer[],
  modules: ResolvedLayer[],
): CliProblem {
  const passedCore = modules.find(isCoreLayer);
  const coreLayer = passedCore
    ? showPath(passedCore.path)
    : INSTALLED_CORE_LAYER;
  const localPackages = Object.entries(readLocalPackages());
  const command = [
    VERIFY_SOURCE_COMMAND,
    "-l",
    shellArgument(coreLayer),
    ...[...layers, ...modules]
      .filter((layer) => !isCoreLayer(layer))
      .flatMap((layer) => ["-m", shellArgument(showPath(layer.path))]),
    ...localPackages.flatMap(([name, path]) => [
      "--local-package",
      shellArgument(`${name}=${showPath(path)}`),
    ]),
  ].join(" ");
  const names = layers
    .map((layer) => layer.packageName ?? "a package without a name")
    .join(", ");
  return {
    title: `${showPath(sourceRoot)} is not the DMS core layer`,
    reason:
      `--layer takes ${DMS_CORE_LAYER_PACKAGE}, the frontend-vue directory of ` +
      `@antelopejs/dms, and -m the frontend modules to verify on top of it; ` +
      `${showPath(sourceRoot)} holds ${names}.`,
    fixes: [
      ...(passedCore || hasInstalledCoreLayer()
        ? []
        : [
            "Add @antelopejs/dms to the project's dev dependencies: pnpm add -D @antelopejs/dms",
          ]),
      `Run ${command}`,
    ],
  };
}

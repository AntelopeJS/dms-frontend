// Reads the packages a source verification builds: the DMS core layer and
// the frontend modules verified on top of it.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CliProblem } from "@antelopejs/core/cli";
import { type ResolvedLayer, UsageError } from "./common";
import { showPath } from "./output";
import { LAYER_PATH_FIX, VERIFY_SOURCE_COMMAND } from "./verify-source-result";

interface PackageManifest {
  name?: string;
  version?: string;
  packageManager?: string;
}

/** What a verification reads its packages from. */
export interface SourceOptions {
  /** The project the installed `@antelopejs/dms` is resolved from. */
  projectDir: string;
  /** An unpublished DMS core layer, verified instead of the installed one. */
  layerSource?: string;
  moduleSources: string[];
  localPackages: Record<string, string>;
}

export interface Sources {
  /** The core layer first, then the frontend modules. */
  layers: ResolvedLayer[];
  /** The core layer the modules are verified against, as the user reads it. */
  coreLayer: string;
}

const DMS_PACKAGE = "@antelopejs/dms";
/** The package of the frontend-vue directory of `@antelopejs/dms`. */
const DMS_CORE_LAYER_PACKAGE = "@antelopejs/dms-frontend-vue";
const CORE_LAYER_DIRECTORY = "frontend-vue";
/** The entry every frontend package has at its root. */
const FRONTEND_ENTRY = "dms.frontend.ts";

/** How each package manager adds a development dependency. */
const ADD_DEV_DEPENDENCY: Record<string, string> = {
  pnpm: "pnpm add -D",
  npm: "npm install -D",
  yarn: "yarn add -D",
  bun: "bun add -d",
};
const LOCKFILES: [string, string][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

/** The environment variables `ajs dms verify-source` starts the runner with. */
export function readSourceOptions(): SourceOptions {
  return {
    projectDir: process.cwd(),
    layerSource: process.env.DMS_LAYER_SOURCE || undefined,
    moduleSources: JSON.parse(
      process.env.DMS_MODULE_SOURCES ?? "[]",
    ) as string[],
    localPackages: JSON.parse(process.env.DMS_LOCAL_PACKAGES ?? "{}") as Record<
      string,
      string
    >,
  };
}

function readManifest(packagePath: string): PackageManifest {
  return JSON.parse(readFileSync(packagePath, "utf8")) as PackageManifest;
}

function readLayer(root: string): ResolvedLayer {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath))
    throw new UsageError({
      title: `No package.json in ${showPath(root)}`,
      fixes: [LAYER_PATH_FIX],
    });
  const { name } = readManifest(packagePath);
  return { path: root, sourcePath: root, packageName: name };
}

function isCoreLayer(layer: ResolvedLayer): boolean {
  return layer.packageName === DMS_CORE_LAYER_PACKAGE;
}

/** A path as an argument to paste in a shell. */
function shellArgument(path: string): string {
  return /^[\w@%+=:,./~-]+$/.test(path) ? path : JSON.stringify(path);
}

// ============================================================================
// Frontend modules
// ============================================================================

/**
 * The frontend module of the project when none is named: the project itself
 * when it is one, otherwise its frontend-vue directory.
 */
function defaultModuleRoot(projectDir: string): string {
  const root = [projectDir, join(projectDir, CORE_LAYER_DIRECTORY)].find(
    (candidate) => existsSync(join(candidate, FRONTEND_ENTRY)),
  );
  if (root) return root;
  throw new UsageError({
    title: "No frontend module to verify",
    reason: `Neither ${showPath(projectDir)} nor its ${CORE_LAYER_DIRECTORY} directory contains ${FRONTEND_ENTRY}.`,
    fixes: [
      `Run the command from the frontend module, or pass its root with -m`,
    ],
  });
}

// ============================================================================
// The DMS core layer
// ============================================================================

/** The package manager of the project, pnpm unless it uses another one. */
function packageManager(projectDir: string): string {
  for (let directory = projectDir; ; directory = dirname(directory)) {
    const packagePath = join(directory, "package.json");
    if (existsSync(packagePath)) {
      const [name] = (readManifest(packagePath).packageManager ?? "").split(
        "@",
      );
      if (name && ADD_DEV_DEPENDENCY[name]) return name;
      const lockfile = LOCKFILES.find(([file]) =>
        existsSync(join(directory, file)),
      );
      if (lockfile) return lockfile[1];
    }
    if (dirname(directory) === directory) return "pnpm";
  }
}

function addDmsCommand(projectDir: string, version = ""): string {
  return `${ADD_DEV_DEPENDENCY[packageManager(projectDir)]} ${DMS_PACKAGE}${version}`;
}

function describeDirectory(directory: string): string {
  return resolve(directory) === process.cwd()
    ? "the current directory"
    : showPath(directory);
}

/** The package.json of the `@antelopejs/dms` the project resolves, if any. */
function resolveDmsPackage(projectDir: string): string | undefined {
  try {
    return require.resolve(`${DMS_PACKAGE}/package.json`, {
      paths: [projectDir],
    });
  } catch {
    return undefined;
  }
}

/**
 * The core layer of the `@antelopejs/dms` installed in the project, found
 * the way Node finds the package from the project directory.
 */
function installedCoreLayer(projectDir: string): Sources {
  const packagePath = resolveDmsPackage(projectDir);
  if (!packagePath)
    throw new UsageError({
      title: `${DMS_PACKAGE} is not installed in this project`,
      reason: `Frontend modules are verified on top of the DMS core layer that ${DMS_PACKAGE} ships, and Node finds no ${DMS_PACKAGE} from ${describeDirectory(projectDir)}.`,
      fixes: [
        `Add it as a development dependency: ${addDmsCommand(projectDir)}`,
      ],
    });
  const { version } = readManifest(packagePath);
  const root = join(dirname(packagePath), CORE_LAYER_DIRECTORY);
  const layer = existsSync(join(root, "package.json"))
    ? readLayer(root)
    : undefined;
  if (!layer || !isCoreLayer(layer))
    throw new UsageError({
      title: `${DMS_PACKAGE} ${version} ships no DMS core layer`,
      reason: `${showPath(dirname(packagePath))} has no ${CORE_LAYER_DIRECTORY} directory holding ${DMS_CORE_LAYER_PACKAGE}.`,
      fixes: [`Update it: ${addDmsCommand(projectDir, "@latest")}`],
    });
  return {
    layers: [layer],
    coreLayer: `${DMS_PACKAGE} ${version} (installed in this project)`,
  };
}

/**
 * The checks look for what the DMS core layer ships (its lazily loaded
 * libraries, its pages, its e-mail templates), so a frontend module passed as
 * --layer would build, then fail on a chunk it never had. Stops the run before
 * anything is installed, with the command that verifies the same packages on
 * top of the installed core layer.
 */
function notCoreLayer(
  sourceRoot: string,
  layers: ResolvedLayer[],
  modules: ResolvedLayer[],
  localPackages: Record<string, string>,
): CliProblem {
  const command = [
    VERIFY_SOURCE_COMMAND,
    ...[...layers, ...modules].flatMap((layer) => [
      "-m",
      shellArgument(showPath(layer.path)),
    ]),
    ...Object.entries(localPackages).flatMap(([name, path]) => [
      "--local-package",
      shellArgument(`${name}=${showPath(path)}`),
    ]),
  ].join(" ");
  const names = layers
    .map((layer) => layer.packageName ?? "a package without a name")
    .join(", ");
  const shown = showPath(sourceRoot);
  return {
    title: `${shown} is not the DMS core layer`,
    reason:
      `--layer is for verifying an unpublished DMS core layer, ${DMS_CORE_LAYER_PACKAGE}, and ${shown} holds ${names}. ` +
      `Without it, frontend modules are verified on the core layer of the ${DMS_PACKAGE} installed in the project.`,
    fixes: [`Drop -l and pass the folder with -m: ${command}`],
  };
}

/** The packages at --layer: the one there, or each directory in it. */
function readLayerSource(layerSource: string): {
  sourceRoot: string;
  layers: ResolvedLayer[];
} {
  const sourceRoot = resolve(layerSource);
  if (!statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory())
    throw new UsageError({
      title: `Layer path not found: ${showPath(sourceRoot)}`,
      fixes: [LAYER_PATH_FIX],
    });
  const roots = existsSync(join(sourceRoot, FRONTEND_ENTRY))
    ? [sourceRoot]
    : readdirSync(sourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sourceRoot, entry.name));
  if (roots.length === 0)
    throw new UsageError({
      title: `No frontend package in ${showPath(sourceRoot)}`,
      fixes: [LAYER_PATH_FIX],
    });
  return { sourceRoot, layers: roots.map(readLayer) };
}

// ============================================================================
// Sources
// ============================================================================

/**
 * The packages to verify. The core layer is the one at --layer, else one
 * passed as a module, else the one of the `@antelopejs/dms` installed in the
 * project; the modules are those passed, else the project's own.
 */
export function readSources(options: SourceOptions): Sources {
  const { projectDir, layerSource, localPackages } = options;
  const modules = (
    options.moduleSources.length > 0 || layerSource
      ? options.moduleSources.map((root) => resolve(root))
      : [defaultModuleRoot(projectDir)]
  ).map(readLayer);
  if (layerSource) {
    const { sourceRoot, layers } = readLayerSource(layerSource);
    if (!layers.some(isCoreLayer))
      throw new UsageError(
        notCoreLayer(sourceRoot, layers, modules, localPackages),
      );
    return {
      layers: [...layers, ...modules],
      coreLayer: `the DMS core layer in ${showPath(sourceRoot)}`,
    };
  }
  const passedCore = modules.find(isCoreLayer);
  if (passedCore)
    return {
      layers: [passedCore, ...modules.filter((layer) => layer !== passedCore)],
      coreLayer: `the DMS core layer in ${showPath(passedCore.path)}`,
    };
  const installed = installedCoreLayer(projectDir);
  return { ...installed, layers: [...installed.layers, ...modules] };
}

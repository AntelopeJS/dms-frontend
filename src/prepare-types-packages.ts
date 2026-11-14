import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LAYERS_SUBDIR } from "./config";
import { isJsonObject, type JsonValue } from "./internal/json";
import { isText } from "./internal/guards";
import { isPlainObject } from "./internal/plain-object";

/** What a `package.json` says about the entry points of its package. */
export interface PackageManifest {
  /** Its `exports` field, absent when it has none. */
  exports?: JsonValue;
  /** Its top-level `types`, or `typings`, field. */
  types?: string;
}

/** A dependency the output resolves, and the directory it is installed in. */
export interface PackageRoot {
  name: string;
  /** Absolute path of the package directory. */
  root: string;
}

/** A dependency the output resolves, with what its `package.json` says. */
export interface InstalledPackage extends PackageRoot {
  manifest: PackageManifest;
}

const INSTALL_DIRECTORY = "node_modules";
const MANIFEST = "package.json";
const SUBPATH_ROOT = ".";
const WILDCARD = "*";
/** The conditions read from an `exports` entry, in the order they are tried. */
const CONDITIONS = ["types", "import", "default"] as const;
/** Each JavaScript extension with the extension of its declaration file. */
const DECLARATION_EXTENSIONS = [
  [".mjs", ".d.mts"],
  [".cjs", ".d.cts"],
  [".js", ".d.ts"],
] as const;
const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/**
 * The installed directory of each dependency the output resolves: those of
 * the workspace under its `node_modules`, then the other `dependencies` of
 * each module under the `node_modules` of its copy, the first module's when
 * two name one. The modules themselves resolve from their sources.
 */
export function dependencyRoots({
  outDir,
  workspace,
  layers,
  modules,
}: {
  outDir: string;
  /** The `dependencies` of the workspace. */
  workspace: string[];
  /** The directory name of each copy under `frontend-modules/`, with the `dependencies` of its module. */
  layers: { id: string; dependencies: string[] }[];
  /** The package names of the modules. */
  modules: (string | undefined)[];
}): PackageRoot[] {
  const roots: PackageRoot[] = [];
  const add = (name: string, directory: string) => {
    if (!modules.includes(name) && !roots.some((root) => root.name === name))
      roots.push({ name, root: join(directory, INSTALL_DIRECTORY, name) });
  };
  for (const name of workspace) add(name, outDir);
  for (const { id, dependencies } of layers)
    for (const name of dependencies) add(name, join(outDir, LAYERS_SUBDIR, id));
  return roots;
}

/** The manifest of the package at `root`, empty when it has no readable one. */
export function readManifest(root: string): PackageManifest {
  let config: unknown;
  try {
    config = JSON.parse(readFileSync(join(root, MANIFEST), "utf8"));
  } catch {
    return {};
  }
  const manifest: PackageManifest = {};
  if (!isJsonObject(config)) return manifest;
  const types = [config.types, config.typings].find(isText);
  if (types !== undefined) manifest.types = types;
  if (config.exports !== undefined) manifest.exports = config.exports;
  return manifest;
}

function hasOwn(entry: { [key: string]: JsonValue }, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(entry, key);
}

/** The target an `exports` entry picks under the `types`, `import` and `default` conditions. */
function pickTarget(entry: JsonValue | undefined): string | undefined {
  if (isText(entry)) return entry;
  if (Array.isArray(entry)) return entry.map(pickTarget).find(isText);
  if (!isPlainObject(entry)) return undefined;
  return CONDITIONS.filter((condition) => hasOwn(entry, condition))
    .map((condition) => pickTarget(entry[condition]))
    .find(isText);
}

/** The subpaths of `exports`, a bare target or condition map being that of `.`. */
function subpaths(exports: JsonValue | undefined): [string, JsonValue][] {
  if (exports === undefined) return [];
  if (
    isPlainObject(exports) &&
    Object.keys(exports).some((key) => key.startsWith(SUBPATH_ROOT))
  )
    return Object.entries(exports);
  return [[SUBPATH_ROOT, exports]];
}

function wildcards(text: string): number {
  return text.split(WILDCARD).length - 1;
}

/**
 * The files a target stands for, in the order TypeScript should try them. A
 * JavaScript target comes after its declaration file, and that of `.` after
 * the package's top-level `types` too: a consumer that allows JavaScript would
 * otherwise read the JavaScript file before looking for its declaration.
 */
function targetFiles(
  target: string,
  subpath: string,
  manifest: PackageManifest,
): string[] {
  if (TYPESCRIPT_FILE.test(target)) return [target];
  const declaration = DECLARATION_EXTENSIONS.find(([extension]) =>
    target.endsWith(extension),
  );
  return [
    ...new Set([
      ...(subpath === SUBPATH_ROOT && manifest.types ? [manifest.types] : []),
      ...(declaration
        ? [`${target.slice(0, -declaration[0].length)}${declaration[1]}`]
        : []),
      target,
    ]),
  ];
}

/** `file`, a path inside a package, below `root`, the package directory as a tsconfig path. */
function inPackage(root: string, file: string): string {
  return `${root}/${file.replace(/^\.\//, "")}`;
}

/**
 * The `compilerOptions.paths` entries that resolve the package `name`,
 * installed at `root`, as its `exports` do: one per subpath, aimed at the file
 * the `types`, `import` and `default` conditions pick. `paths` bypass
 * `exports`, so without these a subpath resolves to a file the package never
 * exposes. A subpath or target with more than one `*`, which `paths` cannot
 * express, is left out. `name` and `name/*` fall back to the package directory
 * when `exports` does not map them.
 */
export function packagePaths(
  name: string,
  root: string,
  manifest: PackageManifest,
): [string, string[]][] {
  const mapped = subpaths(manifest.exports).flatMap(
    ([subpath, entry]): [string, string[]][] => {
      const target = pickTarget(entry);
      if (
        target === undefined ||
        wildcards(subpath) > 1 ||
        wildcards(target) > 1
      )
        return [];
      return [
        [
          `${name}${subpath.slice(SUBPATH_ROOT.length)}`,
          targetFiles(target, subpath, manifest).map((file) =>
            inPackage(root, file),
          ),
        ],
      ];
    },
  );
  const fallbacks: [string, string[]][] = [
    [name, [root]],
    [`${name}/*`, [`${root}/*`]],
  ];
  return [
    ...mapped,
    ...fallbacks.filter(
      ([alias]) => !mapped.some(([mappedAlias]) => mappedAlias === alias),
    ),
  ];
}

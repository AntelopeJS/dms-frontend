import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { isRecord, isString } from "./server/type-guards.mjs";

const BACKEND_SOURCE = "src";
const QUERY_OR_HASH = /[?#].*$/;

/**
 * @param {string} manifest
 * @returns {string | undefined}
 */
function manifestName(manifest) {
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    return isRecord(parsed) && isString(parsed.name) ? parsed.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @typedef {{ root: string, name: string }} BackendPackage
 */

/**
 * The backend package that holds `directory`: the nearest `package.json` above
 * it, when it names one of `backendPackages`.
 *
 * @param {string} directory
 * @param {ReadonlySet<string>} backendPackages
 * @param {Map<string, BackendPackage | null>} known
 * @returns {BackendPackage | null}
 */
function owningBackend(directory, backendPackages, known) {
  const cached = known.get(directory);
  if (cached !== undefined) return cached;
  const manifest = join(directory, "package.json");
  const parent = dirname(directory);
  /** @type {BackendPackage | null} */
  let owner = null;
  if (existsSync(manifest)) {
    const name = manifestName(manifest);
    owner =
      name !== undefined && backendPackages.has(name)
        ? { root: directory, name }
        : null;
  } else if (parent !== directory) {
    owner = owningBackend(parent, backendPackages, known);
  }
  known.set(directory, owner);
  return owner;
}

/**
 * The real path of a resolved module id under the `src` of a backend package,
 * and that package's name, or `undefined`. The package that owns the file
 * decides, not where it lies, so a backend linked or installed into the
 * workspace is caught as well as its source checkout. Virtual ids and ids that
 * are not files are ignored.
 *
 * @param {string} id
 * @param {ReadonlySet<string>} backendPackages
 * @param {Map<string, BackendPackage | null>} known
 * @returns {{ file: string, name: string } | undefined}
 */
function backendSourceFile(id, backendPackages, known) {
  const path = id.replace(QUERY_OR_HASH, "");
  if (!isAbsolute(path)) return undefined;
  let file;
  try {
    file = realpathSync(path);
  } catch {
    return undefined;
  }
  const owner = owningBackend(dirname(file), backendPackages, known);
  if (owner === null) return undefined;
  return relative(owner.root, file).split(sep)[0] === BACKEND_SOURCE
    ? { file, name: owner.name }
    : undefined;
}

/**
 * @param {ReadonlySet<string>} backendPackages
 * @returns {import("vite").Plugin}
 */
function boundaryCheck(backendPackages) {
  /** @type {Map<string, BackendPackage | null>} */
  const known = new Map();
  return {
    name: "dms-backend-boundary",
    enforce: "pre",
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (resolved === null) return null;
      const backend = backendSourceFile(resolved.id, backendPackages, known);
      if (backend === undefined) return resolved;
      const from =
        importer === undefined
          ? "an entry point"
          : importer.replace(QUERY_OR_HASH, "");
      return this.error(
        `Backend boundary: ${from} imports ${backend.file.split(sep).join("/")}, which is under the src of ${backend.name}. ` +
          "The frontend reaches the backend only through its HTTP interface.",
      );
    },
  };
}

/**
 * Fail the build, a worker build and the dev server when a module of the
 * frontend resolves to a file under the `src` of a backend package: the package
 * that holds a module's layer, as the registry names it. The browser and the
 * server renderer reach the backend only through its HTTP interface.
 *
 * The check reads what the whole resolution chain returns, so an alias, a
 * symlink and an id marked external are all seen through. Vite builds workers
 * with their own plugin list, so the plugin adds the check there too.
 *
 * @param {readonly string[]} backendPackages
 * @returns {import("vite").Plugin}
 */
export function rejectBackendSources(backendPackages) {
  const names = new Set(backendPackages);
  return {
    ...boundaryCheck(names),
    config: () => ({ worker: { plugins: () => [boundaryCheck(names)] } }),
  };
}

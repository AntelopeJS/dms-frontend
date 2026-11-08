import { isBoolean, isNumber, isRecord, isString } from "./type-guards.mjs";

/**
 * @param {unknown} value
 * @returns {value is import("./public-options.mjs").FrontendRegistry}
 */
function isFrontendRegistry(value) {
  return (
    isRecord(value) &&
    Array.isArray(value.modules) &&
    value.modules.every((module) => isRecord(module) && isString(module.id))
  );
}

/**
 * The module registry the build wrote to `generated-frontend-modules.json`.
 *
 * @param {unknown} content The file's JSON
 * @returns {import("./public-options.mjs").FrontendRegistry}
 * @throws {Error} When it is not a list of modules that have an id
 */
export function frontendRegistryOf(content) {
  if (!isFrontendRegistry(content))
    throw new Error(
      "generated-frontend-modules.json is not a list of modules with an id",
    );
  return content;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, Record<string, unknown>>}
 */
function isObjectOfObjects(value) {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (child) => isRecord(child) && !Array.isArray(child),
    )
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, string[]>}
 */
function isObjectOfPaths(value) {
  return (
    isRecord(value) &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (path) => Array.isArray(path) && path.every(isString),
    )
  );
}

/**
 * The server options the build wrote to `generated-server-options.json`: the
 * private options by module id, and for each variable the path of the secret
 * it stands for. A part the file leaves out is empty.
 *
 * @param {unknown} content The file's JSON
 * @returns {{
 *   modules: Record<string, Record<string, unknown>>,
 *   environment: Record<string, string[]>
 * }}
 * @throws {Error} When a part is not what the build writes
 */
export function serverOptionsOf(content) {
  const options =
    isRecord(content) && !Array.isArray(content) ? content : undefined;
  const modules = options ? (options.modules ?? {}) : undefined;
  const environment = options ? (options.environment ?? {}) : undefined;
  if (!isObjectOfObjects(modules) || !isObjectOfPaths(environment))
    throw new Error(
      "generated-server-options.json is not what the build writes",
    );
  return { modules, environment };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return isRecord(value) && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isTextList(value) {
  return Array.isArray(value) && value.every(isString);
}

/**
 * @param {unknown} value
 * @returns {value is import("vite").ManifestChunk}
 */
function isManifestChunk(value) {
  return (
    isPlainRecord(value) &&
    isString(value.file) &&
    [value.css, value.assets, value.imports, value.dynamicImports].every(
      (list) => list === undefined || isTextList(list),
    ) &&
    [value.src, value.name].every(
      (text) => text === undefined || isString(text),
    ) &&
    [value.isEntry, value.isDynamicEntry].every(
      (flag) => flag === undefined || isBoolean(flag),
    )
  );
}

/**
 * @param {unknown} value
 * @returns {value is import("vite").Manifest}
 */
function isManifest(value) {
  return isPlainRecord(value) && Object.values(value).every(isManifestChunk);
}

/**
 * The manifest `vite build` wrote to `dist/client/.vite/manifest.json`.
 *
 * @param {unknown} content The file's JSON
 * @returns {import("vite").Manifest}
 * @throws {Error} When it is not an object of chunks
 */
export function viteManifestOf(content) {
  if (!isManifest(content))
    throw new Error("the client manifest is not an object of Vite chunks");
  return content;
}

/**
 * The members of an Iconify collection that `iconCollectionOf` checks, the
 * ones an icon query and a server render read.
 *
 * @typedef {Parameters<typeof import("@iconify/utils").getIcons>[0]} Iconify
 */

/**
 * @typedef {Pick<
 *   Iconify,
 *   | "prefix"
 *   | "icons"
 *   | "aliases"
 *   | "lastModified"
 *   | "left"
 *   | "top"
 *   | "width"
 *   | "height"
 * > &
 *   Pick<Iconify["icons"][string], "rotate" | "hFlip" | "vFlip">} IconCollection
 */

/**
 * @param {unknown} value An icon, an alias or the collection itself
 * @returns {boolean} Whether its size and transformation members, all
 *   optional, have the types Iconify gives them
 */
function hasIconifyOptionals(value) {
  return (
    isPlainRecord(value) &&
    [value.left, value.top, value.width, value.height, value.rotate].every(
      (number) => number === undefined || isNumber(number),
    ) &&
    [value.hFlip, value.vFlip, value.hidden].every(
      (flag) => flag === undefined || isBoolean(flag),
    )
  );
}

/**
 * @param {unknown} value
 * @param {"body" | "parent"} required The member each entry of the table names
 * @returns {boolean}
 */
function isIconifyTable(value, required) {
  return (
    isPlainRecord(value) &&
    Object.values(value).every(
      (member) =>
        hasIconifyOptionals(member) &&
        isPlainRecord(member) &&
        isString(member[required]),
    )
  );
}

/**
 * @param {unknown} value
 * @returns {value is IconCollection}
 */
function isIconCollection(value) {
  return (
    hasIconifyOptionals(value) &&
    isPlainRecord(value) &&
    isString(value.prefix) &&
    isIconifyTable(value.icons, "body") &&
    (value.aliases === undefined || isIconifyTable(value.aliases, "parent")) &&
    (value.lastModified === undefined || isNumber(value.lastModified))
  );
}

/**
 * An icon collection: the JSON file of an `@iconify-json/<prefix>` package.
 *
 * @param {unknown} content The file's JSON
 * @returns {IconCollection}
 * @throws {Error} When it is not an Iconify icon set
 */
export function iconCollectionOf(content) {
  if (!isIconCollection(content))
    throw new Error("the icon collection is not an Iconify icon set");
  return content;
}

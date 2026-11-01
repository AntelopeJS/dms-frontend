import { isRecord, isString } from "./type-guards.mjs";

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

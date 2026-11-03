/**
 * Reads what a JSON answer holds without assuming its shape.
 */

/** @typedef {Record<string, unknown>} Row */

/**
 * @param {unknown} value Anything a JSON answer holds
 * @returns {value is Row} Whether it is an object
 */
export function isRow(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value Anything a JSON answer holds
 * @returns {value is string} Whether it is a string
 */
export function isText(value) {
  return typeof value === "string";
}

/**
 * @param {unknown} value Anything a JSON answer holds
 * @returns {value is number} Whether it is a number
 */
export function isNumber(value) {
  return typeof value === "number";
}

/**
 * @param {string} text JSON text
 * @returns {unknown} What it holds, or undefined when it is not JSON
 */
export function parseJson(text) {
  try {
    /** @type {unknown} */
    const value = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value A value
 * @param {string[]} path Keys to follow
 * @returns {unknown} What the path reaches, or undefined
 */
export function at(value, ...path) {
  let current = value;
  for (const key of path) {
    if (!isRow(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * @param {unknown} value A value
 * @param {string[]} path Keys to follow
 * @returns {Row | undefined} The object the path reaches
 */
export function rowAt(value, ...path) {
  const found = at(value, ...path);
  return isRow(found) ? found : undefined;
}

/**
 * @param {unknown} value A value
 * @param {string[]} path Keys to follow
 * @returns {string | undefined} The string the path reaches
 */
export function textAt(value, ...path) {
  const found = at(value, ...path);
  return isText(found) ? found : undefined;
}

/**
 * @param {unknown} value A value
 * @param {string[]} path Keys to follow
 * @returns {number | undefined} The number the path reaches
 */
export function numberAt(value, ...path) {
  const found = at(value, ...path);
  return isNumber(found) ? found : undefined;
}

/**
 * @param {unknown} value A value
 * @param {string[]} path Keys to follow
 * @returns {unknown[]} The array the path reaches, or an empty one
 */
export function listAt(value, ...path) {
  const found = at(value, ...path);
  return Array.isArray(found) ? found : [];
}

/**
 * @param {unknown} value A value
 * @returns {string[]} The keys of an object, or none
 */
export function keysOf(value) {
  return isRow(value) ? Object.keys(value) : [];
}

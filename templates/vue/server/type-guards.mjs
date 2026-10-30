/**
 * Whether `value` is a string primitive, a boxed `String` excluded.
 *
 * @param {unknown} value The value to test
 * @returns {value is string} Whether `typeof value` is `"string"`
 */
export function isString(value) {
  return typeof value === "string";
}

/**
 * Whether `value` is a number primitive, `NaN` and the infinities included.
 *
 * @param {unknown} value The value to test
 * @returns {value is number} Whether `typeof value` is `"number"`
 */
export function isNumber(value) {
  return typeof value === "number";
}

/**
 * Whether `value` is a boolean primitive.
 *
 * @param {unknown} value The value to test
 * @returns {value is boolean} Whether `typeof value` is `"boolean"`
 */
export function isBoolean(value) {
  return typeof value === "boolean";
}

/**
 * Whether `value` is callable: a function, an arrow, a class or a method.
 *
 * @param {unknown} value The value to test
 * @returns {value is Function} Whether `typeof value` is `"function"`
 */
export function isFunction(value) {
  return typeof value === "function";
}

/**
 * Whether `value` is an object other than `null`: arrays are objects.
 *
 * @param {unknown} value The value to test
 * @returns {value is object} Whether `typeof value` is `"object"` and `value` is not `null`
 */
export function isNonNullObject(value) {
  return typeof value === "object" && value !== null;
}

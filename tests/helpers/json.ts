import assert from "node:assert/strict";
import { readText } from "./files";
import { isFlag, isNumber, isObjectLike, isText } from "./guards";

/** What `JSON.parse` can answer. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Whether `value` is made of JSON values only, at every depth. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isText(value) || isNumber(value) || isFlag(value))
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isObjectLike(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isJsonValue)
  );
}

/** Whether a JSON value is an object rather than a list, a scalar or null. */
export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return isObjectLike(value) && !Array.isArray(value);
}

/** The JSON a text holds. */
export function parseJson(text: string): JsonValue {
  const parsed: unknown = JSON.parse(text);
  assert.ok(isJsonValue(parsed), "the text holds JSON values only");
  return parsed;
}

/** The JSON a file holds. */
export function readJson(path: string | URL): JsonValue {
  return parseJson(readText(path));
}

/** The JSON a response answered with. */
export async function responseJson(response: Response): Promise<JsonValue> {
  const body: unknown = await response.json();
  assert.ok(isJsonValue(body), "the response holds JSON values only");
  return body;
}

/**
 * The value at `path` below `value`, following only keys the objects hold
 * themselves, or `undefined` when a key is missing on the way.
 */
export function jsonAt(
  value: JsonValue | undefined,
  ...path: string[]
): JsonValue | undefined {
  let current = value;
  for (const key of path) {
    if (!isJsonObject(current) || !Object.hasOwn(current, key))
      return undefined;
    current = current[key];
  }
  return current;
}

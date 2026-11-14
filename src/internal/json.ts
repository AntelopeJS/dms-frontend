import { isFlag, isNumber, isText } from "./guards";
import { isPlainObject } from "./plain-object";

/** A value `JSON.parse` can answer. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Whether `value` is made of JSON values only, at every depth. */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || isText(value) || isNumber(value) || isFlag(value))
    return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

/** Whether `value` is an object of JSON values. */
export function isJsonObject(
  value: unknown,
): value is { [key: string]: JsonValue } {
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

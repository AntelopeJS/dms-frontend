import { isText } from "../../src/internal/guards";
export {
  isCallable,
  isFlag,
  isNumber,
  isObjectLike,
  isText,
} from "../../src/internal/guards";

/** Whether `value` is a list of strings. */
export function isTextList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  const items: unknown[] = value;
  return items.every(isText);
}

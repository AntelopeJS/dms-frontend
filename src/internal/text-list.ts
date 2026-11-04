import { isText } from "./guards";

/** @internal */
export function isTextList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  const items: unknown[] = value;
  return items.every(isText);
}

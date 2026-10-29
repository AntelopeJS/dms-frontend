/** @internal */
export function isText(value: unknown): value is string {
  return typeof value === "string";
}

/** @internal */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** @internal */
export function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** @internal */
export function isCallable(
  value: unknown,
): value is (...args: never[]) => void {
  return typeof value === "function";
}

/** @internal */
export function isObjectLike(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

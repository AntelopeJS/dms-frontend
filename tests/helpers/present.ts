import assert from "node:assert/strict";

/** `value` once it is known to be set: the test fails here, naming `what`, instead of at a later property read. */
export function present<T>(value: T | null | undefined, what = "value"): T {
  assert.ok(value !== null && value !== undefined, `${what} is set`);
  return value;
}

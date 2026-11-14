import * as assert from "node:assert/strict";
import { it } from "node:test";

void it("leaves an interval running", () => {
  const interval = setInterval(() => undefined, 1000);
  assert.ok(interval.hasRef());
});

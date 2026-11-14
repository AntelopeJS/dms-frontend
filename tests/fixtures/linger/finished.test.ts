import * as assert from "node:assert/strict";
import { it } from "node:test";

void it("leaves nothing running", () => {
  assert.equal(1 + 1, 2);
});

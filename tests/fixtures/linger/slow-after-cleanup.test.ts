import * as assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, it } from "node:test";

after(async () => {
  await sleep(15_000);
});

void it("cleans up for longer than the linger limit", () => {
  assert.equal(1 + 1, 2);
});

import * as assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, it } from "node:test";

afterEach(async () => {
  await sleep(12_000);
});

void it("cleans up in t.after for longer than the linger limit", (t) => {
  t.after(async () => {
    await sleep(12_000);
  });
  assert.equal(1 + 1, 2);
});

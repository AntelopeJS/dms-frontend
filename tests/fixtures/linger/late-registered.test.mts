import * as assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { it } from "node:test";

void it("runs before the top-level await", () => {
  assert.equal(1 + 1, 2);
});

await sleep(100);

void it("runs after the top-level await", async () => {
  await sleep(12_000);
  assert.equal(2 + 2, 4);
});

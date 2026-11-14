import * as assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, it } from "node:test";

after(async () => {
  await sleep(3000);
});

void it("runs before the top-level await", () => {
  assert.equal(1 + 1, 2);
});

await sleep(100);

void it("runs after the top-level await", async () => {
  await sleep(14_000);
  assert.equal(2 + 2, 4);
});

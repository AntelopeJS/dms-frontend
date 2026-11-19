import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const CHECK = resolve(
  __dirname,
  "../.agents/skills/formal-backend-exposure/check.mjs",
);
const TIMEOUT_MS = 60_000;

void describe("what reaches the backend, for any deployment and visit", () => {
  void it("lets through only what the docs allow and breaks no rule the record does not list", () => {
    const run = spawnSync(process.execPath, [CHECK], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
    assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  });
});

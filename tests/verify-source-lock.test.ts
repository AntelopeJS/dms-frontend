import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { lockVerification } from "../src/verify-source-lock";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

const LOCK = join(__dirname, "..", "src", "verify-source-lock.ts");

void it("refuses a second verification of a layer while the first runs, naming its pid", () => {
  const layer = temporaryDirectory("verify-source-lock-");
  const release = lockVerification(layer);
  try {
    assert.throws(
      () => lockVerification(layer),
      (error) =>
        error instanceof CliError &&
        error.message.includes("is already running") &&
        error.problem.reason?.includes(`Process ${process.pid} `) === true,
    );
  } finally {
    release();
  }
  lockVerification(layer)();
});

void it("takes over the lock of a verification that died holding it", () => {
  const layer = temporaryDirectory("verify-source-lock-");
  const killed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `require(${JSON.stringify(LOCK)}).lockVerification(${JSON.stringify(layer)});
      process.kill(process.pid, "SIGKILL");`,
    ],
    { timeout: 10_000, killSignal: "SIGKILL" },
  );
  assert.equal(killed.signal, "SIGKILL");
  lockVerification(layer)();
});

void it("lets verifications of different layers run side by side", () => {
  const release = lockVerification(temporaryDirectory("verify-source-lock-"));
  try {
    assert.doesNotThrow(() =>
      lockVerification(temporaryDirectory("verify-source-lock-"))(),
    );
  } finally {
    release();
  }
});

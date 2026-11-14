import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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

/** Leaves the lock of `layer` behind, held by a pid that is gone. */
function dieHoldingLock(layer: string): void {
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
}

const RACERS = 6;
const RACE_DELAY_MS = 3000;
const HOLD_MS = 1500;

/** Starts `RACERS` processes that lock `layer` at the same instant; resolves with what each one got. */
async function race(layer: string): Promise<string[]> {
  const startAt = Date.now() + RACE_DELAY_MS;
  const script = `
    const { lockVerification } = require(${JSON.stringify(LOCK)});
    setTimeout(() => {
      while (Date.now() < ${startAt});
      try {
        const release = lockVerification(${JSON.stringify(layer)});
        process.stdout.write("held");
        setTimeout(release, ${HOLD_MS});
      } catch (error) {
        process.stdout.write(error.message.includes("is already running") ? "refused" : error.message);
      }
    }, ${startAt} - Date.now() - 20);
  `;
  return Promise.all(
    Array.from({ length: RACERS }, async () => {
      const child = spawn(process.execPath, ["--import", "tsx", "-e", script], {
        stdio: ["ignore", "pipe", "inherit"],
        timeout: RACE_DELAY_MS + 10_000,
        killSignal: "SIGKILL",
      });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        output += chunk;
      });
      await once(child, "close");
      return output;
    }),
  );
}

void it("takes over the lock of a verification that died holding it", () => {
  const layer = temporaryDirectory("verify-source-lock-");
  dieHoldingLock(layer);
  assert.doesNotThrow(() => lockVerification(layer)());
});

void it("takes over the lock after a run died while taking it over", () => {
  const layer = temporaryDirectory("verify-source-lock-");
  dieHoldingLock(layer);
  const killed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `const fs = require("node:fs");
      const rmSync = fs.rmSync;
      fs.rmSync = (path, options) => {
        if (String(path).endsWith(".pid")) process.kill(process.pid, "SIGKILL");
        return rmSync(path, options);
      };
      require(${JSON.stringify(LOCK)}).lockVerification(${JSON.stringify(layer)});`,
    ],
    { timeout: 10_000, killSignal: "SIGKILL" },
  );
  assert.equal(killed.signal, "SIGKILL");
  assert.doesNotThrow(() => lockVerification(layer)());
});

void it("gives the lock of a dead verification to one of the runs that race for it", async () => {
  const layer = temporaryDirectory("verify-source-lock-");
  dieHoldingLock(layer);
  const outcomes = await race(layer);
  assert.deepEqual(outcomes.toSorted(), [
    "held",
    ...Array.from({ length: RACERS - 1 }, () => "refused"),
  ]);
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

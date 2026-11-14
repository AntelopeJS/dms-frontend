import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { lockVerification } from "../src/verify-source-lock";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { isTextList } from "./helpers/guards";

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

/** Runs `script` in a process that dies before it releases any lock it took. */
function dieAfter(script: string): void {
  const killed = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `${script}\nprocess.kill(process.pid, "SIGKILL");`,
    ],
    { timeout: 10_000, killSignal: "SIGKILL" },
  );
  assert.notEqual(
    killed.status,
    0,
    "the run died before it released its locks",
  );
}

/** Leaves the lock of each target behind, held by a pid that is gone. */
function dieHoldingLocks(targets: string[]): void {
  dieAfter(`
    const { lockVerification } = require(${JSON.stringify(LOCK)});
    for (const target of ${JSON.stringify(targets)}) lockVerification(target);
  `);
}

/** Leaves, beside the dead lock of each target, the takeover file of a run that died while it removed the lock. */
function dieTakingOver(targets: string[]): void {
  dieAfter(`
    const fs = require("node:fs");
    const rmSync = fs.rmSync;
    fs.rmSync = (path, options) =>
      String(path).endsWith(".new") ? rmSync(path, options) : undefined;
    const { lockVerification } = require(${JSON.stringify(LOCK)});
    for (const target of ${JSON.stringify(targets)}) {
      try {
        lockVerification(target);
      } catch {}
    }
  `);
}

const RACERS = 8;
const TRIALS = 120;
const RACE_DELAY_MS = 3000;
const TRIAL_MS = 20;

function parseOutcomes(output: string): string[] {
  const outcomes: unknown = JSON.parse(output);
  assert.ok(isTextList(outcomes), `a list of outcomes: ${output}`);
  return outcomes;
}

/**
 * `RACERS` processes lock each target in turn, all of them at the same
 * instant, and keep what they took until every trial is over. Resolves with
 * what each process got, per target.
 */
async function race(targets: string[]): Promise<string[][]> {
  const startAt = Date.now() + RACE_DELAY_MS;
  const script = `
    const { lockVerification } = require(${JSON.stringify(LOCK)});
    const outcomes = [];
    const releases = [];
    setTimeout(() => {
      ${JSON.stringify(targets)}.forEach((target, trial) => {
        while (Date.now() < ${startAt} + trial * ${TRIAL_MS});
        try {
          releases.push(lockVerification(target));
          outcomes.push("held");
        } catch (error) {
          outcomes.push(error.message.includes("is already running") ? "refused" : error.message);
        }
      });
      while (Date.now() < ${startAt} + ${targets.length + 1} * ${TRIAL_MS});
      for (const release of releases) release();
      process.stdout.write(JSON.stringify(outcomes));
    }, ${startAt} - Date.now() - 20);
  `;
  const racers = await Promise.all(
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
      return parseOutcomes(output);
    }),
  );
  return targets.map((_, trial) =>
    racers.map((outcomes) => outcomes[trial] ?? "missing").sort(),
  );
}

function trialTargets(): string[] {
  const root = temporaryDirectory("verify-source-lock-");
  return Array.from({ length: TRIALS }, (_, trial) => join(root, `${trial}`));
}

const ONE_HOLDER = [
  "held",
  ...Array.from({ length: RACERS - 1 }, () => "refused"),
];

void it("takes over the lock of a verification that died holding it", () => {
  const layer = temporaryDirectory("verify-source-lock-");
  dieHoldingLocks([layer]);
  assert.doesNotThrow(() => lockVerification(layer)());
});

void it("takes over the lock after two runs died while taking it over, one after the other", () => {
  const layer = temporaryDirectory("verify-source-lock-");
  dieHoldingLocks([layer]);
  dieTakingOver([layer]);
  dieTakingOver([layer]);
  assert.doesNotThrow(() => lockVerification(layer)());
});

void it("gives the lock of a dead verification to one of the runs that race for it", async () => {
  const targets = trialTargets();
  dieHoldingLocks(targets);
  assert.deepEqual(
    await race(targets),
    targets.map(() => ONE_HOLDER),
  );
});

void it("gives the lock to one racing run after a run died while taking it over", async () => {
  const targets = trialTargets();
  dieHoldingLocks(targets);
  dieTakingOver(targets);
  assert.deepEqual(
    await race(targets),
    targets.map(() => ONE_HOLDER),
  );
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

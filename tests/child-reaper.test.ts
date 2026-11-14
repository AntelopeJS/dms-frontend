import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, it } from "node:test";
import { isPidAlive } from "../src/discovery";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { readText } from "./helpers/files";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "reaped-command-cli.ts",
);
const POLL_MS = 50;
const TREE_TIMEOUT_MS = 20_000;
const REAP_TIMEOUT_MS = 5000;

const started: number[] = [];
after(() => {
  for (const pid of started) if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
});

async function poll<T>(
  read: () => T | undefined,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined || Date.now() > deadline) return value;
    await new Promise((settle) => setTimeout(settle, POLL_MS));
  }
}

/**
 * Starts the fixture, which runs a child and grandchild with `runCommand`,
 * kills it with SIGKILL once both are up, and returns those still alive
 * after the reap timeout.
 */
async function survivorsOfKill(): Promise<number[]> {
  const pidFile = join(temporaryDirectory("child-reaper-"), "tree.pid");
  const parent = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    stdio: "ignore",
    env: { ...process.env, DMS_TEST_PID_FILE: pidFile },
  });
  assert.ok(parent.pid !== undefined, "the fixture started");
  started.push(parent.pid);
  const tree = await poll(
    () =>
      existsSync(pidFile)
        ? readText(pidFile).split(" ").map(Number)
        : undefined,
    TREE_TIMEOUT_MS,
  );
  assert.ok(tree, "the child and grandchild started");
  started.push(...tree);
  parent.kill("SIGKILL");
  await poll(() => (tree.some(isPidAlive) ? undefined : true), REAP_TIMEOUT_MS);
  return tree.filter(isPidAlive);
}

void it(
  "kills the children of a process killed with SIGKILL within 5 s",
  { skip: process.platform === "win32" },
  async () => {
    assert.deepEqual(await survivorsOfKill(), []);
  },
);

import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { OWNER_FILE } from "../src/child-reaper";
import { isPidAlive } from "../src/discovery";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { readText } from "./helpers/files";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const FIXTURE = join(FIXTURES, "reaped-command-cli.ts");
const RUNNER_CLI_FIXTURE = join(FIXTURES, "source-runner-cli.ts");
const POLL_MS = 50;
const START_TIMEOUT_MS = 20_000;
const REAP_TIMEOUT_MS = 5000;

const started: number[] = [];
const workspaces: string[] = [];
after(() => {
  for (const pid of started) if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
  for (const workspace of workspaces)
    rmSync(workspace, { recursive: true, force: true });
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

interface Run {
  pid: number;
  /** The child and grandchild the run started with `runCommand`. */
  tree: number[];
  workspace: string;
}

/** Starts the fixture: a run with a reaper, a workspace and a process tree in it. */
async function startRun(): Promise<Run> {
  const files = temporaryDirectory("child-reaper-");
  const pidFile = join(files, "tree.pid");
  const workspaceFile = join(files, "workspace");
  const run = spawn(process.execPath, ["--import", "tsx", FIXTURE], {
    stdio: "ignore",
    env: {
      ...process.env,
      DMS_TEST_PID_FILE: pidFile,
      DMS_TEST_WORKSPACE_FILE: workspaceFile,
    },
  });
  assert.ok(run.pid !== undefined, "the run started");
  started.push(run.pid);
  const tree = await poll(
    () =>
      existsSync(pidFile)
        ? readText(pidFile).split(" ").map(Number)
        : undefined,
    START_TIMEOUT_MS,
  );
  assert.ok(tree, "the child and grandchild started");
  started.push(...tree);
  const workspace = readText(workspaceFile);
  workspaces.push(workspace);
  return { pid: run.pid, tree, workspace };
}

/** Kills `run` with SIGKILL and waits up to 5 s for its tree to end. */
async function killRun(run: Run): Promise<void> {
  process.kill(run.pid, "SIGKILL");
  await poll(
    () => (run.tree.some(isPidAlive) ? undefined : true),
    REAP_TIMEOUT_MS,
  );
}

void describe(
  "a run killed with SIGKILL",
  { skip: process.platform === "win32" },
  () => {
    void it("loses its children and its workspace within 5 s, and a run beside it keeps its own", async () => {
      const [killed, other] = await Promise.all([startRun(), startRun()]);
      const ownerless = join(
        dirname(killed.workspace),
        `${basename(killed.workspace)}-ownerless`,
      );
      mkdirSync(ownerless);
      workspaces.push(ownerless);
      await killRun(killed);
      await poll(
        () => (existsSync(killed.workspace) ? undefined : true),
        REAP_TIMEOUT_MS,
      );
      assert.deepEqual(killed.tree.filter(isPidAlive), []);
      assert.equal(existsSync(killed.workspace), false);
      assert.deepEqual(other.tree.filter(isPidAlive), other.tree);
      assert.equal(isPidAlive(other.pid), true);
      assert.equal(existsSync(other.workspace), true);
      assert.equal(existsSync(ownerless), true);
    });

    void it("keeps a workspace whose owner file no longer holds its token", async () => {
      const run = await startRun();
      writeFileSync(join(run.workspace, OWNER_FILE), "another run");
      await killRun(run);
      assert.deepEqual(run.tree.filter(isPidAlive), []);
      assert.equal(existsSync(run.workspace), true);
    });

    void it("keeps a workspace whose owner file is gone", async () => {
      const run = await startRun();
      rmSync(join(run.workspace, OWNER_FILE));
      await killRun(run);
      assert.deepEqual(run.tree.filter(isPidAlive), []);
      assert.equal(existsSync(run.workspace), true);
    });
  },
);

void describe(
  "a CLI killed with SIGKILL while its source runner builds",
  { skip: process.platform === "win32" },
  () => {
    void it("loses its runner, the runner's children and its workspace within 5 s", async () => {
      const files = temporaryDirectory("child-reaper-");
      const pidFile = join(files, "tree.pid");
      const workspaceFile = join(files, "workspace");
      const cli = spawn(
        process.execPath,
        ["--import", "tsx", RUNNER_CLI_FIXTURE],
        {
          stdio: "ignore",
          env: {
            ...process.env,
            DMS_TEST_PID_FILE: pidFile,
            DMS_TEST_WORKSPACE_FILE: workspaceFile,
          },
        },
      );
      assert.ok(cli.pid !== undefined, "the CLI started");
      started.push(cli.pid);
      const tree = await poll(
        () =>
          existsSync(pidFile)
            ? readText(pidFile).split(" ").map(Number)
            : undefined,
        START_TIMEOUT_MS,
      );
      assert.ok(tree, "the runner's child and grandchild started");
      started.push(...tree);
      const [runnerPid, workspace] = readText(workspaceFile).split(" ");
      const runner = Number(runnerPid);
      started.push(runner);
      workspaces.push(workspace);
      process.kill(cli.pid, "SIGKILL");
      const processes = [runner, ...tree];
      await poll(
        () =>
          processes.some(isPidAlive) || existsSync(workspace)
            ? undefined
            : true,
        REAP_TIMEOUT_MS,
      );
      assert.deepEqual(processes.filter(isPidAlive), []);
      assert.equal(existsSync(workspace), false);
    });
  },
);

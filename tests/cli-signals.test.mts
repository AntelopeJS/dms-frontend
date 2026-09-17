import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const CLI_FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/run-command-cli.ts",
);

let scratch: string;

/**
 * Start the CLI fixture and wait until the child it spawned through
 * runCommand has published its pid.
 */
async function startCli(mode: "wait" | "self-exit") {
  const pidFile = join(scratch, `${mode}.pid`);
  const cli = spawn(
    process.execPath,
    ["--import", "tsx", CLI_FIXTURE, pidFile, mode],
    { stdio: "ignore" },
  );
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (settle) => cli.on("exit", (code, signal) => settle({ code, signal })),
  );
  const pid = await waitFor(() => {
    const raw = readFileSync(pidFile, "utf8").trim();
    return raw ? Number.parseInt(raw, 10) : undefined;
  });
  return { cli, exited, pid };
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = probe();
      if (value !== undefined) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline) throw new Error("timed out waiting for child");
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Signal delivery is a POSIX notion; on Windows the CLI can only terminate
// the child outright, which the "self-exit" path already covers.
const describeSignals = process.platform === "win32" ? describe.skip : describe;

describeSignals("runCommand child lifetime", () => {
  before(() => {
    scratch = mkdtempSync(join(tmpdir(), "dms-frontend-signals-"));
  });
  after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("forwards SIGINT to the child and reports its signalled exit", async () => {
    const { cli, exited, pid } = await startCli("wait");

    // Only the CLI is signalled, not the process group: this is the case
    // where the server used to survive and keep the port bound.
    cli.kill("SIGINT");

    // 130 = 128 + SIGINT, i.e. the child died from the forwarded signal.
    assert.deepEqual(await exited, { code: 130, signal: null });
    assert.equal(isAlive(pid), false);
  });

  it("kills the child when the CLI exits for any other reason", async () => {
    const { exited, pid } = await startCli("self-exit");

    assert.deepEqual(await exited, { code: 3, signal: null });
    await waitFor(() => (isAlive(pid) ? undefined : true));
  });
});

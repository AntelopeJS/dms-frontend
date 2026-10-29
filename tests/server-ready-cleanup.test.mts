import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

const CLEANUP_FAILURE = "tests/fixtures/failing-server-cleanup.mjs";
const LIMIT_MS = 30_000;

it(
  "fails, and stops its development server, when removing the server's directory fails",
  { timeout: LIMIT_MS + 10_000 },
  async () => {
    const privateTmp = mkdtempSync(join(tmpdir(), "dms-cleanup-"));
    const {
      NODE_OPTIONS: _sharded,
      NODE_TEST_CONTEXT: _reporting,
      ...env
    } = process.env;
    const run = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        `./${CLEANUP_FAILURE}`,
        "--test",
        "--test-name-pattern=loopback address without HOST",
        "tests/server-ready.test.mts",
      ],
      {
        env: { ...env, TMPDIR: privateTmp },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    run.stdout.on("data", (chunk: Buffer) => (output += chunk));
    run.stderr.on("data", (chunk: Buffer) => (output += chunk));
    const hung = setTimeout(() => process.kill(-run.pid!, "SIGKILL"), LIMIT_MS);
    const code = await new Promise<number | null>((settle) =>
      run.on("exit", (exitCode) => settle(exitCode)),
    );
    clearTimeout(hung);
    rmSync(privateTmp, { recursive: true, force: true });
    assert.notEqual(code, null, `the run hung: ${output}`);
    assert.equal(code, 1, "the failed cleanup fails the test");
    assert.match(output, /ENOTEMPTY/);
  },
);

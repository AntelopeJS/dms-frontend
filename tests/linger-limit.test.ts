import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const TESTS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(TESTS);
const FIXTURES = join(TESTS, "fixtures", "linger");

interface RunOutcome {
  readonly code: number | null;
  readonly output: string;
}

function runSuite(files: readonly string[]): Promise<RunOutcome> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const args = [
    "--import",
    "tsx",
    "--import",
    "./tests/helpers/linger-limit.ts",
    "--test",
    "--test-reporter=tap",
    ...files.map((file) => join(FIXTURES, file)),
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      timeout: 60_000,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));
    child.on("close", (code) => resolve({ code, output }));
  });
}

void it("fails a test file that leaves an interval running, naming the file, and passes the others", async () => {
  const outcome = await runSuite([
    "leaked-interval.test.ts",
    "finished.test.ts",
  ]);

  assert.equal(outcome.code, 1, outcome.output);
  assert.match(outcome.output, /^not ok \d+ - .*leaked-interval\.test\.ts$/mu);
  assert.match(
    outcome.output,
    /leaked-interval\.test\.ts still runs .* held by: .*Timeout/u,
  );
  assert.doesNotMatch(outcome.output, /^not ok \d+ - .*finished\.test\.ts$/mu);
});

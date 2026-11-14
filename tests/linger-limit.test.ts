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

function escaped(file: string): string {
  return file.replaceAll(".", String.raw`\.`);
}

const LINGERING = ["leaked-interval.test.ts", "top-level-interval.test.ts"];
const HEALTHY = [
  "finished.test.ts",
  "slow-after-cleanup.test.ts",
  "late-registered.test.mts",
];

void it("fails each test file that leaves an interval running, naming it, and passes the files whose tests or hooks run past the limit", async () => {
  const outcome = await runSuite([...LINGERING, ...HEALTHY]);

  assert.equal(outcome.code, 1, outcome.output);
  for (const name of LINGERING.map(escaped)) {
    assert.match(outcome.output, new RegExp(`^not ok \\d+ - .*${name}$`, "mu"));
    assert.match(
      outcome.output,
      new RegExp(`${name} still runs .* held by: .*Timeout`, "u"),
    );
  }
  for (const name of HEALTHY.map(escaped)) {
    assert.doesNotMatch(
      outcome.output,
      new RegExp(`^not ok \\d+ - .*${name}$`, "mu"),
    );
  }
  assert.match(outcome.output, /^ok \d+ - runs after the top-level await$/mu);
  assert.match(
    outcome.output,
    /^ok \d+ - cleans up for longer than the linger limit$/mu,
  );
});

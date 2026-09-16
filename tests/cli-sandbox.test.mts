import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const packageJson = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);

const cliEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/index.ts",
);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the CLI the way a user outside any DMS project would: an empty cwd and
 * an empty HOME, so `clean --all` can never reach the real workspaces.
 */
async function runCli(args: string[]): Promise<CliResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "dms-cli-"));
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), cliEntry, ...args],
      {
        cwd: sandbox,
        env: {
          ...process.env,
          HOME: sandbox,
          NO_UPDATE_NOTIFIER: "1",
          DMS_API_BASE_URL: "",
        },
      },
    );
    return { code: 0, stdout, stderr };
  } catch (err: any) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
    };
  }
}

describe("running outside a DMS project", () => {
  it("prints help without a project", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: ajs-dms/);
    assert.match(result.stdout, /--no-update-check/);
  });

  it("reports the version without a project", async () => {
    const result = await runCli(["--version"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), packageJson.version);
  });

  it("cleans an empty home without a project", async () => {
    const result = await runCli(["clean", "--all"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No workspaces found/);
  });

  it("accepts the update-check opt-out anywhere on the command line", async () => {
    const result = await runCli(["clean", "--all", "--no-update-check"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /No workspaces found/);
  });

  it("names what is missing for a project-bound command", async () => {
    const build = await runCli(["build"]);
    assert.equal(build.code, 1);
    assert.match(build.stdout, /Backend URL is required.*DMS_API_BASE_URL/);

    const dev = await runCli(["dev"]);
    assert.equal(dev.code, 1);
    assert.match(dev.stdout, /no running antelope project found/);
    assert.match(dev.stdout, /-b <url>/);
  });
});

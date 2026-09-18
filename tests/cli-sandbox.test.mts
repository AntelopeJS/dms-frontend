import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

interface RunCliOptions {
  /** Files written into the sandbox cwd before the CLI starts. */
  files?: Record<string, string>;
  /** Variables layered onto the child environment; undefined removes one. */
  env?: Record<string, string | undefined>;
}

/**
 * Run the CLI the way a user outside any DMS project would: an empty cwd and
 * an empty HOME, so `clean --all` can never reach the real workspaces.
 */
async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "dms-cli-"));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    writeFileSync(join(sandbox, name), content);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox,
    NO_UPDATE_NOTIFIER: "1",
    DMS_API_BASE_URL: "",
    ...options.env,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), cliEntry, ...args],
      { cwd: sandbox, env: env as NodeJS.ProcessEnv },
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
    assert.match(result.stdout, /Usage: ajs dms/);
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

/**
 * `start` is the cheapest command that proves a variable reached Commander:
 * it needs only a backend URL, touches no network, and names the URL it
 * resolved in the "build first" hint it prints when the workspace is absent.
 */
describe("loading the project .env", () => {
  const ENV_ONLY = { DMS_API_BASE_URL: undefined };

  it("fills a variable the environment does not define", async () => {
    const result = await runCli(["start"], {
      files: { ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n" },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, /Backend URL is required/);
    assert.match(result.stdout, /Production build not found/);
    assert.match(result.stdout, /build -b http:\/\/127\.0\.0\.1:5010/);
  });

  it("lets a real environment variable win over the .env", async () => {
    const result = await runCli(["start"], {
      files: { ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n" },
      env: { DMS_API_BASE_URL: "http://127.0.0.1:5999" },
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /build -b http:\/\/127\.0\.0\.1:5999/);
    assert.doesNotMatch(result.stdout, /5010/);
  });

  it("lets .env.local win over .env", async () => {
    const result = await runCli(["start"], {
      files: {
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
        ".env.local": "DMS_API_BASE_URL=http://127.0.0.1:5011\n",
      },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /build -b http:\/\/127\.0\.0\.1:5011/);
  });

  it("runs normally in a directory with no .env", async () => {
    const result = await runCli(["start"], { env: ENV_ONLY });

    assert.equal(result.code, 1);
    assert.match(result.stdout, /Backend URL is required/);
  });

  it("documents the .env contract in the help epilogue", async () => {
    const result = await runCli(["--help"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\.env\.local then \.env/);
    assert.match(result.stdout, /already\s+set in the environment always wins/);
  });
});

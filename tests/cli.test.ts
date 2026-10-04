import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  cmdVerifySource,
  parseLocalPackages,
} from "../src/commands/verify-source";
import { cmdBuild } from "../src/commands/build";
import { cmdClean } from "../src/commands/clean";
import { cmdDev } from "../src/commands/dev";
import { cmdPrepare } from "../src/commands/prepare";
import { cmdStart } from "../src/commands/start";
import {
  parseBackendUrl,
  parsePort,
  resolveSessionSecret,
  UsageError,
} from "../src/config";
import { error, info, Spinner, success, warning } from "../src/utils/cli-ui";

/**
 * Match a UsageError on its message and, in order, on its detail lines.
 */
function usageError(message: RegExp, ...details: RegExp[]) {
  return (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, message);
    for (const detail of details) assert.match(err.details.join("\n"), detail);
    return true;
  };
}

const packageJson = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);

describe("DMS CLI plugin", () => {
  it("resolves session secrets by command mode", () => {
    const generated = resolveSessionSecret("dev", undefined);
    assert.match(generated, /^[0-9a-f]{64}$/);
    assert.equal(
      resolveSessionSecret("dev", "explicit-session-secret-32-characters!!"),
      "explicit-session-secret-32-characters!!",
    );

    for (const mode of ["dev", "build", "start"] as const) {
      assert.throws(
        () => resolveSessionSecret(mode, ""),
        usageError(/DMS_SESSION_SECRET is empty/),
      );
      assert.throws(
        () => resolveSessionSecret(mode, "too-short"),
        usageError(/is too short: 9 characters, at least 32 needed/),
      );
    }
    for (const mode of ["build", "start"] as const) {
      assert.throws(
        () => resolveSessionSecret(mode, undefined),
        usageError(/DMS_SESSION_SECRET is not set/, /openssl rand -hex 32/),
      );
    }
  });

  it("accepts only http and https backend URLs", () => {
    assert.equal(
      parseBackendUrl("http://127.0.0.1:5010"),
      "http://127.0.0.1:5010",
    );
    assert.equal(
      parseBackendUrl("https://dms.example.com"),
      "https://dms.example.com",
    );
    assert.throws(
      () => parseBackendUrl("localhost:5010"),
      usageError(
        /Invalid backend URL 'localhost:5010'/,
        /-b http:\/\/localhost:5010/,
      ),
    );
    assert.throws(
      () => parseBackendUrl("ftp://dms.example.com"),
      usageError(/Invalid backend URL/, /http:\/\/ or https:\/\//),
    );
    assert.throws(() => parseBackendUrl("not a url"), UsageError);
  });

  it("accepts only ports from 0 to 65535", () => {
    assert.equal(parsePort("3001"), 3001);
    assert.equal(parsePort("0"), 0);
    assert.equal(parsePort("65535"), 65535);
    for (const value of ["abc", "65536", "70000", "3001abc", "-1", "1.5", ""]) {
      assert.throws(
        () => parsePort(value),
        usageError(/Invalid port/, /between 1 and 65535/),
      );
    }
  });

  it("publishes only the core-discoverable executable", () => {
    assert.equal(packageJson.name, "@antelopejs/dms-frontend");
    assert.deepEqual(packageJson.bin, { "ajs-dms": "./dist/index.js" });
  });

  it("declares the AntelopeJS CLI as an optional peer", () => {
    assert.equal(
      packageJson.peerDependencies["@antelopejs/core"],
      ">=1.7.0 <2",
    );
    assert.equal(
      packageJson.peerDependenciesMeta["@antelopejs/core"].optional,
      true,
    );
  });

  it("preserves the command surface", () => {
    const commands = [
      cmdDev(),
      cmdBuild(),
      cmdStart(),
      cmdPrepare(),
      cmdClean(),
    ];
    assert.deepEqual(
      commands.map((command) => command.name()),
      ["dev", "build", "start", "prepare", "clean"],
    );
  });
});

describe("verify-source CLI", () => {
  it("publishes source and local package options", () => {
    const command = cmdVerifySource().exitOverride();
    assert.equal(command.name(), "verify-source");
    assert.deepEqual(
      command.options.map((option) => option.attributeName()),
      ["layer", "module", "localPackage"],
    );
  });

  it("resolves local package bindings and rejects malformed values", () => {
    assert.deepEqual(parseLocalPackages(["@scope/package=../package"]), {
      "@scope/package": resolve("../package"),
    });
    assert.throws(
      () => parseLocalPackages(["@scope/package"]),
      usageError(/Invalid local package '@scope\/package'/, /name=path/),
    );
  });
});

/**
 * The test runner reports through this process's stdout, so stdout writes
 * still reach it: the assertions only look for the CLI's own text there.
 */
describe("CLI feedback streams", () => {
  let stdout: string;
  let stderr: string;
  const isTTY = process.stderr.isTTY;

  beforeEach(() => {
    stdout = "";
    stderr = "";
    const writeStdout = process.stdout.write.bind(process.stdout);
    mock.method(process.stdout, "write", (chunk: string, ...rest: any[]) => {
      stdout += chunk;
      return writeStdout(chunk, ...rest);
    });
    mock.method(process.stderr, "write", (chunk: string) => {
      stderr += chunk;
      return true;
    });
  });

  afterEach(() => {
    mock.restoreAll();
    process.stderr.isTTY = isTTY;
  });

  it("writes every status helper to stderr", () => {
    error("failed");
    warning("careful");
    info("note");
    success("done");

    assert.doesNotMatch(stdout, /failed|careful|note|done/);
    assert.match(stderr, /✗.*failed/);
    assert.match(stderr, /⚠.*careful/);
    assert.match(stderr, /ℹ.*note/);
    assert.match(stderr, /✓.*done/);
  });

  it("writes the piped spinner to stderr", async () => {
    process.stderr.isTTY = false;
    const spinner = new Spinner("Working...");
    await spinner.start();
    await spinner.fail("Broke");

    assert.doesNotMatch(stdout, /Working|Broke/);
    assert.equal(stderr, "  Working...\n✗ Broke\n");
  });

  it("draws the terminal spinner on stderr", async () => {
    process.stderr.isTTY = true;
    const spinner = new Spinner("Working...");
    await spinner.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await spinner.succeed("Ready");

    assert.doesNotMatch(stdout, /Working|Ready/);
    assert.match(stderr, /⠋.*Working\.\.\./);
    assert.match(stderr, /✓.*Ready\n$/);
  });
});

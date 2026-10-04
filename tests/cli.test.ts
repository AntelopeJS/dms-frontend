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
import { resolveSessionSecret } from "../src/config";
import { error, info, Spinner, success, warning } from "../src/utils/cli-ui";

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
      assert.throws(() => resolveSessionSecret(mode, ""), /at least 32/);
      assert.throws(
        () => resolveSessionSecret(mode, "too-short"),
        /at least 32/,
      );
    }
    for (const mode of ["build", "start"] as const) {
      assert.throws(
        () => resolveSessionSecret(mode, undefined),
        /set it explicitly/,
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
    assert.throws(() => parseLocalPackages(["@scope/package"]), /name=path/);
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

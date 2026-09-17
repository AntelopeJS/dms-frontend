import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  cmdVerifySource,
  parseLocalPackages,
} from "../src/commands/verify-source";
import { cmdBuild } from "../src/commands/build";
import { cmdClean } from "../src/commands/clean";
import { cmdDev } from "../src/commands/dev";
import { cmdPrepare } from "../src/commands/prepare";
import { cmdStart } from "../src/commands/start";

const packageJson = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);

describe("DMS CLI plugin", () => {
  it("publishes only the core-discoverable executable", () => {
    assert.equal(packageJson.name, "@antelopejs/dms-frontend");
    assert.deepEqual(packageJson.bin, { "ajs-dms": "./dist/index.js" });
  });

  it("declares the AntelopeJS CLI as an optional peer", () => {
    assert.equal(
      packageJson.peerDependencies["@antelopejs/core"],
      ">=1.6.0 <2",
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

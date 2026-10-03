import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPOSITORY, "dist/index.js");
const LOADED_MODULES = import.meta.resolve("./fixtures/loaded-modules.mjs");

/** Every module a run of the built CLI loaded. */
function loadedModules(args: string[]): string[] {
  const sandbox = mkdtempSync(join(tmpdir(), "dms-startup-"));
  const record = join(sandbox, "modules.json");
  const result = spawnSync(
    process.execPath,
    ["--import", LOADED_MODULES, CLI, ...args],
    {
      cwd: sandbox,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: sandbox,
        NO_UPDATE_NOTIFIER: "1",
        DMS_TEST_LOADED_MODULES: record,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(readFileSync(record, "utf8"));
}

/** What only a running command needs, and `--help` must not pay for. */
const COMMAND_MODULES = [
  /-action\.js$/,
  /[\\/]dist[\\/]common\.js$/,
  /[\\/]node_modules[\\/]unzipper[\\/]/,
  /[\\/]node_modules[\\/]semver[\\/]/,
  /[\\/]node_modules[\\/]chokidar[\\/]/,
];

const UNZIPPER = /[\\/]node_modules[\\/]unzipper[\\/]/;

describe("CLI startup", () => {
  it("loads no command implementation for help and version", () => {
    for (const args of [["--help"], ["--version"], ["dev", "--help"]]) {
      const loaded = loadedModules(args);
      for (const pattern of COMMAND_MODULES) {
        assert.deepEqual(
          loaded.filter((path) => pattern.test(path)),
          [],
          `${args.join(" ")} loaded ${pattern}`,
        );
      }
    }
  });

  it("loads the command that runs, without the archive reader", () => {
    const loaded = loadedModules(["clean", "--all"]);
    assert.deepEqual(
      loaded
        .filter((path) => path.endsWith("-action.js"))
        .map((path) => basename(path))
        .sort(),
      ["clean-action.js", "workspaces-action.js"],
    );
    assert.equal(
      loaded.some((path) => UNZIPPER.test(path)),
      false,
    );
  });
});

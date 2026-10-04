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
import {
  parseBackendUrl,
  parsePort,
  requireBackendUrl,
  resolveSessionSecret,
  UsageError,
} from "../src/config";
import {
  collectManifestSecrets,
  resolveManifestSecrets,
  reportManifestSecrets,
} from "../src/manifest-secrets";
import { formatAge, showPath, showWorkspace } from "../src/output";
import { memoryUi, problemText } from "./fixtures/memory-ui";

/**
 * Match a UsageError on its title and on the rest of what it prints.
 */
function usageError(title: RegExp, ...details: RegExp[]) {
  return (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.equal(err.exitCode, 2);
    assert.match(err.problem.title, title);
    for (const detail of details) assert.match(problemText(err), detail);
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

  it("requires the AntelopeJS CLI that publishes its output module", () => {
    assert.equal(
      packageJson.peerDependencies["@antelopejs/core"],
      ">=1.12.0 <2",
    );
    assert.equal(packageJson.peerDependenciesMeta, undefined);
    for (const dependency of ["figlet", "boxen", "chalk", "@types/figlet"]) {
      assert.equal(packageJson.dependencies[dependency], undefined);
      assert.equal(packageJson.devDependencies[dependency], undefined);
    }
  });

  it("requires a backend URL where nothing can discover one", () => {
    assert.equal(
      requireBackendUrl("http://127.0.0.1:5010"),
      "http://127.0.0.1:5010",
    );
    for (const value of [undefined, ""]) {
      assert.throws(
        () => requireBackendUrl(value),
        usageError(/Backend URL is required/, /→ Pass -b <url>/),
      );
    }
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

/** Starts every ANSI color sequence. */
const ESC = "\x1b";

const SECRET_NOT_SET = [
  "DMS_SESSION_SECRET is not set",
  "  build and start sign sessions with it, so it must stay the same across restarts.",
  "  {hint} Create one: openssl rand -hex 32, then set it in the environment or ./.env",
];

function secretNotSet(): UsageError {
  try {
    resolveSessionSecret("build", undefined);
  } catch (err) {
    if (err instanceof UsageError) return err;
  }
  throw new Error("expected a UsageError");
}

describe("CLI output", () => {
  it("prints an error with the core symbols, on stderr only", () => {
    const output = memoryUi();
    output.ui.problem(secretNotSet().problem);
    assert.equal(output.stdout(), "");
    assert.equal(
      output.stderr(),
      `✖ ${SECRET_NOT_SET.join("\n").replace("{hint}", "→")}\n`,
    );
  });

  it("falls back to ASCII symbols", () => {
    const output = memoryUi({ isUnicode: false });
    output.ui.problem(secretNotSet().problem);
    assert.equal(
      output.stderr(),
      `x ${SECRET_NOT_SET.join("\n").replace("{hint}", ">")}\n`,
    );
  });

  it("colors only the symbols, and only when colors are on", () => {
    const colored = memoryUi({ isColored: true });
    colored.ui.problem(secretNotSet().problem);
    assert.ok(
      colored.stderr().startsWith(`${ESC}[31m✖${ESC}[39m DMS_SESSION_SECRET`),
    );
    assert.ok(colored.stderr().includes(`${ESC}[36m→${ESC}[39m Create one`));

    const plain = memoryUi({ isColored: false });
    plain.ui.problem(secretNotSet().problem);
    assert.ok(!plain.stderr().includes(ESC));
  });

  it("lists where the server secrets come from as one block", () => {
    const output = memoryUi();
    reportManifestSecrets(
      resolveManifestSecrets(collectManifestSecrets([]), {}),
      "manifest",
      output.ui,
    );
    assert.equal(output.stdout(), "");
    assert.match(
      output.stderr(),
      /^ℹ Server secrets\n {2}DMS_HTML_RENDER_SECRET/,
    );
  });

  it("shows a workspace from ~, cut to its id on a terminal only", () => {
    const home = "/home/user";
    const id =
      "76672b089458f187ebe9586040f9b8ae79e01c9f990f5201f4475b8326d0f0ec";
    const dir = `${home}/.antelopejs/dms-frontend/${id}`;
    assert.equal(
      showWorkspace(dir, true, home),
      "~/.antelopejs/dms-frontend/76672b08…",
    );
    assert.equal(
      showWorkspace(dir, false, home),
      `~/.antelopejs/dms-frontend/${id}`,
    );
    assert.equal(showPath("/srv/app", home), "/srv/app");
    assert.equal(showPath(process.cwd(), home), ".");
  });

  it("says how old a cached manifest is", () => {
    const now = Date.parse("2026-10-03T14:00:00.000Z");
    assert.equal(formatAge("2026-10-03T13:59:30.000Z", now), "just now");
    assert.equal(formatAge("2026-10-03T13:55:00.000Z", now), "5 min ago");
    assert.equal(formatAge("2026-10-03T12:00:00.000Z", now), "2 h ago");
    assert.equal(formatAge("2026-10-02T14:00:00.000Z", now), "1 day ago");
    assert.equal(formatAge("2026-09-30T14:00:00.000Z", now), "3 days ago");
    assert.equal(formatAge("not a date", now), "not a date");
  });
});

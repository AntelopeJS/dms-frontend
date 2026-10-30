import * as assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { Command } from "commander";
import { cmdVerifySource } from "../src/commands/verify-source";
import {
  assertValidUsage,
  parseLocalPackages,
  usageProblems,
} from "../src/commands/verify-source-action";
import { cmdBuild } from "../src/commands/build";
import { cmdClean } from "../src/commands/clean";
import { describeWorkspaces } from "../src/commands/clean-action";
import { cmdDev } from "../src/commands/dev";
import { cmdPrepare } from "../src/commands/prepare";
import { cmdStart } from "../src/commands/start";
import { cmdWorkspaces } from "../src/commands/workspaces";
import {
  renderWorkspaces,
  type WorkspaceRecord,
} from "../src/commands/workspaces-action";
import {
  flagOrEnv,
  parseBackendUrl,
  parsePort,
  requireBackendUrl,
  resolveSessionSecret,
  UsageError,
} from "../src/config";
import { applyDmsHelp, formatEnvironmentHelp } from "../src/help";
import { memoryUi, problemText } from "./fixtures/memory-ui";

/**
 * Match a UsageError on its title and on the rest of what it prints.
 */
function usageError(title: RegExp, ...details: RegExp[]) {
  return (err: Error) => {
    assert.ok(err instanceof UsageError);
    assert.equal(err.exitCode, 2);
    assert.match(err.problem.title, title);
    for (const detail of details) assert.match(problemText(err), detail);
    return true;
  };
}

describe("DMS CLI plugin", () => {
  it("resolves session secrets by command mode", () => {
    const generated = resolveSessionSecret("dev", undefined);
    assert.match(generated, /^[0-9a-f]{64}$/);
    assert.equal(
      resolveSessionSecret("dev", "explicit-session-secret-32-characters!!"),
      "explicit-session-secret-32-characters!!",
    );

    for (const mode of ["dev", "start"] as const) {
      assert.throws(
        () => resolveSessionSecret(mode, ""),
        usageError(/DMS_SESSION_SECRET is empty/),
      );
      assert.throws(
        () => resolveSessionSecret(mode, "too-short"),
        usageError(/is too short: 9 characters, at least 32 needed/),
      );
    }
    assert.throws(
      () => resolveSessionSecret("start", undefined),
      usageError(/DMS_SESSION_SECRET is not set/, /openssl rand -hex 32/),
    );
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
      cmdWorkspaces(),
      cmdClean(),
    ];
    assert.deepEqual(
      commands.map((command) => command.name()),
      ["dev", "build", "start", "prepare", "workspaces", "clean"],
    );
  });
});

describe("help environment", () => {
  it("wraps the topic to the width it is given, between words", () => {
    for (const width of [80, 60, 40]) {
      const lines = formatEnvironmentHelp(width).split("\n");
      const over = lines.filter((line) => line.length > width);
      assert.deepEqual(over, [], `at ${width} columns`);
    }
    assert.match(
      formatEnvironmentHelp(40),
      /\n {2}DMS_AUTH_ESTABLISH_ENDPOINTS\n {6}More backend endpoints/,
    );
  });

  it("wraps option descriptions, or puts them under the option when narrow", () => {
    const help = (width: number) => {
      const program = new Command("ajs dms").option(
        "--bootstrap-secret <secret>",
        "Credential for the backend's layer endpoints; prefer the variable",
      );
      applyDmsHelp(program);
      program.configureOutput({ getOutHelpWidth: () => width });
      return program.helpInformation();
    };
    assert.match(
      help(64),
      /\n {2}--bootstrap-secret <secret> {2}Credential for the backend's\n {31}layer endpoints; prefer the\n {31}variable\n/,
    );
    assert.match(
      help(60),
      /\n {2}--bootstrap-secret <secret>\n {6}Credential for the backend's layer endpoints; prefer\n {6}the variable\n/,
    );
    for (const width of [64, 60, 40]) {
      const over = help(width)
        .split("\n")
        .filter((line) => line.length > width);
      assert.deepEqual(over, [], `at ${width} columns`);
    }
  });

  it("lists commands without [options], and the global options on every page", () => {
    const program = new Command("ajs dms").option("--verbose", "Show more");
    program.addCommand(
      new Command("dev")
        .summary("Run the dev server")
        .option("-f, --force", "Reinstall"),
    );
    program.addCommand(
      new Command("verify-source")
        .summary("Verify sources")
        .argument("[layer]"),
    );
    applyDmsHelp(program);
    program.configureOutput({ getOutHelpWidth: () => 80 });
    const root = program.helpInformation();
    assert.match(root, /\n {2}dev {2,}Run the dev server\n/);
    assert.match(root, /\n {2}verify-source \[layer\] {2,}Verify sources\n/);
    assert.match(root, /\n {2}help \[command\] {2,}Show help for a command\n/);
    assert.doesNotMatch(root, /dev \[options\]/);
    const dev = program.commands[0];
    dev.configureOutput({ getOutHelpWidth: () => 80 });
    assert.match(
      dev.helpInformation(),
      /\n {2}-h, --help {2,}Show help for a command\n\nGlobal Options:\n {2}--verbose {2,}Show more\n/,
    );
  });

  it("reads a flag's variable as a boolean, the flag first", () => {
    const name = "DMS_TEST_FLAG";
    const saved = process.env[name];
    try {
      delete process.env[name];
      assert.equal(flagOrEnv(undefined, name), false);
      for (const value of ["1", "true", "yes", "on"]) {
        process.env[name] = value;
        assert.equal(flagOrEnv(undefined, name), true, value);
      }
      for (const value of ["", "0", "false", "No", " off "]) {
        process.env[name] = value;
        assert.equal(flagOrEnv(undefined, name), false, value);
      }
      assert.equal(flagOrEnv(true, name), true);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
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

  it("reports every usage problem of a run at once", () => {
    const options = {
      layer: "./no-such-layer",
      module: ["./no-such-module"],
      localPackage: ["foo", "@scope/package=../package"],
    };
    assert.deepEqual(
      usageProblems(options).map((problem) => problem.title),
      [
        "Layer path not found: ./no-such-layer",
        "Module path not found: ./no-such-module",
        "Invalid local package 'foo'",
      ],
    );
    assert.deepEqual(
      usageProblems({ localPackage: ["foo"] }).map((problem) => problem.title),
      ["Invalid local package 'foo'"],
    );

    const output = memoryUi();
    assert.throws(
      () => assertValidUsage(usageProblems(options), output.ui),
      usageError(/^Invalid local package 'foo'$/, /name=path/),
    );
    assert.equal(
      output.stderr(),
      [
        "✖ Layer path not found: ./no-such-layer",
        "  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)",
        "✖ Module path not found: ./no-such-module",
        "  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(() => assertValidUsage([], output.ui));
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

describe("workspace listing", () => {
  const home = "/home/user/.antelopejs/dms-frontend";
  const projectId = `76672b08${"0".repeat(56)}`;
  const urlId = `f6af15c7${"1".repeat(56)}`;
  const lastUsedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const records: WorkspaceRecord[] = [
    {
      id: projectId,
      dir: `${home}/${projectId}`,
      backendUrl: "http://127.0.0.1:5010",
      key: { type: "project", path: "/srv/demo" },
      sizeBytes: 536_870_912,
      lastUsedAt,
    },
    {
      id: urlId,
      dir: `${home}/${urlId}`,
      backendUrl: "http://127.0.0.1:5011",
      key: { type: "url" },
      sizeBytes: 1536,
      lastUsedAt,
    },
  ];

  it("prints an aligned table with a header on a terminal", () => {
    const output = memoryUi({ isTerminal: true });
    renderWorkspaces(output.ui, records, true);
    assert.equal(output.stderr(), "");
    assert.deepEqual(output.stdout().split("\n"), [
      "ID        BACKEND                KEY                SIZE    LAST USED",
      "76672b08  http://127.0.0.1:5010  project /srv/demo  512 MB  5 min ago",
      "f6af15c7  http://127.0.0.1:5011  url                1.5 KB  5 min ago",
      "",
    ]);
  });

  it("prints whole, tab-separated values without a header in a pipe", () => {
    const output = memoryUi();
    renderWorkspaces(output.ui, records, false);
    assert.deepEqual(output.stdout().split("\n"), [
      [
        projectId,
        "http://127.0.0.1:5010",
        "project",
        "/srv/demo",
        "536870912",
        lastUsedAt,
        `${home}/${projectId}`,
      ].join("\t"),
      [
        urlId,
        "http://127.0.0.1:5011",
        "url",
        "",
        "1536",
        lastUsedAt,
        `${home}/${urlId}`,
      ].join("\t"),
      "",
    ]);
  });

  it("says there are none on stderr only", () => {
    const output = memoryUi();
    renderWorkspaces(output.ui, [], false);
    assert.equal(output.stdout(), "");
    assert.match(output.stderr(), /^ℹ No workspaces in /);
  });

  it("lists what clean --all removes, columns aligned", () => {
    assert.deepEqual(describeWorkspaces(records, true), [
      "76672b08  http://127.0.0.1:5010  project /srv/demo",
      "f6af15c7  http://127.0.0.1:5011  url",
    ]);
  });

  it("wraps the clean --all list under the backend on a narrow terminal", () => {
    assert.deepEqual(describeWorkspaces(records, true, 38), [
      "76672b08  http://127.0.0.1:5010",
      "          project /srv/demo",
      "f6af15c7  http://127.0.0.1:5011  url",
    ]);
    assert.deepEqual(
      describeWorkspaces(records, true, undefined),
      describeWorkspaces(records, true),
      "piped: one line per workspace",
    );
  });
});

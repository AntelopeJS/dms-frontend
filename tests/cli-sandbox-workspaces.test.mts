import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isObjectLike } from "../src/internal/guards";
import { listNames } from "./helpers/files";
import { isText } from "./helpers/guards";
import { OWN_PACKAGE } from "./helpers/own-package";
import {
  runCli,
  BACKEND_URL,
  SESSION_SECRET,
  workspaceDir,
  PRODUCTION_WORKSPACE,
  builtWorkspace,
} from "./fixtures/cli-sandbox.mts";

interface ListedWorkspace {
  dir: string;
}

function isListing(value: unknown): value is ListedWorkspace[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => isObjectLike(entry) && "dir" in entry && isText(entry.dir),
    )
  );
}

interface OutputSettings {
  ANTELOPEJS_QUIET?: string;
  ANTELOPEJS_VERBOSE?: string;
}

function isOutputSettings(value: unknown): value is OutputSettings {
  return (
    isObjectLike(value) &&
    (!("ANTELOPEJS_QUIET" in value) || isText(value.ANTELOPEJS_QUIET)) &&
    (!("ANTELOPEJS_VERBOSE" in value) || isText(value.ANTELOPEJS_VERBOSE))
  );
}

function stampedWorkspace(
  workspaceKey: string,
  backendUrl: string,
  updatedAt: string,
  bytes: number,
) {
  const hash = createHash("sha256").update(workspaceKey).digest("hex");
  const dir = join(".antelopejs", "dms-frontend", hash);
  const meta = JSON.stringify({ backendUrl, workspaceKey, updatedAt });
  return {
    [join(dir, ".ajs-dms-meta.json")]: meta,
    [join(dir, "node_modules", "pkg.js")]: "x".repeat(
      bytes - Buffer.byteLength(meta),
    ),
  };
}

const URL_WORKSPACE = stampedWorkspace(
  BACKEND_URL,
  BACKEND_URL,
  "2026-10-03T12:00:00.000Z",
  2048,
);
const PROJECT_WORKSPACE = stampedWorkspace(
  "project:/srv/demo",
  BACKEND_URL,
  "2026-10-03T13:00:00.000Z",
  1024,
);
const STRAY_DIR = join(".antelopejs", "dms-frontend", "stray-dir", "file");

describe("listing and removing workspaces", () => {
  it("prints one JSON document on stdout, whatever else is said", async () => {
    const result = await runCli(["workspaces", "--json"], {
      files: {
        ...URL_WORKSPACE,
        ...PROJECT_WORKSPACE,
        [STRAY_DIR]: "",
        [join(".antelopejs", "dms-frontend", "update-check.json")]:
          JSON.stringify({
            checkedAt: Date.now(),
            latestVersion: "999.0.0",
            succeeded: true,
          }),
      },
      env: { NO_UPDATE_NOTIFIER: undefined, CI: undefined },
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /999\.0\.0/);
    assert.match(result.stderr, /– Skipped .*stray-dir \(not a workspace\)/);
    const listed: unknown = JSON.parse(result.stdout);
    assert.ok(isListing(listed), "the listing is an array of workspaces");
    const home = join(result.sandbox, ".antelopejs", "dms-frontend");
    assert.deepEqual(
      listed.map((entry) => entry.dir.startsWith(home)),
      [true, true],
    );
    assert.deepEqual(
      listed.map(({ dir: _dir, ...entry }) => entry),
      [
        {
          id: createHash("sha256").update("project:/srv/demo").digest("hex"),
          backendUrl: BACKEND_URL,
          key: { type: "project", path: "/srv/demo" },
          sizeBytes: 1024,
          lastUsedAt: "2026-10-03T13:00:00.000Z",
        },
        {
          id: createHash("sha256").update(BACKEND_URL).digest("hex"),
          backendUrl: BACKEND_URL,
          key: { type: "url" },
          sizeBytes: 2048,
          lastUsedAt: "2026-10-03T12:00:00.000Z",
        },
      ],
    );
  });

  it("prints an empty JSON list when there is no workspace", async () => {
    const result = await runCli(["workspaces", "--json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });

  it("prints tab-separated lines without a header in a pipe", async () => {
    const result = await runCli(["workspaces"], { files: URL_WORKSPACE });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const fields = result.stdout.trimEnd().split("\t");
    assert.deepEqual(fields.slice(1, 6), [
      BACKEND_URL,
      "url",
      "",
      "2048",
      "2026-10-03T12:00:00.000Z",
    ]);
  });

  it("refuses to clean --all without a terminal to confirm on", async () => {
    const result = await runCli(["clean", "--all"], { files: URL_WORKSPACE });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^✖ Cannot prompt/);
    assert.match(
      result.stderr,
      /→ Pass it as a flag: ajs dms clean --all --yes/,
    );
    assert.ok(existsSync(join(result.sandbox, workspaceDir(BACKEND_URL))));
  });

  it("removes every workspace with --yes and says how much it freed", async () => {
    const result = await runCli(["clean", "--all", "--yes"], {
      files: { ...URL_WORKSPACE, ...PROJECT_WORKSPACE, [STRAY_DIR]: "" },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    const lines = result.stderr.split("\n");
    assert.equal(lines[0], "✔ Removed 2 workspaces · freed 3 KB");
    assert.match(
      lines[1],
      /^ {2}[0-9a-f]{64} {2}http:\/\/127\.0\.0\.1:5010 {2}project \/srv\/demo$/,
    );
    assert.match(
      lines[2],
      /^ {2}[0-9a-f]{64} {2}http:\/\/127\.0\.0\.1:5010 {2}url$/,
    );
    assert.match(lines[3], /^– Skipped .*stray-dir \(not a workspace\)$/);
    const home = join(result.sandbox, ".antelopejs", "dms-frontend");
    assert.deepEqual(listNames(home), ["stray-dir"]);
  });
});

const UPDATE_DUE = {
  [join(".antelopejs", "dms-frontend", "update-check.json")]: JSON.stringify({
    checkedAt: Date.now(),
    latestVersion: "999.0.0",
    succeeded: true,
  }),
};
const UPDATE_ENV = {
  NO_UPDATE_NOTIFIER: undefined,
  CI: undefined,
  NO_COLOR: "1",
};
const UPDATE_NOTICE = `ℹ ajs dms 999.0.0 is available (you have ${OWN_PACKAGE.version}) → ajs update dms\n`;

describe("update notice", () => {
  it("ends a successful command on a terminal, after its own output", async () => {
    const result = await runCli(["clean", "--all"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
      isTerminal: true,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `ℹ No workspaces found\n\n${UPDATE_NOTICE}`);
  });

  it("stays out of pipes, failed commands and --json", async () => {
    const piped = await runCli(["clean", "--all"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
    });
    assert.equal(piped.stderr, "ℹ No workspaces found\n");

    const failed = await runCli(["clean"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
      isTerminal: true,
    });
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /^✖ Nothing to clean/);
    assert.doesNotMatch(failed.stderr, /999\.0\.0/);

    const json = await runCli(["workspaces", "--json"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
      isTerminal: true,
    });
    assert.equal(json.code, 0);
    assert.doesNotMatch(json.stderr, /999\.0\.0/);
  });
});

/** A built workspace whose server prints the output settings it inherited. */

function settingsWorkspace() {
  return {
    ...builtWorkspace(),
    [join(PRODUCTION_WORKSPACE, "server.mjs")]:
      "const { ANTELOPEJS_QUIET, ANTELOPEJS_VERBOSE } = process.env;\n" +
      "console.log(JSON.stringify({ ANTELOPEJS_QUIET, ANTELOPEJS_VERBOSE }));\n",
  };
}

describe("global options after the command", () => {
  it("accepts -q and --verbose=<channels> before and after it", async () => {
    const listing = (result: { stdout: string; sandbox: string }) =>
      result.stdout.replaceAll(result.sandbox, "<home>");
    const plain = await runCli(["workspaces"], { files: URL_WORKSPACE });
    assert.equal(plain.code, 0);
    for (const args of [
      ["-q", "workspaces"],
      ["workspaces", "-q"],
      ["workspaces", "--quiet"],
      ["--verbose=vite", "workspaces"],
      ["workspaces", "--verbose=vite"],
      ["workspaces", "--verbose=vite,cli", "-q"],
      ["--verbose", "workspaces"],
    ]) {
      const result = await runCli(args, { files: URL_WORKSPACE });
      assert.equal(result.code, 0, args.join(" "));
      assert.equal(listing(result), listing(plain), args.join(" "));
      assert.equal(result.stderr, "", args.join(" "));
    }
  });

  it("prints the help for global options alone", async () => {
    for (const args of [["-q"], ["--verbose=vite"], ["-q", "--no-color"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 0, args.join(" "));
      assert.match(result.stdout, /^Usage: ajs dms /m, args.join(" "));
    }
  });

  it("documents -q and --verbose=<channels> in the help and the environment topic", async () => {
    const help = await runCli(["--help"]);
    assert.match(
      help.stdout,
      /\n {2}--verbose \[=channels\] {2,}Show full output/,
    );
    assert.match(
      help.stdout,
      /\n {2}-q, --quiet {2,}Print only results, warnings and errors/,
    );
    const topic = await runCli(["help", "environment"]);
    assert.match(topic.stdout, /\n {2}ANTELOPEJS_QUIET {2,}Same as -q/);
  });

  it("hands them on to the server as ajs does when given before dms", async () => {
    const settings = async (args: string[]) => {
      const result = await runCli(
        [...args.slice(0, 1), "-b", BACKEND_URL, "-p", "0", ...args.slice(1)],
        {
          files: settingsWorkspace(),
          env: { DMS_SESSION_SECRET: SESSION_SECRET },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      const printed: unknown = JSON.parse(result.stdout);
      assert.ok(isOutputSettings(printed), "the server printed its settings");
      return printed;
    };
    assert.deepEqual(await settings(["start", "-q", "--verbose=vite"]), {
      ANTELOPEJS_QUIET: "1",
      ANTELOPEJS_VERBOSE: "vite",
    });
    assert.deepEqual(await settings(["start", "--verbose"]), {
      ANTELOPEJS_VERBOSE: "*",
    });
    assert.deepEqual(await settings(["start"]), {});
  });
});

describe("quiet runs", () => {
  it("print the results of workspaces and nothing else", async () => {
    const listing = (result: { stdout: string; sandbox: string }) =>
      result.stdout.replaceAll(result.sandbox, "<home>");
    const files = { ...URL_WORKSPACE, [STRAY_DIR]: "" };
    const plain = await runCli(["workspaces"], { files });
    assert.match(plain.stderr, /Skipped/);
    for (const options of [
      { args: ["workspaces", "-q"], env: {} },
      { args: ["workspaces"], env: { ANTELOPEJS_QUIET: "1" } },
    ]) {
      const quiet = await runCli(options.args, { files, env: options.env });
      assert.equal(quiet.code, 0);
      assert.equal(listing(quiet), listing(plain));
      assert.equal(quiet.stderr, "");
    }
  });

  it("clean silently, and still report a usage error", async () => {
    const cleaned = await runCli(["clean", "--all", "--yes", "-q"], {
      files: { ...URL_WORKSPACE, ...PROJECT_WORKSPACE },
    });
    assert.equal(cleaned.code, 0);
    assert.equal(cleaned.stdout, "");
    assert.equal(cleaned.stderr, "");
    assert.deepEqual(
      listNames(join(cleaned.sandbox, ".antelopejs", "dms-frontend")),
      [],
    );

    const usage = await runCli(["clean", "-q"]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /^✖ Nothing to clean: pass -b <url> or --all\n/);
  });

  it("open start, build and dev without their header, and keep their errors", async () => {
    const started = await runCli(
      ["start", "-b", BACKEND_URL, "-p", "0", "-q"],
      {
        files: builtWorkspace(),
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      },
    );
    assert.equal(started.code, 0);
    assert.match(started.stdout, /^server port \d+\n$/);
    assert.match(started.stderr, /^▲ DMS_HTML_RENDER_SECRET is not set/);
    assert.doesNotMatch(started.stderr, /ajs dms start/);

    const dev = await runCli(["dev", "-b", "http://127.0.0.1:9"], {
      env: { DMS_SESSION_SECRET: SESSION_SECRET, ANTELOPEJS_QUIET: "1" },
    });
    assert.equal(dev.code, 1);
    assert.match(dev.stderr, /^✖ Cannot reach the DMS backend/);
    assert.doesNotMatch(dev.stderr, /ajs dms dev {2}/);

    const build = await runCli(["build"], {
      env: { DMS_SESSION_SECRET: SESSION_SECRET, ANTELOPEJS_QUIET: "1" },
    });
    assert.equal(build.code, 1);
    assert.match(
      build.stderr,
      /^✖ Could not evaluate the project's configuration/,
    );
    assert.doesNotMatch(build.stderr, /ajs dms build {2}/);
  });

  it("keep the warning of a skipped prepare", async () => {
    const result = await runCli(["prepare", "--quiet"]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /^▲ Skipped prepare: no backend URL\n/);
  });

  it("are quiet only when ANTELOPEJS_QUIET is on", async () => {
    for (const value of ["0", "false"]) {
      const result = await runCli(["clean", "--all"], {
        env: { ANTELOPEJS_QUIET: value },
      });
      assert.match(result.stderr, /No workspaces found/, value);
    }
  });

  it("leave out the update notice", async () => {
    for (const env of [{}, { ANTELOPEJS_QUIET: "1" }]) {
      const result = await runCli(
        ["clean", "--all", ...("ANTELOPEJS_QUIET" in env ? [] : ["-q"])],
        {
          files: UPDATE_DUE,
          env: { ...UPDATE_ENV, ...env },
          isTerminal: true,
        },
      );
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
    }
  });
});

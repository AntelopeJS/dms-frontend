import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CancelledError } from "../src/cancellation";
import { UsageError } from "../src/config";
import {
  classifyFailure,
  formatAge,
  formatSize,
  failureDetails,
  formatTimedMessage,
  showPath,
  showWorkspace,
  workspaceId,
} from "../src/output";
import {
  describeListenError,
  describeStartError,
  runServer,
} from "../src/server-process";
import { CliError } from "@antelopejs/core/cli";
import { memoryUi, problemText } from "./fixtures/memory-ui";
describe("CLI output", () => {
  it("puts the time before a running server's notices", () => {
    const output = memoryUi();
    const at = new Date(2026, 9, 3, 14, 3, 22);
    assert.equal(
      formatTimedMessage(
        "warn",
        "frontend-vue/i18n/locales/demo-en-GB.json is not a valid locale file",
        {
          details: ["Unexpected end of JSON input"],
          fixes: ["Restart ajs dms dev to apply it"],
        },
        output.ui,
        at,
      ),
      "14:03:22 ▲ frontend-vue/i18n/locales/demo-en-GB.json is not a valid locale file\n" +
        "           Unexpected end of JSON input\n" +
        "           → Restart ajs dms dev to apply it",
    );
    assert.equal(
      formatTimedMessage("success", "Fixed", {}, output.ui, at),
      "14:03:22 ✔ Fixed",
    );
  });

  it("wraps a running server's notices under their text", () => {
    const output = memoryUi();
    const at = new Date(2026, 9, 3, 14, 3, 22);
    const options = {
      details: ["Unexpected end of JSON input at position 12", "  10 | {"],
      fixes: ["Restart ajs dms dev to apply it"],
    };
    const text = "i18n/locales/demo-en-GB.json is not a valid locale file";
    assert.equal(
      formatTimedMessage(
        "warn",
        text,
        { ...options, columns: 40 },
        output.ui,
        at,
      ),
      "14:03:22 ▲ i18n/locales/demo-en-GB.json\n" +
        "           is not a valid locale file\n" +
        "           Unexpected end of JSON input\n" +
        "           at position 12\n" +
        "             10 | {\n" +
        "           → Restart ajs dms dev to\n" +
        "             apply it",
    );
    assert.equal(
      formatTimedMessage("warn", text, options, output.ui, at),
      `14:03:22 ▲ ${text}\n` +
        "           Unexpected end of JSON input at position 12\n" +
        "             10 | {\n" +
        "           → Restart ajs dms dev to apply it",
      "piped: one line each",
    );
  });

  it("explains why the server could not listen", () => {
    assert.deepEqual(
      describeListenError({
        code: "EADDRINUSE",
        message: "listen EADDRINUSE: address already in use 0.0.0.0:3331",
        host: "0.0.0.0",
        port: 3331,
      }),
      {
        title: "Port 3331 is already in use",
        reason: "Another process is listening on 0.0.0.0:3331.",
        fixes: ["Stop it, or pass another port: -p <port>"],
      },
    );
    assert.equal(
      describeListenError({
        code: "EADDRNOTAVAIL",
        message: "listen EADDRNOTAVAIL",
        host: "10.9.9.9",
        port: 3001,
      }).reason,
      "10.9.9.9 is not an address of this machine.",
    );
    assert.equal(
      describeListenError({
        code: "EOTHER",
        message: "listen EOTHER",
        host: "0.0.0.0",
        port: 3001,
      }).reason,
      "listen EOTHER",
    );
  });

  it("lists a warned failure's details before its fixes, as the core does", () => {
    const error = new UsageError({
      title: "Locale catalogs not regenerated",
      reason: "fr.json is not valid JSON",
      details: ["Unexpected token } at 4:2"],
      fixes: ["Fix the file"],
    });
    assert.deepEqual(failureDetails(classifyFailure(error), memoryUi().ui), [
      "Locale catalogs not regenerated",
      "fr.json is not valid JSON",
      "Unexpected token } at 4:2",
      "→ Fix the file",
    ]);
  });

  it("titles a failure that is not a CliError by the first line of its message", () => {
    const { ui } = memoryUi();
    assert.deepEqual(
      failureDetails(classifyFailure(new Error("disk full\nretry later")), ui),
      ["disk full"],
    );
    assert.deepEqual(
      failureDetails(classifyFailure("plain text\nsecond line"), ui),
      ["plain text"],
    );
    assert.deepEqual(failureDetails(classifyFailure(42), ui), ["42"]);
    assert.deepEqual(failureDetails(classifyFailure(null), ui), ["null"]);
    assert.deepEqual(
      failureDetails(classifyFailure({ toString: () => "own text\nmore" }), ui),
      ["own text"],
    );
  });

  it("adds the stack of an Error, minus its first line, only in a verbose run", () => {
    const { ui } = memoryUi();
    const error = new Error("boom");
    error.stack =
      "Error: boom\n    at first (a.ts:1:1)\n    at second (b.ts:2:2)";
    const verbose = process.env.ANTELOPEJS_VERBOSE;
    try {
      delete process.env.ANTELOPEJS_VERBOSE;
      assert.deepEqual(failureDetails(classifyFailure(error), ui), ["boom"]);
      process.env.ANTELOPEJS_VERBOSE = "1";
      assert.deepEqual(failureDetails(classifyFailure(error), ui), [
        "boom",
        "at first (a.ts:1:1)",
        "at second (b.ts:2:2)",
      ]);
      assert.deepEqual(failureDetails(classifyFailure("boom"), ui), ["boom"]);
      assert.deepEqual(
        failureDetails(classifyFailure(new UsageError({ title: "Usage" })), ui),
        ["Usage"],
      );
    } finally {
      if (verbose === undefined) delete process.env.ANTELOPEJS_VERBOSE;
      else process.env.ANTELOPEJS_VERBOSE = verbose;
    }
  });

  it("cuts lines in ASCII where the terminal has no Unicode", () => {
    const ascii = memoryUi({ isUnicode: false }).ui;
    const home = "/home/user";
    const dir = `${home}/.antelopejs/dms-frontend/76672b089458f187ebe9586040f9b8ae`;
    assert.equal(
      showWorkspace(dir, true, home, ascii),
      "~/.antelopejs/dms-frontend/76672b08...",
    );
    const stop = new CancelledError("SIGINT", "Stopped the build", "ran 2.1s");
    assert.equal(stop.stopped, "Stopped the build");
    assert.deepEqual(stop.context, ["ran 2.1s"]);
    assert.equal(
      new CancelledError("SIGTERM", "Stopped the build").stopped,
      "Stopped the build (SIGTERM)",
    );
  });

  it("explains a Vite that could not start, at the source the user edits", () => {
    const workspace = "/home/user/.antelopejs/dms-frontend/abc";
    const mapPath = (line: string) =>
      line.replace(`${workspace}/frontend-modules/demo`, "./frontend-vue");
    assert.equal(
      problemText(
        new UsageError(
          describeStartError(
            {
              message: 'Unexpected "}"',
              location: {
                file: `${workspace}/frontend-modules/demo/dms.frontend.ts`,
                line: 4,
                column: 0,
                lineText: "};",
              },
            },
            mapPath,
          ),
        ),
      ),
      [
        "✖ Vite could not start: error in ./frontend-vue/dms.frontend.ts:4:0",
        '  Unexpected "}"',
        "  4 | };",
        "    | ^",
        "  → Fix the file and run ajs dms dev again",
        "",
      ].join("\n"),
    );
    assert.equal(
      problemText(
        new UsageError(
          describeStartError(
            {
              message: `Cannot find package '@vitejs/plugin-vue' imported from ${workspace}/vite.config.ts`,
              code: "ERR_MODULE_NOT_FOUND",
            },
            (line) =>
              line.replace(workspace, "~/.antelopejs/dms-frontend/abc…"),
          ),
        ),
      ),
      [
        "✖ Vite could not start in the dev server",
        "  Cannot find package '@vitejs/plugin-vue' imported from ~/.antelopejs/dms-frontend/abc…/vite.config.ts",
        "  → Reinstall the workspace dependencies: ajs dms dev --force",
        "",
      ].join("\n"),
    );
    assert.equal(
      problemText(
        new UsageError(describeStartError({ message: "config boom" })),
      ),
      [
        "✖ Vite could not start in the dev server",
        "  config boom",
        "  → Look for the cause in Vite's output above, then run ajs dms dev again",
        "",
      ].join("\n"),
    );
  });

  it("fails the run once when the dev server reports that Vite could not start", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-start-error-"));
    const file = join(workspace, "frontend-modules/demo/app/plugin.ts");
    const report = {
      type: "dms:start-error",
      message: "Cannot find module 'nope'",
      location: { file, line: 3, column: 7 },
    };
    writeFileSync(
      join(workspace, "server.mjs"),
      `process.send(${JSON.stringify(report)}, () => process.exit(1));\n`,
    );
    let isReady = false;
    after(() => rmSync(workspace, { recursive: true, force: true }));
    await assert.rejects(
      runServer({
        name: "dev server",
        script: "server.mjs",
        cwd: workspace,
        env: process.env,
        mapPath: (line) =>
          line.replace(join(workspace, "frontend-modules/demo"), "./demo"),
        onReady: () => (isReady = true),
      }),
      (err: Error) => {
        assert.ok(err instanceof CliError);
        assert.equal(
          problemText(err),
          [
            "✖ Vite could not start: error in ./demo/app/plugin.ts:3:7",
            "  Cannot find module 'nope'",
            "  → Fix the file and run ajs dms dev again",
            "",
          ].join("\n"),
        );
        return true;
      },
    );
    assert.equal(isReady, false);
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

  it("says how much space a workspace takes", () => {
    assert.equal(formatSize(0), "0 B");
    assert.equal(formatSize(900), "900 B");
    assert.equal(formatSize(1536), "1.5 KB");
    assert.equal(formatSize(536_870_912), "512 MB");
    assert.equal(formatSize(1_610_612_736), "1.5 GB");
  });

  it("cuts a workspace id on a terminal only", () => {
    const dir = `/home/user/.antelopejs/dms-frontend/${"a".repeat(64)}`;
    assert.equal(workspaceId(dir, true), "aaaaaaaa");
    assert.equal(workspaceId(dir, false), "a".repeat(64));
  });
});

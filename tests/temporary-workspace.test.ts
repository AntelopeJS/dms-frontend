import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { temporaryWorkspaceParent } from "../src/temporary-workspace";

const PREFIX = "dms-frontend-workspace-test-";
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "temporary-workspace-cli.ts",
);

function runFixture(mode: string) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", FIXTURE, mode],
    {
      encoding: "utf8",
    },
  );
  const [workspace = "", realWorkspace = ""] = result.stdout
    .trim()
    .split(/\r?\n/);
  assert.ok(workspace, `fixture must report its workspace (${result.stderr})`);
  return { status: result.status, workspace, realWorkspace };
}

void describe("createTemporaryWorkspace", () => {
  void it("removes the workspace after a successful run", () => {
    const { status, workspace } = runFixture("succeed");
    assert.equal(status, 0);
    assert.equal(existsSync(workspace), false);
  });

  void it("removes the workspace when the run throws", () => {
    const { status, workspace } = runFixture("throw");
    assert.notEqual(status, 0);
    assert.equal(existsSync(workspace), false);
  });

  void it("puts the workspace on the drive of the project it builds", () => {
    const { workspace } = runFixture("succeed");
    assert.equal(
      parse(workspace).root.toLowerCase(),
      parse(process.cwd()).root.toLowerCase(),
    );
  });

  void it("names the workspace by its real path, with no Windows short name", () => {
    const { workspace, realWorkspace } = runFixture("succeed");
    assert.equal(workspace, realWorkspace);
  });

  void it("removes the workspace a dead process left, and keeps a live one's", () => {
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    const left = join(tmpdir(), `${PREFIX}${dead}-killed`);
    const live = join(tmpdir(), `${PREFIX}${process.pid}-running`);
    mkdirSync(left);
    mkdirSync(live);
    try {
      runFixture("succeed");
      assert.equal(existsSync(left), false);
      assert.equal(existsSync(live), true);
    } finally {
      rmSync(left, { recursive: true, force: true });
      rmSync(live, { recursive: true, force: true });
    }
  });

  void it("removes the workspace when a promise rejects", () => {
    const { status, workspace } = runFixture("reject");
    assert.notEqual(status, 0);
    assert.equal(existsSync(workspace), false);
  });
});

void describe("temporaryWorkspaceParent", () => {
  void it("keeps the temporary directory on the project's drive", () => {
    assert.equal(
      temporaryWorkspaceParent("d:\\work\\site", "D:\\Temp", win32),
      "D:\\Temp",
    );
  });

  void it("moves to the project's cache when the temporary directory is on another drive", () => {
    assert.equal(
      temporaryWorkspaceParent("D:\\work\\site", "C:\\Temp", win32),
      "D:\\work\\site\\.cache\\dms-frontend",
    );
  });
});

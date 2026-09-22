import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "temporary-workspace-cli.ts",
);

function runFixture(mode: string): {
  status: number | null;
  workspace: string;
} {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", FIXTURE, mode],
    {
      encoding: "utf8",
    },
  );
  const workspace = result.stdout.trim();
  assert.ok(workspace, `fixture must report its workspace (${result.stderr})`);
  return { status: result.status, workspace };
}

describe("createTemporaryWorkspace", () => {
  it("removes the workspace after a successful run", () => {
    const { status, workspace } = runFixture("succeed");
    assert.equal(status, 0);
    assert.equal(existsSync(workspace), false);
  });

  it("removes the workspace when the run throws", () => {
    const { status, workspace } = runFixture("throw");
    assert.notEqual(status, 0);
    assert.equal(existsSync(workspace), false);
  });

  it("removes the workspace when a promise rejects", () => {
    const { status, workspace } = runFixture("reject");
    assert.notEqual(status, 0);
    assert.equal(existsSync(workspace), false);
  });

  it("keeps the workspace when asked to", () => {
    const { status, workspace } = runFixture("keep");
    try {
      assert.equal(status, 0);
      assert.equal(existsSync(join(workspace, "marker.txt")), true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

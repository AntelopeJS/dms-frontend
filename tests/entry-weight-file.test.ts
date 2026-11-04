import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { readEntryWeight } from "../src/entry-weight";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspaceRecording(content?: string): string {
  const root = mkdtempSync(join(tmpdir(), "dms-entry-weight-"));
  roots.push(root);
  mkdirSync(join(root, "dist", "client", ".vite"), { recursive: true });
  if (content !== undefined)
    writeFileSync(
      join(root, "dist", "client", ".vite", "entry-weight.json"),
      content,
    );
  return root;
}

describe("The entry weight a client build recorded", () => {
  it("is nothing when the build recorded none", () => {
    assert.equal(readEntryWeight(workspaceRecording()), undefined);
  });

  it("is read from what the build records", () => {
    const root = workspaceRecording(
      JSON.stringify({ files: [], bytes: 0, owners: { shared: 10, mod: 30 } }),
    );
    assert.deepEqual(readEntryWeight(root), {
      bytes: 0,
      brotli: 0,
      shares: [
        { owner: "mod", bytes: 30, brotli: 0 },
        { owner: "shared", bytes: 10, brotli: 0 },
      ],
    });
  });

  it("is refused when the file is not what the build records", () => {
    for (const content of [
      "null",
      "[]",
      "{}",
      '{"files":"a.js","bytes":1,"owners":{}}',
      '{"files":[5],"bytes":1,"owners":{}}',
      '{"files":[],"bytes":"1","owners":{}}',
      '{"files":[],"bytes":1,"owners":[]}',
      '{"files":[],"bytes":1,"owners":{"a":"x"}}',
    ])
      assert.throws(
        () => readEntryWeight(workspaceRecording(content)),
        (error: Error) => error instanceof CliError,
        content,
      );
  });
});

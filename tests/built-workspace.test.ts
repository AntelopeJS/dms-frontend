import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  readBuiltModules,
  readBuiltPrivateOptions,
} from "../src/internal/built-workspace";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function workspaceWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "dms-built-workspace-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files))
    writeFileSync(join(root, name), content);
  return root;
}

describe("The private options a build wrote", () => {
  it("are the options by module id of its server options file", () => {
    const modules = { a: { key: "", nested: { list: ["", "x"] } }, b: {} };
    const root = workspaceWith({
      "generated-server-options.json": JSON.stringify({
        modules,
        environment: { NAME: ["key"] },
      }),
    });
    assert.deepEqual(readBuiltPrivateOptions(root), modules);
  });

  it("are none when the file is missing, unreadable or not what the build writes", () => {
    for (const content of [
      undefined,
      "{",
      "null",
      "[]",
      "{}",
      '{"modules":"abc"}',
      '{"modules":[]}',
      '{"modules":{"a":"x"}}',
      '{"modules":{"a":[]}}',
    ]) {
      const root = workspaceWith(
        content === undefined
          ? {}
          : { "generated-server-options.json": content },
      );
      assert.deepEqual(readBuiltPrivateOptions(root), {}, String(content));
    }
  });
});

describe("The modules a build serves", () => {
  it("are named by the manifest name, else the id, with their version", () => {
    const root = workspaceWith({
      "generated-frontend-modules.json": JSON.stringify({
        modules: [
          { id: "acme__shop", name: "@acme/shop", version: "1.2.0" },
          { id: "acme__blog", version: 3 },
          { id: "acme__plain", name: 5 },
        ],
      }),
    });
    assert.deepEqual(readBuiltModules(root), [
      { name: "@acme/shop", version: "1.2.0" },
      { name: "acme__blog", version: undefined },
      { name: "acme__plain", version: undefined },
    ]);
  });

  it("leave out an entry that has no id, and are none when the registry is not a list", () => {
    const root = workspaceWith({
      "generated-frontend-modules.json": JSON.stringify({
        modules: [null, "x", {}, { id: 5 }, { id: "kept" }],
      }),
    });
    assert.deepEqual(readBuiltModules(root), [
      { name: "kept", version: undefined },
    ]);
    for (const content of [undefined, "{", "null", "[]", '{"modules":"abc"}']) {
      const bare = workspaceWith(
        content === undefined
          ? {}
          : { "generated-frontend-modules.json": content },
      );
      assert.deepEqual(readBuiltModules(bare), [], String(content));
    }
  });
});

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  getLayerWorkspacePath,
  materializeLayers,
  type ResolvedLayer,
} from "../src/common";

const WORKSPACES_INSIDE_THE_LAYER = [
  [".cache", "dms-frontend", "workspace"],
  ["playground", ".cache", "dms-frontend", "workspace"],
  ["tmp", "workspace"],
  ["playground", "..b", ".cache", "dms-frontend", "workspace"],
];

void describe("materializeLayers when the workspace and a layer nest", () => {
  for (const segments of WORKSPACES_INSIDE_THE_LAYER) {
    void it(`copies the layer but not the workspace at ${segments.join("/")}`, () => {
      const root = mkdtempSync(join(tmpdir(), "materialize-nested-"));
      try {
        const layer: ResolvedLayer = {
          path: join(root, "module"),
          packageName: "@fixture/module",
          priority: 10,
        };
        mkdirSync(join(layer.path, "app"), { recursive: true });
        mkdirSync(join(layer.path, "playground"), { recursive: true });
        writeFileSync(
          join(layer.path, "package.json"),
          JSON.stringify({ name: layer.packageName }),
        );
        writeFileSync(join(layer.path, "app", "page.vue"), "<template />\n");
        writeFileSync(join(layer.path, "playground", "notes.md"), "notes\n");
        const workspace = join(layer.path, ...segments);
        mkdirSync(workspace, { recursive: true });

        materializeLayers(workspace, [layer]);

        const copy = getLayerWorkspacePath(workspace, layer);
        assert.ok(existsSync(join(copy, "app", "page.vue")), "app is copied");
        assert.ok(
          existsSync(join(copy, "playground", "notes.md")),
          "the workspace's siblings are copied",
        );
        assert.equal(existsSync(join(copy, ...segments)), false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  void it("copies a layer that lies inside the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "materialize-outer-"));
    try {
      const layer: ResolvedLayer = {
        path: join(workspace, "sources", "module"),
        packageName: "@fixture/module",
        priority: 10,
      };
      mkdirSync(join(layer.path, "app"), { recursive: true });
      writeFileSync(
        join(layer.path, "package.json"),
        JSON.stringify({ name: layer.packageName }),
      );
      writeFileSync(join(layer.path, "app", "page.vue"), "<template />\n");

      materializeLayers(workspace, [layer]);

      const copy = getLayerWorkspacePath(workspace, layer);
      assert.ok(existsSync(join(copy, "app", "page.vue")), "app is copied");
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

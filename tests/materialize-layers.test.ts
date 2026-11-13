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
import { it } from "node:test";
import {
  getLayerWorkspacePath,
  materializeLayers,
  type ResolvedLayer,
} from "../src/common";

void it("copies a layer into a workspace built inside that layer's own .cache", () => {
  const root = mkdtempSync(join(tmpdir(), "materialize-nested-"));
  try {
    const layer: ResolvedLayer = {
      path: join(root, "module"),
      packageName: "@fixture/module",
      priority: 10,
    };
    mkdirSync(join(layer.path, "app"), { recursive: true });
    writeFileSync(
      join(layer.path, "package.json"),
      JSON.stringify({ name: layer.packageName }),
    );
    writeFileSync(join(layer.path, "app", "page.vue"), "<template />\n");
    const workspace = join(layer.path, ".cache", "dms-frontend", "workspace");
    mkdirSync(workspace, { recursive: true });

    materializeLayers(workspace, [layer]);

    const copy = getLayerWorkspacePath(workspace, layer);
    assert.ok(existsSync(join(copy, "app", "page.vue")), "the layer is copied");
    assert.equal(existsSync(join(copy, ".cache")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

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

void describe("materializeLayers through symlinks and dot-named folders", () => {
  void it("copies a layer reached through a symlink while the workspace path is real", () => {
    const root = temporaryDirectory("materialize-linked-");
    const real = writeLayer(join(root, "real-module"));
    const layer = { ...real, path: join(root, "module") };
    symlinkSync(real.path, layer.path, "junction");
    const workspace = join(real.path, "tmp", "workspace");
    mkdirSync(workspace, { recursive: true });

    materializeLayers(workspace, [layer]);

    const copy = getLayerWorkspacePath(workspace, layer);
    assert.ok(existsSync(join(copy, "app", "page.vue")), "app is copied");
    assert.equal(existsSync(join(copy, "tmp", "workspace")), false);
  });

  void it("follows a symlink in the layer to a folder that holds the workspace", () => {
    const layer = writeLayer(
      join(temporaryDirectory("materialize-link-in-"), "module"),
    );
    symlinkSync(
      join(layer.path, "playground"),
      join(layer.path, "app", "shared"),
      "junction",
    );
    const workspace = join(layer.path, "playground", "tmp", "workspace");
    mkdirSync(workspace, { recursive: true });

    materializeLayers(workspace, [layer]);

    const copy = getLayerWorkspacePath(workspace, layer);
    assert.ok(
      existsSync(join(copy, "app", "shared", "notes.md")),
      "the linked folder is copied",
    );
    assert.equal(
      existsSync(join(copy, "app", "shared", "tmp", "workspace")),
      false,
    );
    assert.equal(
      existsSync(join(copy, "playground", "tmp", "workspace")),
      false,
    );
  });

  void it("skips a symlink in the layer back to a folder above it that holds the workspace", () => {
    const layer = writeLayer(
      join(temporaryDirectory("materialize-link-up-"), "module"),
    );
    symlinkSync(layer.path, join(layer.path, "app", "root"), "junction");
    const workspace = join(layer.path, "tmp", "workspace");
    mkdirSync(workspace, { recursive: true });

    materializeLayers(workspace, [layer]);

    const copy = getLayerWorkspacePath(workspace, layer);
    assert.ok(existsSync(join(copy, "app", "page.vue")), "app is copied");
    assert.equal(existsSync(join(copy, "app", "root")), false);
    assert.equal(existsSync(join(copy, "tmp", "workspace")), false);
  });

  void it("leaves out the blocklisted entries of a folder named like ..b", () => {
    const layer = writeLayer(
      join(temporaryDirectory("materialize-dotdot-"), "module"),
    );
    mkdirSync(join(layer.path, "..b", "node_modules", "dep"), {
      recursive: true,
    });
    writeFileSync(join(layer.path, "..b", "notes.md"), "notes\n");
    writeFileSync(
      join(layer.path, "..b", "node_modules", "dep", "index.js"),
      "\n",
    );
    const workspace = temporaryDirectory("materialize-dotdot-workspace-");

    materializeLayers(workspace, [layer]);

    const copy = getLayerWorkspacePath(workspace, layer);
    assert.ok(existsSync(join(copy, "..b", "notes.md")), "..b is copied");
    assert.equal(existsSync(join(copy, "..b", "node_modules")), false);
  });
});

function writeLayer(path: string): ResolvedLayer {
  mkdirSync(join(path, "app"), { recursive: true });
  mkdirSync(join(path, "playground"), { recursive: true });
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name: "@fixture/module" }),
  );
  writeFileSync(join(path, "app", "page.vue"), "<template />\n");
  writeFileSync(join(path, "playground", "notes.md"), "notes\n");
  return { path, packageName: "@fixture/module", priority: 10 };
}

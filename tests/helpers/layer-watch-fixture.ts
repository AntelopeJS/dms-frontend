import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  materializeLayers,
  type ResolvedLayer,
  startLayerWatchers,
  writeFrontendModuleRegistry,
} from "../../src/common";
import { readText } from "./files";
import { isText } from "./guards";
import { isJsonObject, jsonAt, readJson } from "./json";
import { output, writeFile } from "./layer-watch";

export function createWatchFixture() {
  const root = mkdtempSync(join(tmpdir(), "dms-derived-watch-"));
  const workspace = join(root, "workspace");
  const base = join(root, "sources", "base");
  const app = join(root, "sources", "app");
  const baseUi = join(base, "layers", "ui");
  const publicDir = join(workspace, "public");
  const layers: ResolvedLayer[] = [
    { path: base, packageName: "@fixture/base", priority: 1 },
    { path: app, packageName: "@fixture/app", priority: 10 },
  ];

  const read = (path: string): string => readText(path);
  const workspaceFile = (name: string): string => read(join(workspace, name));
  const typePaths = (): string[] => {
    const paths = jsonAt(
      readJson(join(workspace, "frontend-paths.generated.json")),
      "compilerOptions",
      "paths",
    );
    assert.ok(isJsonObject(paths), "the type paths are an object");
    return Object.keys(paths);
  };
  const registryEntries = (): Array<[string, string | undefined]> => {
    const modules = jsonAt(
      readJson(join(workspace, "generated-frontend-modules.json")),
      "modules",
    );
    assert.ok(Array.isArray(modules), "the registry lists its modules");
    return modules.map((module) => {
      const id = jsonAt(module, "id");
      const entry = jsonAt(module, "entry");
      assert.ok(isText(id), "a registry module has an id");
      assert.ok(entry === undefined || isText(entry), "its entry is a path");
      return [id, entry];
    });
  };

  return {
    root,
    workspace,
    base,
    app,
    baseUi,
    publicDir,
    layers,
    read,
    workspaceFile,
    typePaths,
    registryEntries,
    stop: async (): Promise<void> => {},
  };
}

export type WatchFixture = ReturnType<typeof createWatchFixture>;

export function seedWatchedLayers(fx: WatchFixture): void {
  const { workspace, base, app, baseUi, layers } = fx;
  writeFile(
    join(base, "package.json"),
    JSON.stringify({ name: "@fixture/base" }),
  );
  writeFile(join(base, "dms.frontend.ts"), "export default { setup() {} };\n");
  writeFile(
    join(baseUi, "app", "components", "Form.vue"),
    "<template><form /></template>\n",
  );
  writeFile(join(baseUi, "public", "logo.svg"), "<svg id='base' />");
  writeFile(
    join(baseUi, "app", "config", "shortcuts-registry.ts"),
    "export default [{ component: 'Form', shortcuts: [] }];\n",
  );
  writeFile(
    join(app, "package.json"),
    JSON.stringify({ name: "@fixture/app" }),
  );
  writeFile(
    join(app, "app", "components", "Card.vue"),
    "<template><article /></template>\n",
  );
  mkdirSync(workspace, { recursive: true });
  materializeLayers(workspace, layers);
  writeFrontendModuleRegistry(workspace, layers);
  fx.stop = startLayerWatchers(workspace, layers, output.ui, output.write);
}

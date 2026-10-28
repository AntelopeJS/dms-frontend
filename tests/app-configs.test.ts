import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
  affectsAppConfigs,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
} from "../src/common";
import { readText } from "./helpers/files";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe("the generated app configs module", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  /** What materialization generates for `modules`, each a module's files. */
  function generate(modules: Record<string, Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), "dms-app-configs-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const layers: ResolvedLayer[] = Object.entries(modules).map(
      ([name, files], index) => {
        const path = join(root, "sources", name);
        writeFile(
          join(path, "package.json"),
          JSON.stringify({ name: `@fixture/${name}` }),
        );
        for (const [file, content] of Object.entries(files))
          writeFile(join(path, file), content);
        return { path, packageName: `@fixture/${name}`, priority: index };
      },
    );
    mkdirSync(workspace);
    materializeLayers(workspace, layers);
    writeFrontendModuleRegistry(workspace, layers);
    return readText(join(workspace, "app-configs.generated.ts"));
  }

  const CONFIG = "export default {};\n";

  it("lists every layer's config, highest precedence first", () => {
    const source = generate({
      base: {
        "layers/z-last/app/app.config.ts": CONFIG,
        "layers/m-without/app/components/Card.vue": "<template />\n",
        "layers/a-first/app/app.config.ts": CONFIG,
      },
      project: { "app/app.config.ts": CONFIG },
    });
    // Modules by descending priority, and within one the last layer by name
    // first: it wins, as it does a contested public file.
    assert.deepEqual(
      [...source.matchAll(/^import config\d+ from "([^"]+)";$/gm)].map(
        (match) => match[1],
      ),
      [
        "@frontend/fixture__project/app/app.config.ts",
        "@frontend/fixture__base/layers/z-last/app/app.config.ts",
        "@frontend/fixture__base/layers/a-first/app/app.config.ts",
      ],
    );
    assert.match(
      source,
      /= \[\{ module: "fixture__project", config: config0 \}, \{ module: "fixture__base", config: config1 \}, \{ module: "fixture__base", config: config2 \}\];/,
    );
  });

  it("imports nothing at run time but the configs", () => {
    // The email bundle imports it, and the browser runtime must not follow.
    const source = generate({ project: { "app/app.config.ts": CONFIG } });
    const imports = source.match(/^import .*$/gm) ?? [];
    assert.deepEqual(
      imports.filter((line) => !/^import (type |config\d+ from)/.test(line)),
      [],
    );
  });

  it("lists nothing for a module without a TypeScript config", () => {
    // The workspace type check covers this module and allows no JavaScript.
    const source = generate({
      project: {
        "app/components/Card.vue": "<template />\n",
        "app/app.config.js": CONFIG,
      },
    });
    assert.doesNotMatch(source, /^import config/m);
    assert.match(source, /appConfigs: DmsLayerAppConfig\[\] = \[\];/);
  });
});

describe("affectsAppConfigs", () => {
  it("matches the app configs of a module and of its layers, and the directories on the way", () => {
    for (const path of [
      "app/app.config.ts",
      "app",
      "layers/ui/app/app.config.ts",
      "layers/ui/app",
      "layers/ui",
      "layers",
    ])
      assert.equal(affectsAppConfigs(path), true, path);
    for (const path of [
      "app/config/shortcuts-registry.ts",
      "app/components/app.config.ts",
      "layers/ui/app/components/Form.vue",
      "layers/ui/public/app/app.config.ts",
      "app.config.ts",
      "package.json",
    ])
      assert.equal(affectsAppConfigs(path), false, path);
  });
});

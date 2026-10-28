import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  frontendLayerAliases,
  frontendLayerTypePaths,
  resolveFrontendLayers,
  writeFrontendModuleRegistry,
} from "../src/common";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { readText } from "./helpers/files";

function moduleWithLayers(prefix: string, layers: string[]): string {
  const root = temporaryDirectory(prefix);
  for (const layer of layers) {
    mkdirSync(join(root, "layers", layer), { recursive: true });
  }
  return root;
}

describe("layer aliases", () => {
  it("derives one alias per layer of a module root", () => {
    const root = moduleWithLayers("dms-aliases-", ["dms-core", "dms-ui"]);
    assert.deepEqual(frontendLayerAliases(root), {
      "#dms-core": join(root, "layers", "dms-core"),
      "#dms-ui": join(root, "layers", "dms-ui"),
    });
    assert.deepEqual(
      resolveFrontendLayers(root).map((layer) => [layer.name, layer.alias]),
      [
        ["dms-core", "#dms-core"],
        ["dms-ui", "#dms-ui"],
      ],
    );
  });

  it("returns nothing for a module that has no layers directory", () => {
    const flat = temporaryDirectory("dms-flat-module-");
    writeFileSync(join(flat, "dms.frontend.ts"), "export default {};");
    assert.deepEqual(resolveFrontendLayers(flat), []);
    assert.deepEqual(frontendLayerAliases(flat), {});
    assert.deepEqual(frontendLayerTypePaths(flat), {});
  });

  it("returns nothing for a module root that does not exist", () => {
    assert.deepEqual(
      frontendLayerAliases(join(tmpdir(), "dms-absent-module")),
      {},
    );
  });

  it("gives a same-named layer to the last root and keeps its position", () => {
    const low = moduleWithLayers("dms-low-", ["legacy", "shared"]);
    const high = moduleWithLayers("dms-high-", ["dms-core", "shared"]);
    assert.deepEqual(frontendLayerAliases([low, high]), {
      "#legacy": join(low, "layers", "legacy"),
      "#shared": join(high, "layers", "shared"),
      "#dms-core": join(high, "layers", "dms-core"),
    });
    assert.deepEqual(
      resolveFrontendLayers([low, high]).map((layer) => layer.name),
      ["legacy", "shared", "dms-core"],
    );
  });

  it("ignores a stray file sitting next to the layers", () => {
    const root = moduleWithLayers("dms-stray-", ["dms-core"]);
    writeFileSync(join(root, "layers", "README.md"), "not a layer");
    assert.deepEqual(Object.keys(frontendLayerAliases(root)), ["#dms-core"]);
  });

  it("emits tsconfig paths, absolute or relative to a base", () => {
    const root = moduleWithLayers("dms-paths-", ["dms-ui"]);
    const directory = join(root, "layers", "dms-ui");
    assert.deepEqual(frontendLayerTypePaths(root), {
      "#dms-ui/*": [`${directory}/*`],
    });
    assert.deepEqual(frontendLayerTypePaths(root, { relativeTo: root }), {
      "#dms-ui/*": ["./layers/dms-ui/*"],
    });
  });
});

describe("generated workspace type paths", () => {
  const EXPECTED = `{
  "compilerOptions": {
    "paths": {
      "#dms/frontend-module": [
        "./frontend-module.ts"
      ],
      "#dms/frontend-build": [
        "./frontend-build.ts"
      ],
      "#dms/server": [
        "./server-module.ts"
      ],
      "@frontend/*": [
        "./frontend-modules/*"
      ],
      "#legacy/*": [
        "./frontend-modules/dms__low/layers/legacy/*"
      ],
      "#shared/*": [
        "./frontend-modules/dms__high/layers/shared/*"
      ],
      "#dms-core/*": [
        "./frontend-modules/dms__high/layers/dms-core/*"
      ],
      "#dms-ui/*": [
        "./frontend-modules/dms__high/layers/dms-ui/*"
      ]
    }
  }
}
`;

  it("writes exactly what it wrote before the helper existed", () => {
    const workspace = temporaryDirectory("dms-paths-workspace-");
    const modules = join(workspace, "frontend-modules");
    const materialized: [string, string[]][] = [
      ["dms__high", ["dms-core", "dms-ui", "shared"]],
      ["dms__low", ["legacy", "shared"]],
    ];
    for (const [id, layers] of materialized) {
      for (const layer of layers) {
        mkdirSync(join(modules, id, "layers", layer), { recursive: true });
      }
    }
    mkdirSync(join(modules, "dms__flat"), { recursive: true });

    writeFrontendModuleRegistry(workspace, [
      {
        path: temporaryDirectory("dms-src-low-"),
        packageName: "@dms/low",
        priority: 1,
      },
      {
        path: temporaryDirectory("dms-src-high-"),
        packageName: "@dms/high",
        priority: 10,
      },
      {
        path: temporaryDirectory("dms-src-flat-"),
        packageName: "@dms/flat",
        priority: 5,
      },
    ]);

    assert.equal(
      readText(join(workspace, "frontend-paths.generated.json")),
      EXPECTED,
    );
  });
});

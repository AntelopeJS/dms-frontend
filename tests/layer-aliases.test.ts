// The layer alias convention is now a public helper, and the generated
// workspace consumes it instead of its own copy. Two things are pinned here:
// the helper's own behaviour against a module root on disk, and the fact that
// `frontend-paths.generated.json` still comes out byte-for-byte as it did
// before the helper existed -- that file feeds every generated workspace.

import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  frontendLayerAliases,
  frontendLayerTypePaths,
  resolveFrontendLayers,
  writeFrontendModuleRegistry,
} from "../src/common";

function moduleWithLayers(prefix: string, layers: string[]): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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
    const flat = mkdtempSync(join(tmpdir(), "dms-flat-module-"));
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
      // `shared` comes from the last root, at the position the first one gave it.
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

describe("published entry points", () => {
  // Adding `exports` to a package that had none is where a deep import turns
  // into a resolution error. Consumers import `@antelopejs/dms-frontend/dist/
  // common.js` today, so the wildcards that keep those paths reachable are
  // part of the contract, not a detail of the map.
  it("keeps the deep dist and templates paths reachable", () => {
    const { exports: map } = JSON.parse(
      readFileSync(join("package.json"), "utf8"),
    );
    assert.deepEqual(map["./dist/*.js"], {
      types: "./dist/*.d.ts",
      default: "./dist/*.js",
    });
    assert.equal(map["./dist/*"], "./dist/*");
    assert.equal(map["./templates/*"], "./templates/*");
    assert.equal(map["./package.json"], "./package.json");
    assert.deepEqual(map["./common"], {
      types: "./dist/common.d.ts",
      default: "./dist/common.js",
    });
  });
});

describe("generated workspace type paths", () => {
  // Characterisation test: this JSON is the verbatim output of
  // `writeFrontendTypePaths` before it was rewritten on top of the helper,
  // for a workspace holding one module with three layers, one with two (one
  // of them a same-named overlay), and one with no layers directory at all.
  const EXPECTED = `{
  "compilerOptions": {
    "paths": {
      "#dms/frontend-module": [
        "./frontend-module.ts"
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
    const workspace = mkdtempSync(join(tmpdir(), "dms-paths-workspace-"));
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
        path: mkdtempSync(join(tmpdir(), "dms-src-low-")),
        packageName: "@dms/low",
        priority: 1,
      },
      {
        path: mkdtempSync(join(tmpdir(), "dms-src-high-")),
        packageName: "@dms/high",
        priority: 10,
      },
      {
        path: mkdtempSync(join(tmpdir(), "dms-src-flat-")),
        packageName: "@dms/flat",
        priority: 5,
      },
    ]);

    assert.equal(
      readFileSync(join(workspace, "frontend-paths.generated.json"), "utf8"),
      EXPECTED,
    );
  });
});

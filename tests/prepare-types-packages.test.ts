import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
  dependencyRoots,
  packagePaths,
  readManifest,
} from "../src/prepare-types-packages";

const ROOT = "./node_modules/pkg";

function paths(
  manifest: Parameters<typeof packagePaths>[2],
): Record<string, string[]> {
  return Object.fromEntries(packagePaths("pkg", ROOT, manifest));
}

void describe("packagePaths", () => {
  void it("maps a subpath pattern of exports onto its target pattern", () => {
    assert.deepEqual(
      paths({ exports: { "./runtime/*": "./dist/runtime/*" } })[
        "pkg/runtime/*"
      ],
      ["./node_modules/pkg/dist/runtime/*"],
    );
  });

  void it("picks types over import over default, at every depth", () => {
    assert.deepEqual(
      paths({
        exports: {
          ".": {
            require: "./index.cjs",
            default: "./index.js",
            import: { node: "./node.mjs", types: "./index.d.mts" },
          },
          "./a": { import: "./a.mjs", types: "./a.d.ts" },
          "./utils": [{ default: "./utils.d.ts" }, "./utils.js"],
        },
      }),
      {
        pkg: ["./node_modules/pkg/index.d.mts"],
        "pkg/a": ["./node_modules/pkg/a.d.ts"],
        "pkg/utils": ["./node_modules/pkg/utils.d.ts"],
        "pkg/*": ["./node_modules/pkg/*"],
      },
    );
  });

  void it("lists the declaration of a JavaScript target before it, and the top-level types before that of .", () => {
    assert.deepEqual(
      paths({
        types: "dist/main.d.ts",
        exports: {
          ".": "./dist/index.js",
          "./module": "./dist/module.mjs",
          "./common": "./dist/common.cjs",
          "./*.js": "./dist/*.js",
        },
      }),
      {
        pkg: [
          "./node_modules/pkg/dist/main.d.ts",
          "./node_modules/pkg/dist/index.d.ts",
          "./node_modules/pkg/dist/index.js",
        ],
        "pkg/module": [
          "./node_modules/pkg/dist/module.d.mts",
          "./node_modules/pkg/dist/module.mjs",
        ],
        "pkg/common": [
          "./node_modules/pkg/dist/common.d.cts",
          "./node_modules/pkg/dist/common.cjs",
        ],
        "pkg/*.js": [
          "./node_modules/pkg/dist/*.d.ts",
          "./node_modules/pkg/dist/*.js",
        ],
        "pkg/*": ["./node_modules/pkg/*"],
      },
    );
  });

  void it("reads a bare condition map as the exports of .", () => {
    assert.deepEqual(
      paths({ exports: { import: { types: "./types/index.d.ts" } } }).pkg,
      ["./node_modules/pkg/types/index.d.ts"],
    );
  });

  void it("falls back to the package directory for what exports leave out", () => {
    assert.deepEqual(paths({}), {
      pkg: ["./node_modules/pkg"],
      "pkg/*": ["./node_modules/pkg/*"],
    });
    assert.deepEqual(
      Object.keys(paths({ exports: { "./*": "./dist/*", "./x": null } })),
      ["pkg/*", "pkg"],
    );
  });

  void it("leaves out a subpath or target with more than one wildcard", () => {
    assert.deepEqual(
      Object.keys(
        paths({
          exports: { "./a/*/b/*": "./dist/*", "./c/*": "./dist/*/x/*" },
        }),
      ),
      ["pkg", "pkg/*"],
    );
  });
});

void describe("dependencyRoots", () => {
  const out = resolve("/work/.dms-types");

  void it("roots the workspace's dependencies in it and the others in their module's copy", () => {
    assert.deepEqual(
      dependencyRoots({
        outDir: out,
        workspace: ["vue", "@antelopejs/dms-frontend-vue"],
        layers: [
          { id: "core", dependencies: ["vue", "apexcharts", "@scope/shop"] },
          { id: "shop", dependencies: ["apexcharts", "stripe"] },
        ],
        modules: ["@antelopejs/dms-frontend-vue", undefined, "@scope/shop"],
      }),
      [
        { name: "vue", root: join(out, "node_modules", "vue") },
        {
          name: "apexcharts",
          root: join(
            out,
            "frontend-modules",
            "core",
            "node_modules",
            "apexcharts",
          ),
        },
        {
          name: "stripe",
          root: join(out, "frontend-modules", "shop", "node_modules", "stripe"),
        },
      ],
    );
  });
});

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "dms-prepare-types-packages-")),
  );
  roots.push(root);
  return root;
}

void describe("readManifest", () => {
  void it("reads typings as the top-level types, and the exports", () => {
    const root = directory();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ typings: "types/index.d.ts", exports: "./index.js" }),
    );
    assert.deepEqual(readManifest(root), {
      types: "types/index.d.ts",
      exports: "./index.js",
    });
  });

  void it("is empty for a package with no package.json", () => {
    const root = join(directory(), "missing");
    mkdirSync(root);
    assert.deepEqual(readManifest(root), {});
  });
});

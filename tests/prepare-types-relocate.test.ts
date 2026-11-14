import * as assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import {
  relocateAutoImports,
  relocateTsconfig,
  type RelocatedLayer,
  type Tsconfig,
} from "../src/prepare-types-relocate";

const OUT = resolve("/work/project/.dms-types");

function layer(id: string, source: string): RelocatedLayer {
  return { id, copy: join(OUT, "frontend-modules", id), source };
}

const CORE = layer("antelopejs__dms-frontend-vue", resolve("/work/dms/core"));
const SHOP = layer("shop-vue", resolve("/work/project/shop-vue"));

const TEMPLATE: Tsconfig = {
  compilerOptions: { strict: true, types: ["vite/client"] },
  files: ["globals.d.ts", "auto-imports.d.ts"],
  include: ["frontend-modules/**/*.ts", "frontend-modules/**/*.vue"],
  exclude: ["**/node_modules", "**/tests"],
};

const PATHS = {
  "#dms/frontend-module": ["./frontend-module.ts"],
  "@frontend/*": ["./frontend-modules/*"],
  "#dms-core/*": [
    "./frontend-modules/antelopejs__dms-frontend-vue/layers/dms-core/*",
  ],
};

function relocate(layers: RelocatedLayer[], outDir = OUT) {
  return relocateTsconfig({ template: TEMPLATE, paths: PATHS, layers, outDir });
}

void describe("relocateTsconfig", () => {
  void it("aims a layer alias at the source tree and keeps a runtime file's", () => {
    assert.deepEqual(relocate([CORE, SHOP]).compilerOptions.paths, {
      "#dms/frontend-module": ["./frontend-module.ts"],
      "@frontend/antelopejs__dms-frontend-vue/*": ["../../dms/core/*"],
      "@frontend/shop-vue/*": ["../shop-vue/*"],
      "#dms-core/*": ["../../dms/core/layers/dms-core/*"],
    });
  });

  void it("sets the options the sources need, lists the shims, drops the extends", () => {
    const config = relocate([CORE]);
    const { paths: _paths, ...options } = config.compilerOptions;
    assert.deepEqual(options, {
      strict: true,
      types: [],
      allowArbitraryExtensions: true,
    });
    assert.deepEqual(Object.keys(config), [
      "compilerOptions",
      "files",
      "include",
      "exclude",
    ]);
    assert.deepEqual(config.files, [
      "globals.d.ts",
      "auto-imports.d.ts",
      "node_modules/vite/client.d.ts",
      "vue-shims.d.ts",
    ]);
  });

  void it("globs each source tree, not the copies, with its own excludes", () => {
    const config = relocate([CORE, SHOP]);
    assert.deepEqual(config.include, [
      "../../dms/core/**/*.ts",
      "../shop-vue/**/*.ts",
      "../../dms/core/**/*.vue",
      "../shop-vue/**/*.vue",
    ]);
    assert.deepEqual(config.exclude, [
      "../../dms/core/**/node_modules",
      "../shop-vue/**/node_modules",
      "../../dms/core/**/tests",
      "../shop-vue/**/tests",
    ]);
  });

  void it("excludes the output when it lies inside a source tree", () => {
    const inside = relocate([SHOP], join(SHOP.source, ".dms-types"));
    const outside = relocate([SHOP]);
    assert.deepEqual(
      [inside.exclude.includes("."), outside.exclude.includes(".")],
      [true, false],
    );
  });
});

const AUTO_IMPORTS = [
  "export {}",
  "declare global {",
  "  const useCore: typeof import('./frontend-modules/antelopejs__dms-frontend-vue/app/composables/useCore')['useCore']",
  "  const useShop: typeof import('./frontend-modules/shop-vue/app/useShop.ts')['useShop']",
  "  const ref: typeof import('vue')['ref']",
  "  export type { Link } from './frontend-modules/shop-vue/app/links'",
  "}",
].join("\n");

void describe("relocateAutoImports", () => {
  void it("aims each import of a copy at the source of its module", () => {
    assert.equal(
      relocateAutoImports(AUTO_IMPORTS, [CORE, SHOP], OUT),
      AUTO_IMPORTS.replaceAll(
        "./frontend-modules/antelopejs__dms-frontend-vue/",
        "../../dms/core/",
      ).replaceAll("./frontend-modules/shop-vue/", "../shop-vue/"),
    );
  });

  void it("fails when a copy of a module it does not know is left", () => {
    assert.throws(
      () => relocateAutoImports(AUTO_IMPORTS, [CORE], OUT),
      (error) =>
        error instanceof CliError &&
        /shop-vue/.test(error.problem.reason ?? ""),
    );
  });
});

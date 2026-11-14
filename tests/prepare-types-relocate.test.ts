import * as assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { isPlainObject } from "../src/internal/plain-object";
import {
  commonAncestor,
  isVueDeclaration,
  relocateAutoImports,
  relocateTsconfig,
  type RelocatedLayer,
  sharedDependencies,
  type Tsconfig,
  vueDeclarationsConfig,
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

function pathEntries(config: Tsconfig): [string, unknown][] {
  const { paths } = config.compilerOptions;
  assert.ok(isPlainObject(paths));
  return Object.entries(paths);
}

function relocate(
  layers: RelocatedLayer[],
  outDir = OUT,
  dependencies: string[] = [],
) {
  return relocateTsconfig({
    template: TEMPLATE,
    paths: PATHS,
    layers,
    outDir,
    rootDir: commonAncestor(layers.map(({ source }) => source)),
    dependencies,
  });
}

void describe("relocateTsconfig", () => {
  void it("aims a layer alias at the source tree and keeps a runtime file's", () => {
    const { paths } = relocate([CORE, SHOP]).compilerOptions;
    assert.deepEqual(paths, {
      "#dms/frontend-module": ["./frontend-module.ts"],
      "@frontend/antelopejs__dms-frontend-vue/*": [
        "../../dms/core/*",
        "./vue-declarations/dms/core/*",
      ],
      "@frontend/shop-vue/*": [
        "../shop-vue/*",
        "./vue-declarations/project/shop-vue/*",
      ],
      "#dms-core/*": [
        "../../dms/core/layers/dms-core/*",
        "./vue-declarations/dms/core/layers/dms-core/*",
      ],
    });
  });

  void it("sets the options the sources need, lists the shims, drops the extends", () => {
    const config = relocate([CORE]);
    const { paths: _paths, ...options } = config.compilerOptions;
    assert.deepEqual(options, {
      strict: true,
      types: [],
      allowArbitraryExtensions: true,
      rootDirs: ["../../dms/core", "./vue-declarations"],
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

  void it("resolves each dependency of the workspace from it, bare and with a subpath", () => {
    const entries = pathEntries(relocate([CORE], OUT, ["vue", "@vueuse/core"]));
    assert.deepEqual(
      entries.filter(([, targets]) =>
        JSON.stringify(targets).includes("./node_modules/"),
      ),
      [
        ["vue", ["./node_modules/vue"]],
        ["vue/*", ["./node_modules/vue/*"]],
        ["@vueuse/core", ["./node_modules/@vueuse/core"]],
        ["@vueuse/core/*", ["./node_modules/@vueuse/core/*"]],
      ],
    );
  });

  void it("mirrors no target outside the sources, such as a runtime entry of the workspace", () => {
    assert.deepEqual(
      pathEntries(relocate([CORE])).find(
        ([alias]) => alias === "#dms/frontend-module",
      ),
      ["#dms/frontend-module", ["./frontend-module.ts"]],
    );
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

void describe("vueDeclarationsConfig", () => {
  void it("emits only declarations, for the .vue files of every source, from their common root", () => {
    assert.deepEqual(
      vueDeclarationsConfig({
        layers: [CORE, SHOP],
        outDir: OUT,
        rootDir: resolve("/work"),
      }),
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          noEmitOnError: false,
          outDir: "./vue-declarations",
          rootDir: "../..",
        },
        include: ["../../dms/core/**/*.vue", "../shop-vue/**/*.vue"],
      },
    );
  });
});

void describe("commonAncestor", () => {
  void it("is the deepest directory that holds every path", () => {
    assert.equal(
      commonAncestor([
        resolve("/work/dms/core"),
        resolve("/work/project/shop"),
      ]),
      resolve("/work"),
    );
  });

  void it("is the path itself for one path, and does not split a name in two", () => {
    assert.deepEqual(
      [
        commonAncestor([resolve("/work/shop")]),
        commonAncestor([resolve("/work/shop"), resolve("/work/shop-vue")]),
      ],
      [resolve("/work/shop"), resolve("/work")],
    );
  });
});

void describe("isVueDeclaration", () => {
  void it("keeps the declaration of a component and drops that of a .ts source", () => {
    assert.deepEqual(
      ["Table.vue.d.ts", "table.d.ts", "Table.vue", "x.d.vue.ts"].map(
        isVueDeclaration,
      ),
      [true, false, false, false],
    );
  });
});

void describe("sharedDependencies", () => {
  void it("leaves out the packages of the modules, which resolve from their sources", () => {
    assert.deepEqual(
      sharedDependencies(
        ["vue", "@antelopejs/dms", "@antelopejs/dms-ui", "nuxt"],
        ["@antelopejs/dms", undefined, "@antelopejs/dms-ui"],
      ),
      ["vue", "nuxt"],
    );
  });
});

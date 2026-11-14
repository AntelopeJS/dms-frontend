import * as assert from "node:assert/strict";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { isPlainObject } from "../src/internal/plain-object";
import {
  isVueDeclaration,
  relocateAutoImports,
  relocateTsconfig,
  type RelocatedLayer,
  type Tsconfig,
  typesEntry,
  vueDeclarationsConfig,
} from "../src/prepare-types-relocate";
import type { InstalledPackage } from "../src/prepare-types-packages";

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
  dependencies: InstalledPackage[] = [],
) {
  return relocateTsconfig({
    template: TEMPLATE,
    paths: PATHS,
    layers,
    outDir,
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
        "./vue-declarations/work/dms/core/*",
      ],
      "@frontend/shop-vue/*": [
        "../shop-vue/*",
        "./vue-declarations/work/project/shop-vue/*",
      ],
      "#dms-core/*": [
        "../../dms/core/layers/dms-core/*",
        "./vue-declarations/work/dms/core/layers/dms-core/*",
      ],
    });
  });

  void it("sets the options the sources need, lists the entry declaration, drops the extends", () => {
    const config = relocate([CORE]);
    const { paths: _paths, ...options } = config.compilerOptions;
    assert.deepEqual(options, {
      strict: true,
      types: [],
      allowArbitraryExtensions: true,
      rootDirs: ["../../..", "./vue-declarations"],
    });
    assert.deepEqual(Object.keys(config), [
      "compilerOptions",
      "files",
      "include",
      "exclude",
    ]);
    assert.deepEqual(config.files, ["types.d.ts"]);
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

  void it("resolves each dependency from where it is installed, as its exports map it", () => {
    const entries = pathEntries(
      relocate([CORE], OUT, [
        { name: "vue", root: join(OUT, "node_modules", "vue"), manifest: {} },
        {
          name: "apexcharts",
          root: join(
            OUT,
            "frontend-modules",
            "core",
            "node_modules",
            "apexcharts",
          ),
          manifest: { exports: { "./locales/*": "./dist/locales/*" } },
        },
      ]),
    );
    assert.deepEqual(
      entries.filter(([, targets]) =>
        JSON.stringify(targets).includes("/node_modules/"),
      ),
      [
        ["vue", ["./node_modules/vue"]],
        ["vue/*", ["./node_modules/vue/*"]],
        [
          "apexcharts/locales/*",
          ["./frontend-modules/core/node_modules/apexcharts/dist/locales/*"],
        ],
        ["apexcharts", ["./frontend-modules/core/node_modules/apexcharts"]],
        ["apexcharts/*", ["./frontend-modules/core/node_modules/apexcharts/*"]],
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

void describe("relocateTsconfig with @types packages", () => {
  void it("resolves a package that declares no types from its @types package, and one that does from itself", () => {
    const installed = (
      name: string,
      manifest: InstalledPackage["manifest"],
    ) => ({
      name,
      root: join(OUT, "node_modules", name),
      manifest,
    });
    const paths = Object.fromEntries(
      pathEntries(
        relocate([CORE], OUT, [
          installed("sortablejs", {}),
          installed("@types/sortablejs", { types: "index.d.ts" }),
          installed("@scope/untyped", {}),
          installed("@types/scope__untyped", {}),
          installed("typed", { exports: { ".": { types: "./a.d.ts" } } }),
          installed("@types/typed", {}),
          installed("declared", { types: "index.d.ts" }),
          installed("@types/declared", {}),
        ]),
      ),
    );
    assert.deepEqual(
      [paths.sortablejs, paths["sortablejs/*"], paths["@scope/untyped"]],
      [
        ["./node_modules/@types/sortablejs"],
        ["./node_modules/@types/sortablejs/*"],
        ["./node_modules/@types/scope__untyped"],
      ],
    );
    assert.deepEqual(
      [paths.typed, paths.declared],
      [["./node_modules/typed/a.d.ts"], ["./node_modules/declared"]],
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
  void it("emits only declarations, for the .vue files of every source, from the filesystem root, with the global types in the output", () => {
    assert.deepEqual(
      vueDeclarationsConfig({ layers: [CORE, SHOP], outDir: OUT }),
      {
        extends: "./tsconfig.json",
        compilerOptions: {
          noEmit: false,
          declaration: true,
          emitDeclarationOnly: true,
          noEmitOnError: false,
          outDir: "./vue-declarations",
          rootDir: "../../..",
        },
        include: ["../../dms/core/**/*.vue", "../shop-vue/**/*.vue"],
        vueCompilerOptions: { globalTypesPath: "./vue-global-types.d.ts" },
      },
    );
  });
});

/**
 * Where TypeScript writes the declaration of `file` under `config`: below
 * `outDir` at its path from `rootDir`, or beside `file` when it lies outside
 * `rootDir`.
 */
function emittedTo(
  config: ReturnType<typeof vueDeclarationsConfig>,
  file: string,
): string {
  const { outDir, rootDir } = config.compilerOptions;
  const path = relative(resolve(OUT, rootDir), file);
  return path.startsWith("..") || isAbsolute(path)
    ? file
    : join(resolve(OUT, outDir), path);
}

void describe("the .vue declarations emit", () => {
  void it("writes the declaration of any file of the drive under vue-declarations, one outside the sources included", () => {
    const config = vueDeclarationsConfig({ layers: [CORE, SHOP], outDir: OUT });
    const declarations = join(OUT, "vue-declarations");
    for (const file of [
      join(CORE.source, "app", "Table.vue"),
      resolve("/work/shared/util.ts"),
      resolve("/elsewhere/util.ts"),
    ]) {
      const path = relative(declarations, emittedTo(config, file));
      assert.ok(!path.startsWith("..") && !isAbsolute(path), file);
    }
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

void describe("typesEntry", () => {
  void it("references each file of the workspace, the Vite client types and the shims, from its own directory", () => {
    assert.equal(
      typesEntry(TEMPLATE),
      [
        '/// <reference path="./globals.d.ts" />',
        '/// <reference path="./auto-imports.d.ts" />',
        '/// <reference path="./node_modules/vite/client.d.ts" />',
        '/// <reference path="./vue-shims.d.ts" />',
        "",
      ].join("\n"),
    );
  });
});

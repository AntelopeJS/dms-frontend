import * as assert from "node:assert/strict";
import { isAbsolute, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { isPlainObject } from "../src/internal/plain-object";
import {
  declarationsRoot,
  isVueDeclaration,
  relativelyReached,
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
  rootDir = resolve("/"),
) {
  return relocateTsconfig({
    template: TEMPLATE,
    paths: PATHS,
    layers,
    outDir,
    dependencies,
    rootDir,
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

void describe("relocateTsconfig with the declarations lifted to a directory", () => {
  void it("aims each mirror target and rootDirs at that directory, naming none above it", () => {
    const config = relocate([CORE, SHOP], OUT, [], resolve("/work"));
    assert.deepEqual(config.compilerOptions.paths, {
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
    assert.deepEqual(config.compilerOptions.rootDirs, [
      "../..",
      "./vue-declarations",
    ]);
  });
});

void describe("relativelyReached", () => {
  void it("follows relative imports and references from the sources, and no package or what it imports", () => {
    const cwd = resolve("/work/project/.dms-types");
    const explanation = [
      "../shop/app/Cart.vue",
      "  Matched by include pattern '../shop/**/*.vue' in 'tsconfig.vue-declarations.json'",
      "../../shared/ids.d.ts",
      "  Imported via \"../../../shared/ids.js\" from file '../shop/app/Cart.vue'",
      "../../shared/more.d.ts",
      "  Imported via './more' from file '../../shared/ids.d.ts'",
      "../../typings/globals.d.ts",
      "  Referenced via '../../../typings/globals.d.ts' from file '../shop/app/Cart.vue'",
      "node_modules/vue/dist/vue.d.ts",
      "  Imported via \"vue\" from file '../shop/app/Cart.vue' with packageId 'vue/dist/vue.d.ts@3.5.0'",
      "node_modules/vue/dist/runtime.d.ts",
      "  Imported via './runtime' from file 'node_modules/vue/dist/vue.d.ts'",
      "../../shared/level/index.d.ts",
      "  Imported via \"./level\" from file '../../shared/more.d.ts' with packageId 'level/index.d.ts@1.0.0'",
      "../../ui/Badge.vue",
      "  Imported via \"@ui/Badge.vue\" from file '../shop/app/Cart.vue'",
      "../../ui/tones.d.ts",
      "  Imported via './tones' from file '../../ui/Badge.vue'",
      "../../lazy/thing.d.ts",
      "  Imported via `../../../lazy/thing` from file '../shop/app/Cart.vue'",
      "../../lazy/g.d.ts",
      "  Referenced via 'g.d.ts' from file '../../lazy/thing.d.ts'",
      "",
    ].join("\n");
    assert.deepEqual(
      relativelyReached(explanation, cwd, {
        sources: [resolve("/work/project/shop")],
        declared: [resolve("/work/ui/Badge.vue")],
      }).sort(),
      [
        resolve("/work/lazy/g.d.ts"),
        resolve("/work/lazy/thing.d.ts"),
        resolve("/work/shared/ids.d.ts"),
        resolve("/work/shared/level/index.d.ts"),
        resolve("/work/shared/more.d.ts"),
        resolve("/work/typings/globals.d.ts"),
        resolve("/work/ui/Badge.vue"),
        resolve("/work/ui/tones.d.ts"),
      ],
    );
  });
});

void describe("declarationsRoot", () => {
  void it("is the deepest directory that holds every path", () => {
    assert.equal(
      declarationsRoot([
        resolve("/work/project/shop-vue"),
        resolve("/work/project/node_modules/dms/core"),
        resolve("/work/shared"),
      ]),
      resolve("/work"),
    );
    assert.equal(
      declarationsRoot([
        resolve("/work/project"),
        resolve("/work/project/app"),
      ]),
      resolve("/work/project"),
    );
  });

  void it(
    "refuses paths on different drives",
    { skip: process.platform !== "win32" && "drives are a Windows notion" },
    () => {
      assert.throws(
        () => declarationsRoot(["C:\\work\\shop", "D:\\work\\core"]),
        (error) => error instanceof CliError,
      );
    },
  );
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

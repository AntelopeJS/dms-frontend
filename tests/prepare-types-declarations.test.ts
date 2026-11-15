import * as assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { pathToFileURL } from "node:url";
import { emitVueDeclarations } from "../src/prepare-types-declarations";
import {
  filesystemRoot,
  layerTable,
  relocateTsconfig,
} from "../src/prepare-types-relocate";
import { ViteWarnings } from "../src/vite-output";
import { listTree, readText } from "./helpers/files";

const TEMPLATE = resolve("templates", "vue");
const PRELOADS = [
  "typecheck-loader.mjs",
  "app-config-stub.mjs",
  "workspace-writes.mjs",
  "vue-components.mjs",
];

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(parent = tmpdir()): string {
  const root = realpathSync.native(
    mkdtempSync(join(parent, "dms-prepare-declarations-")),
  );
  roots.push(root);
  return root;
}

/** A temporary directory on another drive than `tmpdir()`, when the machine has one. */
function otherDrive(): string | undefined {
  const drive = parse(realpathSync.native(tmpdir())).root.toLowerCase();
  const parent = [process.env.RUNNER_TEMP, process.cwd()].find(
    (candidate) =>
      candidate !== undefined &&
      parse(resolve(candidate)).root.toLowerCase() !== drive,
  );
  return parent === undefined ? undefined : directory(parent);
}

/** A workspace that runs the repository's `vue-tsc` with the shipped preloads. */
function workspace(exclude: string[] = [], out = directory()): string {
  mkdirSync(out, { recursive: true });
  for (const file of PRELOADS)
    copyFileSync(join(TEMPLATE, file), join(out, file));
  symlinkSync(resolve("node_modules"), join(out, "node_modules"), "junction");
  writeFileSync(
    join(out, "tsconfig.json"),
    `${JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        skipLibCheck: true,
        noEmit: true,
        types: [],
      },
      files: [],
      exclude,
    })}\n`,
  );
  return out;
}

/** A module whose component imports `util.ts` from `shared`, with a `vue` of its own installed. */
function moduleImporting(shared: string): string {
  const source = directory();
  mkdirSync(join(source, "app"));
  mkdirSync(join(source, "node_modules", "vue"), { recursive: true });
  writeFileSync(
    join(source, "node_modules", "vue", "package.json"),
    '{ "name": "vue", "version": "3.5.0" }\n',
  );
  writeFileSync(
    join(shared, "util.ts"),
    'export const label = (): string => "cart";\n',
  );
  writeFileSync(
    join(source, "app", "Cart.vue"),
    [
      '<script setup lang="ts">',
      `import { label } from ${JSON.stringify(join(shared, "util").replaceAll("\\", "/"))};`,
      "export interface Row { id: string }",
      "defineProps<{ rows: Row[] }>();",
      "const text = label();",
      "</script>",
      "<template><p>{{ text }}</p></template>",
      "",
    ].join("\n"),
  );
  return source;
}

async function emit(out: string, source: string): Promise<string> {
  return emitVueDeclarations(
    {
      workspace: out,
      isVerbose: false,
      mapLine: (line) => line,
      warnings: new ViteWarnings(),
      env: process.env,
    },
    [{ path: source, packageName: "@test/shop" }],
  );
}

/** The diagnostics `tsc` reports for the tsconfig in `out`, empty when it type-checks. */
function typecheck(out: string): string {
  const result = spawnSync(
    process.execPath,
    [resolve("node_modules", "typescript", "bin", "tsc"), "-p", out],
    { cwd: out, encoding: "utf8" },
  );
  assert.equal(result.error, undefined);
  return result.stdout;
}

/** Every path under `root`, relative to it. */
function files(root: string): string[] {
  return listTree(root).sort();
}

void describe("emitVueDeclarations", () => {
  void it("writes the global types of the components under the output, not in the node_modules of the sources", async () => {
    const out = workspace();
    const shared = directory();
    const source = moduleImporting(shared);
    const before = files(source);
    await emit(out, source);
    assert.deepEqual(files(source), before);
    assert.deepEqual(files(shared), ["util.ts"]);
    const declaration = join(
      out,
      "vue-declarations",
      basename(source),
      "app",
      "Cart.vue.d.ts",
    );
    assert.ok(existsSync(declaration), declaration);
  });

  void it("writes the declarations when the output is a symlink at another depth than its real path", async () => {
    const out = workspace();
    const link = join(directory(), "nested", "deeper", "out");
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(out, link, "junction");
    const source = moduleImporting(directory());
    await emit(link, source);
    const declaration = join(
      out,
      "vue-declarations",
      basename(source),
      "app",
      "Cart.vue.d.ts",
    );
    assert.ok(existsSync(declaration), declaration);
  });

  void it("fails and lists every component left without a declaration, and no component the configuration excludes", async () => {
    const source = moduleImporting(directory());
    const out = workspace([`${source}/**/tests`]);
    const undeclarable = (...path: string[]) => {
      mkdirSync(join(source, ...path.slice(0, -1)), { recursive: true });
      writeFileSync(
        join(source, ...path),
        [
          '<script setup lang="ts" generic="T">',
          "const count = 1;",
          "interface Props { item: T; count: number }",
          "defineProps<Props>();",
          "</script>",
          "<template><p>{{ count }}</p></template>",
          "",
        ].join("\n"),
      );
    };
    undeclarable("app", "List.vue");
    undeclarable("app", "nested", "Grid.vue");
    undeclarable("tests", "Fixture.vue");
    await assert.rejects(emit(out, source), (error: Error) => {
      assert.ok(error instanceof CliError);
      assert.equal(
        error.problem.title,
        "No declaration was written for 2 .vue components",
      );
      assert.deepEqual(
        error.problem.details?.filter((line) => line.endsWith(".vue")),
        [
          join(source, "app", "List.vue"),
          join(source, "app", "nested", "Grid.vue"),
        ],
      );
      return true;
    });
  });

  const shared = otherDrive();
  const requireSecondDrive =
    process.platform === "win32" && process.env.CI === "true";
  void it(
    "writes nothing beside a .ts file a component imports from another drive",
    { skip: shared === undefined && !requireSecondDrive && "no second drive" },
    async () => {
      assert.ok(shared, "the Windows CI runner has a second drive");
      const out = workspace();
      const source = moduleImporting(shared);
      await emit(out, source);
      assert.deepEqual(files(shared), ["util.ts"]);
    },
  );
});

/**
 * A directory holding a project, `proj`, with its module `shop` and the types
 * `prepare-types` writes for it in `.dms-types`, and the siblings `shared` and
 * `shared-ui` that the module imports from by relative path. `files` are more
 * files of the module, by path from its root.
 */
async function preparedProject(
  files: Record<string, string> = {},
): Promise<{ top: string; project: string }> {
  const top = directory();
  const project = join(top, "proj");
  const out = workspace([], join(project, ".dms-types"));
  const source = join(project, "shop");
  const write = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  symlinkSync(resolve("node_modules"), join(top, "node_modules"), "junction");
  write(join(top, "shared", "ids.ts"), "export type Id = string;\n");
  write(
    join(top, "shared-ui", "Badge.vue"),
    [
      '<script setup lang="ts">',
      'export type Tone = "info" | "alert";',
      "defineProps<{ tone: Tone }>();",
      "</script>",
      "<template><b>{{ tone }}</b></template>",
      "",
    ].join("\n"),
  );
  write(
    join(source, "app", "Cart.vue"),
    [
      '<script setup lang="ts">',
      'import type { Id } from "../../../shared/ids";',
      'import type { Tone } from "../../../shared-ui/Badge.vue";',
      "export interface Row { id: Id; tone: Tone }",
      "defineProps<{ rows: Row[] }>();",
      "</script>",
      "<template><p>{{ rows.length }}</p></template>",
      "",
    ].join("\n"),
  );
  write(
    join(source, "app", "rows.ts"),
    'import type { Row } from "./Cart.vue";\nimport type { Tone } from "../../../shared-ui/Badge.vue";\nconst tone: Tone = "info";\nexport const rows: Row[] = [{ id: "a", tone }];\n',
  );
  for (const [path, text] of Object.entries(files))
    write(join(source, path), text);
  const layers = [{ path: source, packageName: "@test/shop" }];
  const table = layerTable(out, layers);
  const writeTsconfig = (rootDir: string) =>
    writeFileSync(
      join(out, "tsconfig.json"),
      JSON.stringify(
        relocateTsconfig({
          template: {
            compilerOptions: {
              strict: true,
              target: "ESNext",
              module: "ESNext",
              moduleResolution: "Bundler",
              skipLibCheck: true,
              noEmit: true,
            },
            files: [],
            include: ["frontend-modules/**/*.ts"],
            exclude: [],
          },
          paths: { "@frontend/*": ["./frontend-modules/*"] },
          layers: table,
          outDir: out,
          dependencies: [],
          rootDir,
        }),
      ),
    );
  writeTsconfig(filesystemRoot(table));
  writeFileSync(join(out, "types.d.ts"), "export {};\n");
  writeTsconfig(await emit(out, source));
  return { top, project };
}

void describe("a prepared project", () => {
  void it("type-checks the named types of its own and its siblings' components, in place and after it moves with them", async () => {
    const { top, project } = await preparedProject();
    assert.equal(typecheck(join(project, ".dms-types")), "");
    const moved = join(directory(), "checked", "out", "elsewhere");
    cpSync(top, moved, { recursive: true, verbatimSymlinks: true });
    rmSync(top, { recursive: true, force: true });
    assert.equal(typecheck(join(moved, "proj", ".dms-types")), "");
    assert.ok(
      !readText(join(moved, "proj", ".dms-types", "tsconfig.json")).includes(
        basename(top),
      ),
    );
  });

  void it("keeps the types a component imports from a sibling, so a wrong value is reported", async () => {
    const { project } = await preparedProject({
      "app/wrong.ts":
        'import type { Row } from "./Cart.vue";\nexport const wrong: Row = { id: 1, tone: "info" };\n',
    });
    assert.match(typecheck(join(project, ".dms-types")), /wrong\.ts.*TS2322/);
  });
});

void describe("workspace-writes.mjs", () => {
  void it("refuses every write outside the working directory and allows those inside it", () => {
    const root = directory();
    const cwd = join(root, "out");
    mkdirSync(cwd);
    const probe = [
      'import fs from "node:fs";',
      "const tries = {",
      '  write: (path) => fs.writeFileSync(path, "x"),',
      '  open: (path) => fs.closeSync(fs.openSync(path, "w")),',
      "  mkdir: (path) => fs.mkdirSync(path),",
      "};",
      "const results = {};",
      "for (const [name, write] of Object.entries(tries))",
      '  for (const where of ["inside", "outside"]) {',
      '    const path = where === "inside" ? `${name}-in` : `../out-${name}`;',
      "    try { write(path); results[`${name} ${where}`] = true; }",
      "    catch { results[`${name} ${where}`] = false; }",
      "  }",
      "console.log(JSON.stringify(results));",
    ].join("\n");
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(join(TEMPLATE, "workspace-writes.mjs")).href,
        "--input-type=module",
        "-e",
        probe,
      ],
      { cwd, encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(output), {
      "write inside": true,
      "write outside": false,
      "open inside": true,
      "open outside": false,
      "mkdir inside": true,
      "mkdir outside": false,
    });
    assert.deepEqual(files(root), [
      "out",
      ...["mkdir-in", "open-in", "write-in"].map((name) => `out${sep}${name}`),
    ]);
  });
});

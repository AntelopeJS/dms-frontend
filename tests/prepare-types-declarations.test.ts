import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, parse, relative, resolve, sep } from "node:path";
import { after, describe, it } from "node:test";
import { emitVueDeclarations } from "../src/prepare-types-declarations";
import { ViteWarnings } from "../src/vite-output";
import { listTree } from "./helpers/files";

const TEMPLATE = resolve("templates", "vue");
const PRELOADS = [
  "typecheck-loader.mjs",
  "app-config-stub.mjs",
  "workspace-writes.mjs",
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
function workspace(): string {
  const out = directory();
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

async function emit(out: string, source: string): Promise<void> {
  await emitVueDeclarations(
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
      relative(parse(source).root, source),
      "app",
      "Cart.vue.d.ts",
    );
    assert.ok(existsSync(declaration), declaration);
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
        join(TEMPLATE, "workspace-writes.mjs"),
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

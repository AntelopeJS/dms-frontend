import * as assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { after, describe, it } from "node:test";
import { runPrepareTypes } from "../src/commands/prepare-types-action";
import { UsageError } from "../src/common";
import { listNames, listTree, readText } from "./helpers/files";
import { jsonAt, readJson } from "./helpers/json";
import {
  assertOutsideSources,
  outputProblems,
  publishStaging,
  resetStaging,
  runInputs,
  TYPES_MARKER,
  writeRelocatedTypes,
} from "../src/prepare-types-output";
import { layerTable } from "../src/prepare-types-relocate";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), "dms-prepare-types-")),
  );
  roots.push(root);
  return root;
}

function titles(out: string, project = directory()): string[] {
  return outputProblems(out, project).map((problem) => problem.title);
}

void describe("outputProblems", () => {
  void it("accepts a new directory and an empty one", () => {
    const root = directory();
    mkdirSync(join(root, "empty"));
    assert.deepEqual(titles(join(root, "new")), []);
    assert.deepEqual(titles(join(root, "empty")), []);
  });

  void it("refuses a directory with files this command did not write", () => {
    const out = directory();
    writeFileSync(join(out, "notes.md"), "mine\n");
    assert.match(titles(out).join("\n"), /not empty and was not written/);
  });

  void it("accepts a directory this command wrote", () => {
    const out = join(directory(), "out");
    const staging = resetStaging(out);
    writeFileSync(join(staging, "tsconfig.json"), "{}\n");
    publishStaging(staging, out);
    assert.deepEqual(titles(out), []);
  });

  void it("refuses a file", () => {
    const out = join(directory(), "file");
    writeFileSync(out, "");
    assert.match(titles(out).join("\n"), /not a directory/);
  });

  void it("refuses a directory under node_modules", () => {
    const out = join(directory(), "node_modules", ".types");
    assert.match(titles(out).join("\n"), /under node_modules/);
  });

  void it("refuses a directory on another drive than the project", () => {
    const problems = outputProblems("D:\\types", "C:\\project", win32);
    assert.match(
      problems.map(({ title }) => title).join("\n"),
      /another drive/,
    );
    assert.deepEqual(outputProblems("c:\\types", "C:\\project", win32), []);
  });
});

void describe("runPrepareTypes", () => {
  void it("refuses a non-empty unmarked directory and writes nothing", async () => {
    const out = directory();
    writeFileSync(join(out, "notes.md"), "mine\n");
    await assert.rejects(runPrepareTypes({ out }), UsageError);
    assert.deepEqual(listNames(out), ["notes.md"]);
  });

  void it("refuses a directory under node_modules and writes nothing", async () => {
    const root = directory();
    const out = join(root, "node_modules", ".types");
    await assert.rejects(runPrepareTypes({ out }), UsageError);
    assert.deepEqual(listNames(root), []);
  });
});

void describe("resetStaging", () => {
  void it("marks an empty sibling of out, dropping what a failed run left, and leaves out as it was", () => {
    const root = directory();
    const out = join(root, "out");
    mkdirSync(out);
    writeFileSync(join(out, "tsconfig.json"), "{}\n");
    mkdirSync(join(root, "out.next", "node_modules"), { recursive: true });
    const staging = resetStaging(out);
    assert.equal(staging, join(root, "out.next"));
    assert.deepEqual(listNames(staging), [TYPES_MARKER]);
    assert.deepEqual(listNames(out), ["tsconfig.json"]);
  });
});

void describe("publishStaging", () => {
  void it("puts the staged set in place of out and leaves no sibling", () => {
    const root = directory();
    const out = join(root, "out");
    mkdirSync(out);
    writeFileSync(join(out, "stale.d.ts"), "");
    const staging = resetStaging(out);
    writeFileSync(join(staging, "tsconfig.json"), "{}\n");
    publishStaging(staging, out);
    assert.deepEqual(listNames(out).sort(), [TYPES_MARKER, "tsconfig.json"]);
    assert.deepEqual(listNames(root), ["out"]);
  });

  void it("replaces the directory a symlinked out links to and keeps the link", () => {
    const root = directory();
    const real = join(root, "real");
    mkdirSync(real);
    const out = join(root, "out");
    symlinkSync(real, out, "dir");
    const staging = resetStaging(out);
    writeFileSync(join(staging, "tsconfig.json"), "{}\n");
    publishStaging(staging, out);
    assert.equal(lstatSync(out).isSymbolicLink(), true);
    assert.deepEqual(listNames(real).sort(), [TYPES_MARKER, "tsconfig.json"]);
  });
});

void describe("assertOutsideSources", () => {
  void it("refuses an output that holds a source tree", () => {
    const out = directory();
    const source = join(out, "module");
    assert.throws(
      () => assertOutsideSources(out, [{ label: "m", path: source }]),
      /holds the sources/,
    );
    assert.doesNotThrow(() =>
      assertOutsideSources(join(source, ".types"), [
        { label: "m", path: source },
      ]),
    );
  });

  void it("refuses an output that is the source tree itself", () => {
    const out = directory();
    assert.throws(
      () => assertOutsideSources(out, [{ label: "m", path: out }]),
      /holds the sources/,
    );
  });

  void it("resolves symlinks on both sides", () => {
    const root = directory();
    const source = join(root, "module");
    mkdirSync(source);
    const outLink = join(directory(), "out");
    symlinkSync(root, outLink);
    const sourceLink = join(directory(), "module");
    symlinkSync(source, sourceLink);
    assert.throws(
      () => assertOutsideSources(outLink, [{ label: "m", path: source }]),
      /holds the sources/,
    );
    assert.throws(
      () => assertOutsideSources(root, [{ label: "m", path: sourceLink }]),
      /holds the sources/,
    );
  });

  void it("reads a directory whose name starts with two dots as inside", () => {
    const out = directory();
    assert.throws(
      () =>
        assertOutsideSources(out, [{ label: "m", path: join(out, "..mod") }]),
      /holds the sources/,
    );
    assert.doesNotThrow(() =>
      assertOutsideSources(out, [{ label: "m", path: join(out, "..", "m") }]),
    );
  });
});

void describe("layerTable", () => {
  void it("names each source by its real path, not the symlink it was given as", () => {
    const real = join(directory(), "frontend-vue");
    mkdirSync(real);
    const link = join(directory(), "installed");
    symlinkSync(real, link);
    const out = directory();
    assert.deepEqual(
      layerTable(out, [
        { path: link, packageName: "@scope/core" },
        { path: join(out, "copy"), sourcePath: link, packageName: "shop" },
        { path: real },
      ]).map(({ id, source }) => [id, source]),
      [
        ["scope__core", real],
        ["shop", real],
      ],
    );
  });
});

void describe("runInputs", () => {
  void it("lists a module without a package name and every local package", () => {
    assert.deepEqual(
      runInputs(
        [
          { path: "/copy/a", sourcePath: "/src/a", packageName: "a" },
          { path: "/src/unnamed" },
        ],
        { probe: "/pkg/probe" },
      ),
      [
        { label: "a", path: "/src/a" },
        { label: "/src/unnamed", path: "/src/unnamed" },
        { label: "probe", path: "/pkg/probe" },
      ],
    );
  });
});

void describe("writeRelocatedTypes", () => {
  void it("removes the files that name the copies by their absolute path, and writes none that names the output", () => {
    const project = directory();
    const source = join(project, "shop");
    const out = join(project, ".dms-types");
    const copy = join(out, "frontend-modules", "shop");
    mkdirSync(source, { recursive: true });
    mkdirSync(copy, { recursive: true });
    const files = {
      "tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true },
        files: ["auto-imports.d.ts"],
        include: ["frontend-modules/**/*.ts"],
        exclude: [],
      }),
      "frontend-paths.generated.json": JSON.stringify({
        compilerOptions: { paths: { "@frontend/*": ["./frontend-modules/*"] } },
      }),
      "package.json": JSON.stringify({ name: "workspace", dependencies: {} }),
      "auto-imports.d.ts": "export {};\n",
      "generated-frontend-modules.json": JSON.stringify({ root: copy }),
      "sfc-global-types.generated.d.ts": `declare type Row = import(${JSON.stringify(copy)}).Row;\n`,
      [join("frontend-modules", "shop", "package.json")]: JSON.stringify({
        name: "shop",
      }),
    };
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(out, file), text);
    writeRelocatedTypes(out, [{ path: source, packageName: "shop" }])(project);
    const written = listTree(out).filter((file) => /\.(json|ts)$/.test(file));
    assert.ok(!written.includes("generated-frontend-modules.json"));
    assert.ok(!written.includes("sfc-global-types.generated.d.ts"));
    assert.deepEqual(
      written.filter((file) => readText(join(out, file)).includes(project)),
      [],
    );
    assert.deepEqual(
      jsonAt(
        readJson(join(out, "tsconfig.json")),
        "compilerOptions",
        "rootDirs",
      ),
      ["..", "./vue-declarations"],
    );
  });
});

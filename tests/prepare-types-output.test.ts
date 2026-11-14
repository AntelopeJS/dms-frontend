import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { after, describe, it } from "node:test";
import { runPrepareTypes } from "../src/commands/prepare-types-action";
import { UsageError } from "../src/common";
import { listNames } from "./helpers/files";
import {
  assertOutsideSources,
  outputProblems,
  resetOutput,
  TYPES_MARKER,
} from "../src/prepare-types-output";

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
    const out = directory();
    resetOutput(out);
    writeFileSync(join(out, "tsconfig.json"), "{}\n");
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

void describe("resetOutput", () => {
  void it("empties a directory but for node_modules, and marks it", () => {
    const out = directory();
    mkdirSync(join(out, "node_modules", "vite"), { recursive: true });
    mkdirSync(join(out, "frontend-modules"));
    writeFileSync(join(out, "tsconfig.json"), "{}\n");
    resetOutput(out);
    assert.deepEqual(listNames(out).sort(), [TYPES_MARKER, "node_modules"]);
    assert.deepEqual(listNames(join(out, "node_modules")), ["vite"]);
  });
});

void describe("assertOutsideSources", () => {
  void it("refuses an output that holds a source tree", () => {
    const out = directory();
    const source = join(out, "module");
    assert.throws(
      () => assertOutsideSources(out, [{ id: "m", copy: "", source }]),
      /holds the sources/,
    );
    assert.doesNotThrow(() =>
      assertOutsideSources(join(source, ".types"), [
        { id: "m", copy: "", source },
      ]),
    );
  });
});

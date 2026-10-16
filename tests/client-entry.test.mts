import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import ts from "typescript";

const ENTRY = join("templates", "vue", "main.ts");

/** The `await`s of `source` outside any function: its top-level awaits. */
function topLevelAwaits(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node))
      return;
    const awaited =
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined);
    if (awaited) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(`${ENTRY}:${line + 1}: ${node.getText().split("\n")[0]}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("the client entry", () => {
  // Rollup never merges what an entry awaiting at its top level shares with
  // its dynamic imports, which every page and component is: the entry then
  // went out as a hundred one-module chunks, each its own request.
  it("does not await at its top level", () => {
    const source = ts.createSourceFile(
      ENTRY,
      readFileSync(ENTRY, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    assert.deepEqual(topLevelAwaits(source), []);
  });
});

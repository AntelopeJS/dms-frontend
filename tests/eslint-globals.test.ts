import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { autoImportedGlobals } from "../scripts/auto-imported-globals";
import eslintGlobals from "../templates/eslint-globals.mjs";

const REGENERATE =
  "run `pnpm eslint-globals` and commit templates/eslint-globals.mjs";

describe("the published ESLint globals", () => {
  it("declare every name the renderer auto-imports, and no other", async () => {
    const injected = await autoImportedGlobals();
    const missing = Object.keys(injected).filter(
      (name) => !Object.hasOwn(eslintGlobals, name),
    );
    const stale = Object.keys(eslintGlobals).filter(
      (name) => !Object.hasOwn(injected, name),
    );
    assert.deepEqual(
      missing,
      [],
      `auto-imported but not declared: ${REGENERATE}`,
    );
    assert.deepEqual(
      stale,
      [],
      `declared but no longer auto-imported: ${REGENERATE}`,
    );
  });
});

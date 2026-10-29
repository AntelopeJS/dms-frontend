import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import AutoImport from "unplugin-auto-import/vite";
import type { Plugin } from "vite";
import { normalizePath } from "vite";
import { dynamicImports } from "../scripts/source-checks/dynamic-imports";
import { isCallable, isText } from "./helpers/guards";

const WINDOWS_MODULE_PATH =
  "C:\\Users\\Mwesto\\.antelopejs\\dms-frontend\\a27ff4d5\\frontend-module.ts";

/**
 * Run the auto-importer over a file that uses one of the injected names and
 * return the specifier of the import it prepended, as the *parser* sees it —
 * escape sequences already applied. That last part is the whole point: the
 * bug is invisible in the emitted bytes and only appears once the generated
 * source is read back as JavaScript.
 */
async function injectedSpecifier(moduleKey: string): Promise<string> {
  const [plugin] = [
    AutoImport({
      dts: false,
      imports: [{ [moduleKey]: ["useDmsUserSession"] }],
    }),
  ].flat() as Plugin[];
  const transform = plugin.transform;
  const handler = isCallable(transform) ? transform : transform?.handler;
  assert.ok(handler, "the auto-importer exposes a transform hook");
  const result = await handler.call(
    { error: () => {}, warn: () => {} } as never,
    "const session = useDmsUserSession();",
    "/workspace/frontend-modules/dms__ai/app/plugins/ai.client.ts",
  );
  const code = isText(result) ? result : result?.code;
  const emitted = isText(code) ? code : String(code ?? "");
  const literal = emitted.match(/from\s+('[^']*'|"[^"]*")/)?.[1];
  assert.ok(literal, `no import was injected into:\n${emitted}`);
  return runInNewContext(literal) as string;
}

describe("Windows paths inlined into generated code", () => {
  it("mangles a native Windows path used as an auto-import key", async () => {
    const specifier = await injectedSpecifier(WINDOWS_MODULE_PATH);
    assert.notEqual(
      specifier,
      WINDOWS_MODULE_PATH,
      "the key is inlined verbatim into a quoted string, so its backslashes are read as escapes",
    );
    assert.match(specifier, /^C:UsersMwesto\.antelopejs/);
    assert.ok(specifier.endsWith("\frontend-module.ts"));
  });

  it("keeps the specifier intact once the key is normalized", async () => {
    const key = WINDOWS_MODULE_PATH.split("\\").join("/");
    const specifier = await injectedSpecifier(key);
    assert.equal(specifier, key);
    assert.doesNotMatch(specifier, /\\/);
  });

  it("leaves POSIX paths and globs untouched", () => {
    for (const path of [
      "/home/dev/.antelopejs/dms-frontend/a27ff4d5/frontend-module.ts",
      "/home/dev/workspace/frontend-modules/dms__ai/app/**/*.vue",
      "/home/dev/workspace/app/composables/**/*",
    ]) {
      assert.equal(normalizePath(path), path);
    }
  });
});

describe("Windows paths handed to import()", () => {
  it("refuses a native Windows path as a module specifier", async () => {
    assert.equal(new URL(WINDOWS_MODULE_PATH).protocol, "c:");
    await assert.rejects(import(WINDOWS_MODULE_PATH), {
      code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
    });
  });

  it("tells an import() call from the same text in a string", () => {
    const code = [
      "await import(rendererPath);",
      "import(url.href);",
      'import("vite");',
      "// import(commented)",
      "const line = `declare type Row = import(${source}).Row;`;",
    ].join("\n");
    assert.deepEqual(
      dynamicImports(code).map(({ argument, byUrl }) => [argument, byUrl]),
      [
        ["rendererPath", false],
        ["url.href", true],
        ['"vite"', true],
      ],
    );
  });
});

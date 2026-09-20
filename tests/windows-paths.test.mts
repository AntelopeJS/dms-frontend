// A path that leaves Node's filesystem APIs and becomes text — a module
// specifier, a glob, a CSS directive — has to be POSIX. These tests pin that
// down from a POSIX host: the failure is a property of the string, not of the
// platform running it, so a Windows-shaped path can be fed in deliberately.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import AutoImport from "unplugin-auto-import/vite";
import type { Plugin } from "vite";
import { normalizePath } from "vite";

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
    AutoImport({ dts: false, imports: [{ [moduleKey]: ["useUserSession"] }] }),
  ].flat() as Plugin[];
  const transform = plugin.transform;
  const handler =
    typeof transform === "function" ? transform : transform?.handler;
  assert.ok(handler, "the auto-importer exposes a transform hook");
  const result = await handler.call(
    { error: () => {}, warn: () => {} } as never,
    "const session = useUserSession();",
    "/workspace/frontend-modules/dms__ai/app/plugins/ai.client.ts",
  );
  const emitted = (typeof result === "string" ? result : result?.code) ?? "";
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
    // The exact shape of the reported resolution failure: the separators are
    // gone and `\f` has become a form feed in front of the filename.
    assert.match(specifier, /^C:UsersMwesto\.antelopejs/);
    assert.ok(specifier.endsWith("\frontend-module.ts"));
  });

  it("keeps the specifier intact once the key is normalized", async () => {
    const key = WINDOWS_MODULE_PATH.split("\\").join("/");
    const specifier = await injectedSpecifier(key);
    assert.equal(specifier, key);
    assert.doesNotMatch(specifier, /\\/);
  });

  it("normalizes both auto-import keys in the generated Vite configs", () => {
    assert.match(
      readFileSync(join("templates", "vue", "vite.config.ts"), "utf8"),
      /\[normalizePath\(resolve\(__dirname, "frontend-module\.ts"\)\)\]/,
    );
    assert.match(
      readFileSync(join("templates", "vue", "vite.email.config.ts"), "utf8"),
      /\[normalizePath\(resolve\(__dirname, "email-runtime\.ts"\)\)\]/,
    );
  });

  it("normalizes the glob patterns handed to the scanners", () => {
    const config = readFileSync(
      join("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    assert.match(config, /glob: normalizePath\(resolve\(root, glob\)\)/);
    assert.match(config, /\]\.map\(normalizePath\);/);
  });

  it("leaves POSIX paths and globs untouched", () => {
    // The whole fix is a no-op on Linux and macOS, and stays one.
    for (const path of [
      "/home/dev/.antelopejs/dms-frontend/a27ff4d5/frontend-module.ts",
      "/home/dev/workspace/frontend-modules/dms__ai/app/**/*.vue",
      "/home/dev/workspace/app/composables/**/*",
    ]) {
      assert.equal(normalizePath(path), path);
    }
  });
});

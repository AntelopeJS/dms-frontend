// A path that leaves Node's filesystem APIs and becomes text — a module
// specifier, a glob, a CSS directive — has to be POSIX. These tests pin that
// down from a POSIX host: the failure is a property of the string, not of the
// platform running it, so a Windows-shaped path can be fed in deliberately.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import AutoImport from "unplugin-auto-import/vite";
import type { Plugin } from "vite";
import { normalizePath, parseAst } from "vite";

const WINDOWS_MODULE_PATH =
  "C:\\Users\\Mwesto\\.antelopejs\\dms-frontend\\a27ff4d5\\frontend-module.ts";
const TEMPLATE = join(process.cwd(), "templates", "vue");

interface SyntaxNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

/**
 * The argument of every `import()` call in a module, read from its syntax
 * tree rather than its text: an `import(` inside a string or a template — the
 * type query a generator writes into a declaration file — is data, not a
 * call, and a comment is neither.
 */
function dynamicImportSpecifiers(code: string): SyntaxNode[] {
  const specifiers: SyntaxNode[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value === null || typeof value !== "object") return;
    const node = value as SyntaxNode;
    if (node.type === "ImportExpression")
      specifiers.push(node.source as SyntaxNode);
    for (const child of Object.values(node)) visit(child);
  };
  visit(parseAst(code));
  return specifiers;
}

// A string names a package; `.href` reads a `URL`. Anything else is a path
// computed at run time, which is a `C:\...` path on Windows.
function isUrlSpecifier(node: SyntaxNode): boolean {
  if (node.type === "Literal") return typeof node.value === "string";
  if (node.type === "TemplateLiteral")
    return (node.expressions as unknown[]).length === 0;
  return (
    node.type === "MemberExpression" &&
    node.computed === false &&
    (node.property as { name?: string }).name === "href"
  );
}

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
  const handler =
    typeof transform === "function" ? transform : transform?.handler;
  assert.ok(handler, "the auto-importer exposes a transform hook");
  const result = await handler.call(
    { error: () => {}, warn: () => {} } as never,
    "const session = useDmsUserSession();",
    "/workspace/frontend-modules/dms__ai/app/plugins/ai.client.ts",
  );
  // Vite 8 types `code` as a string or a Rolldown magic string.
  const code = typeof result === "string" ? result : result?.code;
  const emitted = typeof code === "string" ? code : String(code ?? "");
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
      /\[normalizePath\(resolve\(import\.meta\.dirname, "frontend-module\.ts"\)\)\]/,
    );
    assert.match(
      readFileSync(join("templates", "vue", "vite.email.config.ts"), "utf8"),
      /\[normalizePath\(resolve\(import\.meta\.dirname, "email-runtime\.ts"\)\)\]/,
    );
  });

  it("normalizes the glob patterns handed to the scanners", () => {
    const config = readFileSync(
      join("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    assert.match(config, /\]\.map\(normalizePath\);/);
    assert.match(
      readFileSync(
        join("templates", "vue", "frontend-build-loader.ts"),
        "utf8",
      ),
      /normalizePath\(resolve\(root, pattern\)\)/,
    );
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

describe("Windows paths handed to import()", () => {
  // Node reads `C:\...` as a URL whose scheme is `c:` and refuses it with
  // ERR_UNSUPPORTED_ESM_URL_SCHEME: every production render of `server.mjs`
  // then fell back to client rendering. A POSIX path imports fine, so the
  // check reads the template's Node.js sources.
  it("refuses a native Windows path as a module specifier", async () => {
    assert.equal(new URL(WINDOWS_MODULE_PATH).protocol, "c:");
    await assert.rejects(import(WINDOWS_MODULE_PATH), {
      code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
    });
  });

  it("loads every module of the template's Node.js side by URL", () => {
    const specifiers = readdirSync(TEMPLATE, {
      recursive: true,
      encoding: "utf8",
    })
      .filter((file) => file.endsWith(".mjs"))
      .flatMap((file) => {
        const code = readFileSync(join(TEMPLATE, file), "utf8");
        return dynamicImportSpecifiers(code).map((node) => ({
          file,
          specifier: code.slice(node.start, node.end),
          byUrl: isUrlSpecifier(node),
        }));
      });
    assert.ok(specifiers.some(({ file }) => file === "server.mjs"));
    // The unimport the SFC type declarations are scanned with is resolved to
    // a path: loading it is the same failure as the built renderer's.
    assert.ok(specifiers.some(({ file }) => file === "sfc-global-types.mjs"));
    assert.deepEqual(
      specifiers.filter(({ byUrl }) => !byUrl),
      [],
    );
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
      dynamicImportSpecifiers(code).map((node) => [
        code.slice(node.start, node.end),
        isUrlSpecifier(node),
      ]),
      [
        ["rendererPath", false],
        ["url.href", true],
        ['"vite"', true],
      ],
    );
  });
});

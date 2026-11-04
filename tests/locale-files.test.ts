import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readLocaleFile } from "../src/locale-files";
import {
  InvalidLocaleFileError,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
} from "../src/common";

type LocaleMessages = { [key: string]: string | LocaleMessages };

/**
 * A message vue-i18n cannot compile stops the generation of the catalogs,
 * which the build and the dev server's start both run first: it never reaches a page.
 */
describe("locale messages vue-i18n cannot compile", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-locale-files-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  function materializeWith(messages: LocaleMessages): Error | undefined {
    const source = mkdtempSync(join(root, "source-"));
    const workspace = mkdtempSync(join(root, "workspace-"));
    const locales = join(source, "i18n", "locales");
    mkdirSync(locales, { recursive: true });
    writeFileSync(
      join(source, "package.json"),
      JSON.stringify({ name: "@fixture/app" }),
    );
    writeFileSync(join(locales, "app-en-GB.json"), JSON.stringify(messages));
    const layer: ResolvedLayer = { path: source, packageName: "@fixture/app" };
    try {
      materializeLayers(workspace, [layer]);
      writeFrontendModuleRegistry(workspace, [layer]);
    } catch (error) {
      assert.ok(error instanceof Error, "materializing threw a non-error");
      return error;
    }
    return undefined;
  }

  it("names the file, the key and the escaped message to write", () => {
    const error = materializeWith({
      auth: {
        email: { placeholder: "first.last@example.com" },
        greeting: "Hello {name}",
      },
      broken: "{ unclosed",
    });
    assert.ok(error instanceof InvalidLocaleFileError, String(error));
    assert.match(error.path, /app-en-GB\.json$/);
    const lines = error.reason.split("\n");
    assert.equal(lines[0], "2 message(s) vue-i18n cannot compile:");
    assert.match(lines[1], /^auth\.email\.placeholder: /);
    assert.ok(
      lines[1].endsWith(
        `Write a literal @ as {'@'}: "first.last{'@'}example.com".`,
      ),
      lines[1],
    );
    assert.match(lines[2], /^broken: .*Write a literal \{ as \{'\{'\}: /);
  });

  it("accepts what vue-i18n compiles: placeholders, plurals, links, escapes", () => {
    assert.equal(
      materializeWith({
        count: "no item | one item | {n} items",
        linked: "@:count",
        escaped: "first.last{'@'}example.com",
        percent: "100%",
      }),
      undefined,
    );
  });
});

/**
 * A catalog is a JSON object of messages: a file holding any other JSON value
 * would have its characters or elements spread into the catalog as messages.
 */
describe("a locale file that is not a JSON object", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-locale-file-kind-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  function locale(json: string): string {
    const path = join(mkdtempSync(join(root, "locale-")), "en-US.json");
    writeFileSync(path, json);
    return path;
  }

  for (const json of ['"abc"', "[1,2]", "5", "null", "true"]) {
    it(`is refused as an invalid locale file: ${json}`, () => {
      const path = locale(json);
      assert.throws(() => readLocaleFile(path), {
        name: "InvalidLocaleFileError",
        message: `Invalid locale file ${path}: a locale file must hold a JSON object of messages`,
      });
    });
  }

  it("is read as before when it holds an object", () => {
    assert.deepEqual(
      readLocaleFile(locale('{"greeting":"Hello {name}","nested":{"a":"b"}}')),
      { greeting: "Hello {name}", nested: { a: "b" } },
    );
    assert.deepEqual(readLocaleFile(locale("{}")), {});
  });
});

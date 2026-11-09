import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { readLocaleFile } from "../src/locale-files";
import { problemText } from "./fixtures/memory-ui";
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
    assert.equal(error.reason, "2 message(s) vue-i18n cannot compile:");
    const [placeholder, broken, ...rest] = error.details;
    assert.match(placeholder, /^auth\.email\.placeholder: /);
    assert.ok(
      placeholder.endsWith(
        `Write a literal @ as {'@'}: "first.last{'@'}example.com".`,
      ),
      placeholder,
    );
    assert.match(broken, /^broken: .*Write a literal \{ as \{'\{'\}: /);
    assert.deepEqual(rest, []);
  });

  it("prints the key and the message to write without --verbose", () => {
    const error = materializeWith({
      auth: { email: { placeholder: "first.last@example.com" } },
    });
    assert.ok(error instanceof CliError, String(error));
    assert.ok(error instanceof InvalidLocaleFileError, String(error));
    assert.equal(
      problemText(error),
      [
        `✖ Invalid locale file ${error.path}: 1 message(s) vue-i18n cannot compile:`,
        `  auth.email.placeholder: Invalid linked format in "first.last@example.com". Write a literal @ as {'@'}: "first.last{'@'}example.com".`,
        "",
      ].join("\n"),
    );
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

  it("is named on one line when its JSON does not parse", () => {
    const path = locale("abc\ndef");
    assert.throws(
      () => readLocaleFile(path),
      (error) => {
        assert.ok(error instanceof InvalidLocaleFileError, String(error));
        assert.equal(
          problemText(error),
          `✖ Invalid locale file ${path}: Unexpected token 'a', "abc\\ndef" is not valid JSON\n`,
        );
        return true;
      },
    );
  });

  it("is read as before when it holds an object", () => {
    assert.deepEqual(
      readLocaleFile(locale('{"greeting":"Hello {name}","nested":{"a":"b"}}')),
      { greeting: "Hello {name}", nested: { a: "b" } },
    );
    assert.deepEqual(readLocaleFile(locale("{}")), {});
  });
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { materializeLayers, writeFrontendModuleRegistry } from "../src/common";
import { isObjectLike } from "../src/internal/guards";
import { listNames, readBytes, readText } from "./helpers/files";
import { isText } from "./helpers/guards";
import { copyEmailRendererFiles } from "./helpers/templates";

interface LocaleMessages {
  [key: string]: string | LocaleMessages;
}

function isLocaleMessages(value: unknown): value is LocaleMessages {
  return (
    isObjectLike(value) &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => isText(entry) || isLocaleMessages(entry),
    )
  );
}

function isBuiltManifest(
  value: unknown,
): value is Record<string, { file: string }> {
  return (
    isObjectLike(value) &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) => isObjectLike(entry) && "file" in entry && isText(entry.file),
    )
  );
}

it("keeps large locale catalogs out of email code without pruning dynamic translations", async (context) => {
  const workspace = mkdtempSync(resolve(".email-locales-"));
  try {
    const layers = ["base", "override", "unrelated"].map((name, index) => {
      const path = join(workspace, "sources", name);
      mkdirSync(join(path, "i18n/locales"), { recursive: true });
      writeFileSync(
        join(path, "package.json"),
        JSON.stringify({ name: `@fixture/${name}`, type: "module" }),
      );
      return { path, packageName: `@fixture/${name}`, priority: index };
    });
    const writeLocale = (
      index: number,
      locale: string,
      value: LocaleMessages,
    ) =>
      writeFileSync(
        join(
          layers[index].path,
          "i18n/locales",
          `${index === 1 ? "fixture-" : ""}${locale}.json`,
        ),
        JSON.stringify(value),
      );
    writeLocale(0, "en-GB", {
      subject: "Base English",
      fallback: "English fallback",
      dynamic: { chosen: "Dynamic English" },
    });
    writeLocale(0, "fr-FR", {
      subject: "Base French",
      dynamic: { chosen: "Dynamic French" },
    });
    writeLocale(1, "en-GB", {
      subject: "Override English",
      dynamic: { chosen: "Lower priority English" },
    });
    writeLocale(1, "fr-FR", {
      subject: "Override French",
      dynamic: { chosen: "Lower priority French" },
    });
    const unrelated = Object.fromEntries(
      Array.from({ length: 3000 }, (_, index) => [
        `key${index}`,
        `UNRELATED_APPLICATION_TRANSLATION_${index}_${"x".repeat(100)}`,
      ]),
    );
    writeLocale(2, "en-GB", {
      unrelated,
      arbitrary: "Arbitrary English",
      dynamic: { chosen: "Dynamic English" },
    });
    writeLocale(2, "fr-FR", {
      unrelated,
      arbitrary: "Arbitrary French",
      dynamic: { chosen: "Dynamic French" },
    });
    writeLocale(2, "de-DE", { arbitrary: "Arbitrary German" });
    writeLocale(2, "it-IT", { arbitrary: "Arbitrary Italian" });
    writeLocale(2, "nl-NL", { arbitrary: "Arbitrary Dutch" });
    writeFileSync(
      join(layers[0].path, "dms.email.ts"),
      'export const serverEmailTemplates = import.meta.glob("./EmailFixture.vue");',
    );
    writeFileSync(
      join(layers[0].path, "EmailFixture.vue"),
      `<script setup lang="ts">
import { useI18n } from "vue-i18n";
defineProps<{ translationKey: string }>();
const { t } = useI18n();
</script>
<template><EContainer style="padding:20px 0"><ESection><p>{{ t('subject') }}|{{ t('fallback') }}|{{ t(translationKey) }}</p></ESection></EContainer></template>`,
    );
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    materializeLayers(workspace, layers);
    writeFrontendModuleRegistry(workspace, layers);
    for (const [locale, subject, dynamic] of [
      ["en", "Override English", "Dynamic English"],
      ["fr", "Override French", "Dynamic French"],
    ]) {
      const loaded: unknown = await import(
        pathToFileURL(join(workspace, "locales.generated", `${locale}.ts`)).href
      );
      assert.ok(
        isObjectLike(loaded) &&
          "default" in loaded &&
          isLocaleMessages(loaded.default),
        `the ${locale} messages are a catalog`,
      );
      const browserMessages = loaded.default;
      assert.equal(browserMessages.subject, subject);
      assert.ok(isLocaleMessages(browserMessages.dynamic));
      assert.equal(browserMessages.dynamic.chosen, dynamic);
      assert.equal(browserMessages.fallback, "English fallback");
      const { fallback, ...own } = browserMessages;
      assert.deepEqual(
        JSON.parse(
          readText(join(workspace, "locales.generated", `${locale}.json`)),
        ),
        locale === "en" ? { ...own, fallback } : own,
      );
    }
    copyEmailRendererFiles(workspace);
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "vite.email.config.ts",
        "--logLevel",
        "error",
      ],
      { cwd: workspace, stdio: "pipe" },
    );
    const output = join(workspace, "deployed");
    cpSync(join(workspace, "dist/server"), output, { recursive: true });
    rmSync(join(workspace, "dist"), { recursive: true });
    rmSync(join(workspace, "locales.generated"), { recursive: true });
    const manifest: unknown = JSON.parse(
      readText(join(output, ".vite/manifest.json")),
    );
    assert.ok(isBuiltManifest(manifest), "the build manifest lists files");
    const javascript = [
      ...new Set(Object.values(manifest).map((entry) => entry.file)),
    ]
      .filter((file) => file.endsWith(".js"))
      .map((file) => readText(join(output, file)))
      .join("\n");
    assert.ok(
      Buffer.byteLength(javascript) < 262144,
      `Email code grew to ${Buffer.byteLength(javascript)} bytes with unrelated translations`,
    );
    assert.doesNotMatch(javascript, /UNRELATED_APPLICATION_TRANSLATION/);
    const dataBytes = listNames(join(output, "locales")).reduce(
      (total, file) =>
        total + readBytes(join(output, "locales", file)).byteLength,
      0,
    );
    assert.ok(
      dataBytes > 900000,
      "Complete catalogs must remain available as deployment data",
    );
    context.diagnostic(
      `Email JavaScript: ${Buffer.byteLength(javascript)} bytes; complete locale data: ${dataBytes} bytes`,
    );
    const germanPath = join(output, "locales/de.json");
    const german = readBytes(germanPath);
    writeFileSync(
      germanPath,
      "invalid JSON: must not be read by an English or French render",
    );
    const { renderEmail } = await import(
      pathToFileURL(join(output, "email-renderer.js")).href
    );
    const render = async (
      translationKey: string,
      locale?: string,
    ): Promise<string> => {
      const html: unknown = await renderEmail(
        "EmailFixture",
        { translationKey },
        locale === undefined ? undefined : { locale },
      );
      assert.ok(isText(html), "the email renders to text");
      return html;
    };
    const layout = await render("arbitrary");
    assert.match(
      layout,
      /<table[^>]*align="center"[^>]*width="100%"[^>]*style="max-width:37\.5em;padding:20px 0;"[^>]*><tbody><tr[^>]*><td><table/,
    );
    assert.match(
      await render("dynamic.chosen", "fr-FR"),
      /Override French\|English fallback\|Dynamic French/,
    );
    assert.match(
      await render("arbitrary", "en"),
      /Override English\|English fallback\|Arbitrary English/,
    );
    writeFileSync(germanPath, german);
    assert.match(
      await render("arbitrary", "de"),
      /Override English\|English fallback\|Arbitrary German/,
    );
    assert.match(
      await render("arbitrary", "es"),
      /Override English\|English fallback\|Arbitrary English/,
    );
    assert.match(
      await render("unrelated.key2999", "fr"),
      /UNRELATED_APPLICATION_TRANSLATION_2999/,
    );
    writeFileSync(join(output, "locales/it.json"), "invalid JSON");
    await assert.rejects(() => render("arbitrary", "it"), SyntaxError);
    rmSync(join(output, "locales/nl.json"));
    await assert.rejects(() => render("arbitrary", "nl"), { code: "ENOENT" });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

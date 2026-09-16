import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { materializeLayers, writeFrontendModuleRegistry } from "../src/common";

type LocaleMessages = Record<string, unknown>;

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
      const { default: browserMessages } = await import(
        pathToFileURL(join(workspace, "locales.generated", `${locale}.ts`)).href
      );
      assert.equal(browserMessages.subject, subject);
      assert.equal(browserMessages.dynamic.chosen, dynamic);
      if (locale === "en")
        assert.equal(browserMessages.fallback, "English fallback");
      assert.deepEqual(
        JSON.parse(
          readFileSync(
            join(workspace, "locales.generated", `${locale}.json`),
            "utf8",
          ),
        ),
        browserMessages,
      );
    }
    for (const file of readdirSync("templates/vue").filter(
      (name) => name.startsWith("email-") || name === "vite.email.config.ts",
    )) {
      cpSync(join("templates/vue", file), join(workspace, file));
    }
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
    const manifest = JSON.parse(
      readFileSync(join(output, ".vite/manifest.json"), "utf8"),
    ) as Record<string, { file: string }>;
    const javascript = [
      ...new Set(Object.values(manifest).map((entry) => entry.file)),
    ]
      .filter((file) => file.endsWith(".js"))
      .map((file) => readFileSync(join(output, file), "utf8"))
      .join("\n");
    assert.ok(
      Buffer.byteLength(javascript) < 262144,
      `Email code grew to ${Buffer.byteLength(javascript)} bytes with unrelated translations`,
    );
    assert.doesNotMatch(javascript, /UNRELATED_APPLICATION_TRANSLATION/);
    const dataBytes = readdirSync(join(output, "locales")).reduce(
      (total, file) =>
        total + readFileSync(join(output, "locales", file)).byteLength,
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
    const german = readFileSync(germanPath);
    writeFileSync(
      germanPath,
      "invalid JSON: must not be read by an English or French render",
    );
    const { renderEmail } = await import(
      pathToFileURL(join(output, "email-renderer.js")).href
    );
    const layout = await renderEmail("EmailFixture", {
      translationKey: "arbitrary",
    });
    assert.match(
      layout,
      /<table[^>]*align="center"[^>]*width="100%"[^>]*style="max-width:37\.5em;padding:20px 0;"[^>]*><tbody><tr[^>]*><td><table/,
    );
    assert.match(
      await renderEmail(
        "EmailFixture",
        { translationKey: "dynamic.chosen" },
        { locale: "fr-FR" },
      ),
      /Override French\|English fallback\|Dynamic French/,
    );
    assert.match(
      await renderEmail(
        "EmailFixture",
        { translationKey: "arbitrary" },
        { locale: "en" },
      ),
      /Override English\|English fallback\|Arbitrary English/,
    );
    writeFileSync(germanPath, german);
    assert.match(
      await renderEmail(
        "EmailFixture",
        { translationKey: "arbitrary" },
        { locale: "de" },
      ),
      /Override English\|English fallback\|Arbitrary German/,
    );
    assert.match(
      await renderEmail(
        "EmailFixture",
        { translationKey: "arbitrary" },
        { locale: "es" },
      ),
      /Override English\|English fallback\|Arbitrary English/,
    );
    assert.match(
      await renderEmail(
        "EmailFixture",
        { translationKey: "unrelated.key2999" },
        { locale: "fr" },
      ),
      /UNRELATED_APPLICATION_TRANSLATION_2999/,
    );
    writeFileSync(join(output, "locales/it.json"), "invalid JSON");
    await assert.rejects(
      () =>
        renderEmail(
          "EmailFixture",
          { translationKey: "arbitrary" },
          { locale: "it" },
        ),
      SyntaxError,
    );
    rmSync(join(output, "locales/nl.json"));
    await assert.rejects(
      () =>
        renderEmail(
          "EmailFixture",
          { translationKey: "arbitrary" },
          { locale: "nl" },
        ),
      { code: "ENOENT" },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

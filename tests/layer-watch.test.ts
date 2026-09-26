import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import {
  affectsLocaleMessages,
  materializeLayers,
  type ResolvedLayer,
  startLayerWatchers,
  writeFrontendModuleRegistry,
} from "../src/common";

const RETRY_WRITE_MS = 1_000;
const TIMEOUT_MS = 15_000;

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Wait until `done` holds, repeating `act` meanwhile: a change made before the
 * watcher has finished its initial scan is not reported, so the first write
 * alone could be lost.
 */
async function eventually(act: () => void, done: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastAct = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastAct >= RETRY_WRITE_MS) {
      act();
      lastAct = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (done()) return;
  }
  assert.fail("the watcher did not apply the change in time");
}

describe("locale catalogs in the dev layer watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-layer-watch-"));
  const workspace = join(root, "workspace");
  const base = join(root, "sources", "base");
  const app = join(root, "sources", "app");
  const baseLocales = join(base, "layers", "ui", "i18n", "locales");
  const generated = join(workspace, "locales.generated");
  const layers: ResolvedLayer[] = [
    { path: base, packageName: "@fixture/base", priority: 1 },
    { path: app, packageName: "@fixture/app", priority: 10 },
  ];
  let stopWatchers: () => Promise<void> = async () => {};

  const catalog = (locale: string): Record<string, any> =>
    JSON.parse(readFileSync(join(generated, `${locale}.json`), "utf8"));
  const emailLocales = (): string[] =>
    JSON.parse(
      readFileSync(join(workspace, "email-locales.generated.json"), "utf8"),
    );
  const mtime = (path: string): number => statSync(path).mtimeMs;

  before(() => {
    writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "@fixture/base" }),
    );
    writeFile(
      join(base, "layers", "ui", "app", "components", "Form.vue"),
      "<template><form /></template>\n",
    );
    writeFile(
      join(baseLocales, "ui-en-GB.json"),
      JSON.stringify({ form: { title: "Form", owner: "base" } }),
    );
    writeFile(
      join(baseLocales, "ui-fr-FR.json"),
      JSON.stringify({ form: { title: "Formulaire" } }),
    );
    writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "@fixture/app" }),
    );
    writeFile(
      join(app, "i18n", "locales", "app-en-GB.json"),
      JSON.stringify({ form: { owner: "app" } }),
    );
    mkdirSync(workspace, { recursive: true });
    materializeLayers(workspace, layers);
    writeFrontendModuleRegistry(workspace, layers);
    stopWatchers = startLayerWatchers(workspace, layers);
  });

  after(async () => {
    await stopWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  it("regenerates the merged catalogs when a layer adds a key", async () => {
    assert.deepEqual(catalog("en").form, {
      title: "Form",
      owner: "app",
    });
    await eventually(
      () =>
        writeFileSync(
          join(baseLocales, "ui-en-GB.json"),
          JSON.stringify({
            form: { title: "Form", owner: "base", demo_key: "Hello" },
          }),
        ),
      () => catalog("en").form.demo_key === "Hello",
    );
    // The higher-priority module still wins, as at materialization.
    assert.equal(catalog("en").form.owner, "app");
    assert.match(
      readFileSync(join(generated, "en.ts"), "utf8"),
      /"demo_key":"Hello"/,
    );
    assert.deepEqual(emailLocales(), ["en", "fr"]);
  });

  it("rewrites only the files whose content changed", async () => {
    const untouched = [
      join(generated, "en.json"),
      join(generated, "en.ts"),
      join(workspace, "locales.generated.ts"),
      join(workspace, "email-locales.generated.json"),
    ];
    const before = untouched.map(mtime);
    await eventually(
      () => {
        // Same English messages, laid out differently, in the same pass as a
        // French change.
        writeFileSync(
          join(baseLocales, "ui-en-GB.json"),
          JSON.stringify(
            { form: { title: "Form", owner: "base", demo_key: "Hello" } },
            null,
            2,
          ),
        );
        writeFileSync(
          join(baseLocales, "ui-fr-FR.json"),
          JSON.stringify({ form: { title: "Formulaire modifié" } }),
        );
      },
      () => catalog("fr").form.title === "Formulaire modifié",
    );
    assert.deepEqual(untouched.map(mtime), before);
  });

  it("adds and removes a locale", async () => {
    const german = join(baseLocales, "ui-de-DE.json");
    await eventually(
      () =>
        writeFileSync(german, JSON.stringify({ form: { title: "Formular" } })),
      () => existsSync(join(generated, "de.json")),
    );
    assert.equal(catalog("de").form.title, "Formular");
    assert.ok(existsSync(join(generated, "de.ts")));
    assert.deepEqual(emailLocales().sort(), ["de", "en", "fr"]);
    assert.match(
      readFileSync(join(workspace, "locales.generated.ts"), "utf8"),
      /"de": \(\) => import\("\.\/locales\.generated\/de"\)/,
    );

    await eventually(
      () => rmSync(german, { force: true }),
      () => !existsSync(join(generated, "de.json")),
    );
    assert.ok(!existsSync(join(generated, "de.ts")));
    assert.deepEqual(emailLocales(), ["en", "fr"]);
    assert.doesNotMatch(
      readFileSync(join(workspace, "locales.generated.ts"), "utf8"),
      /locales\.generated\/de/,
    );
  });

  it("keeps the previous catalogs while a locale file does not parse", async () => {
    const warn = mock.method(console, "warn", () => {});
    try {
      await eventually(
        () => writeFileSync(join(baseLocales, "ui-en-GB.json"), '{ "form": {'),
        () =>
          warn.mock.calls.some((call) =>
            String(call.arguments[0]).includes(
              "locale catalogs not regenerated",
            ),
          ),
      );
      const failure = warn.mock.calls.find((call) =>
        String(call.arguments[0]).includes("locale catalogs not regenerated"),
      );
      assert.match(String(failure?.arguments[1]), /ui-en-GB\.json/);
      assert.equal(catalog("en").form.demo_key, "Hello");
    } finally {
      warn.mock.restore();
    }
    await eventually(
      () =>
        writeFileSync(
          join(baseLocales, "ui-en-GB.json"),
          JSON.stringify({ form: { title: "Form", demo_key: "Fixed" } }),
        ),
      () => catalog("en").form.demo_key === "Fixed",
    );
  });

  it("leaves the catalogs alone when a change is not a locale file", async () => {
    // A regeneration would put the catalog back: its absence shows none ran.
    writeFileSync(join(generated, "en.json"), '{"form":{"marker":true}}');
    const component = join(
      base,
      "layers",
      "ui",
      "app",
      "components",
      "Form.vue",
    );
    const mirrored = join(
      workspace,
      "frontend-modules",
      "fixture__base",
      "layers",
      "ui",
      "app",
      "components",
      "Form.vue",
    );
    await eventually(
      () =>
        writeFileSync(component, "<template><form novalidate /></template>\n"),
      () => readFileSync(mirrored, "utf8").includes("novalidate"),
    );
    assert.deepEqual(catalog("en"), { form: { marker: true } });
  });
});

describe("affectsLocaleMessages", () => {
  it("matches the locale directories of a module and of its layers", () => {
    for (const path of [
      "i18n/locales/app-en-GB.json",
      "i18n/locales",
      "i18n",
      "layers/ui/i18n/locales/ui-en-GB.json",
      "layers/ui/i18n/locales/nested/extra-fr-FR.json",
      "layers/ui/i18n",
      "layers/ui",
      "layers",
    ])
      assert.equal(affectsLocaleMessages(path), true, path);
    for (const path of [
      "app/components/Form.vue",
      "layers/ui/app/components/Form.vue",
      "layers/ui/public/i18n/locales/en-GB.json",
      "i18n/messages/en-GB.json",
      "package.json",
    ])
      assert.equal(affectsLocaleMessages(path), false, path);
  });
});

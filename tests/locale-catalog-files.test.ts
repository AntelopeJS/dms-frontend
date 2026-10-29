import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  createFrontendModuleRegistry,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
  writeLocaleMessages,
} from "../src/common";
import { clientCodeSplitting } from "../templates/vue/client-chunking.mjs";
import { readText } from "./helpers/files";

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Markers only one catalog carries, to find where each one ends up. */
const ENGLISH = {
  greeting: "Hello",
  only_english: "english-only-marker",
  error: { network: { title: "Offline" } },
};
const FRENCH = { greeting: "Bonjour-french-marker" };

/**
 * The catalogs the application loads: every module's messages, which weigh
 * hundreds of kilobytes once all the modules of an application are merged,
 * against the few dozen messages a page shows.
 */
describe("generated locale catalogs", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dms-locale-files-")));
  const workspace = join(root, "workspace");
  const layer: ResolvedLayer = {
    path: join(root, "source"),
    packageName: "@fixture/app",
  };

  before(() => {
    write(
      join(layer.path, "package.json"),
      JSON.stringify({ name: layer.packageName }),
    );
    write(
      join(layer.path, "i18n", "locales", "app-en-GB.json"),
      JSON.stringify(ENGLISH),
    );
    write(
      join(layer.path, "i18n", "locales", "app-fr-FR.json"),
      JSON.stringify(FRENCH),
    );
    mkdirSync(workspace);
    materializeLayers(workspace, [layer]);
    writeFrontendModuleRegistry(workspace, [layer]);
    writeLocaleMessages(
      workspace,
      createFrontendModuleRegistry(workspace, [layer]),
    );
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("completes each locale's catalog with the English messages it lacks", async () => {
    const french = await import(
      pathToFileURL(join(workspace, "locales.generated", "fr.ts")).href
    );
    assert.deepEqual(french.default, {
      greeting: FRENCH.greeting,
      only_english: ENGLISH.only_english,
    });
    assert.deepEqual(
      JSON.parse(readText(join(workspace, "locales.generated", "fr.json"))),
      FRENCH,
    );
  });

  it("keeps the renderer's own French over a module's English-only wording", async () => {
    const french = await import(
      pathToFileURL(join(workspace, "locales.generated", "fr.ts")).href
    );
    const { createI18n } = await import("vue-i18n");
    const { showNetworkErrors } =
      await import("../templates/vue/network-error.ts");
    const i18n = createI18n({
      legacy: false,
      locale: "fr",
      fallbackLocale: "en",
      messages: { fr: french.default },
    });
    const globals = globalThis as Record<string, unknown>;
    globals.window = globalThis;
    globals.document = new EventTarget();
    const titles: string[] = [];
    const removeListener = showNetworkErrors(
      (toast) => titles.push(toast.title),
      i18n.global,
    );
    try {
      (globals.document as EventTarget).dispatchEvent(
        new CustomEvent("inertia:networkError", { cancelable: true }),
      );
    } finally {
      removeListener();
      delete globals.window;
      delete globals.document;
    }
    assert.deepEqual(titles, ["Connexion perdue"]);
  });

  it("keeps every catalog out of the client entry, one file per locale", async () => {
    write(
      join(workspace, "main.ts"),
      'import { loadLocaleMessages } from "./locales.generated";\n' +
        "void loadLocaleMessages(navigator.language).then(console.log);\n",
    );
    const outDir = join(workspace, "dist");
    const { build } = await import("vite");
    await build({
      root: workspace,
      configFile: false,
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        manifest: true,
        minify: false,
        rolldownOptions: {
          input: join(workspace, "main.ts"),
          // @ts-expect-error `codeSplitting` is typed as a boolean here
          output: { codeSplitting: clientCodeSplitting },
        },
      },
    });
    const manifest = JSON.parse(
      readText(join(outDir, ".vite", "manifest.json")),
    ) as Record<string, ManifestChunk>;
    const entry = Object.values(manifest).find((chunk) => chunk.isEntry);
    assert.ok(entry, "the build has an entry");
    const loadedFirst = [
      entry,
      ...(entry.imports ?? []).map((key) => manifest[key]!),
    ]
      .map((chunk) => readText(join(outDir, chunk.file)))
      .join("\n");
    assert.doesNotMatch(loadedFirst, /english-only-marker/);
    assert.doesNotMatch(loadedFirst, /Bonjour-french-marker/);
    for (const locale of ["en", "fr"]) {
      const chunk = manifest[`locales.generated/${locale}.ts`];
      assert.ok(chunk?.isDynamicEntry, `${locale} is a file of its own`);
    }
  });
});

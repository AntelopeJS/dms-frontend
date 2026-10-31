import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ViteDevServer } from "vite";
import {
  createFrontendModuleRegistry,
  getLayerWorkspacePath,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
  writeLocaleMessages,
} from "../src/common";

type Messages = Record<string, string>;

interface LocaleCatalogs {
  localeMessages: Record<string, Messages>;
  loadLocaleMessages(locale: string): Promise<Messages>;
  syncLocaleMessages(target: {
    setLocaleMessage(locale: string, messages: Messages): void;
  }): void;
}

const TIMEOUT_MS = 15_000;

async function eventually(done: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("the dev server did not pick the regenerated catalogs up");
}

/**
 * The generated locale module in a real Vite dev server, as `ajs-dms dev`
 * runs it: the browser side is played by a module runner with HMR, which
 * applies updates with the same client the browser uses, and the server side
 * by `ssrLoadModule`, which is how the generated server renders pages.
 */
describe("regenerated locale catalogs in the dev server", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dms-locale-hmr-")));
  const workspace = join(root, "workspace");
  const layer: ResolvedLayer = {
    path: join(root, "source"),
    packageName: "@fixture/app",
  };
  const copy = join(getLayerWorkspacePath(workspace, layer), "i18n", "locales");
  let server: ViteDevServer;

  const regenerate = async (
    catalogs: Record<string, Messages>,
  ): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [locale, messages] of Object.entries(catalogs))
      writeFileSync(join(copy, `app-${locale}.json`), JSON.stringify(messages));
    writeLocaleMessages(
      workspace,
      createFrontendModuleRegistry(workspace, [layer]),
    );
  };

  before(async () => {
    mkdirSync(join(layer.path, "i18n", "locales"), { recursive: true });
    writeFileSync(
      join(layer.path, "package.json"),
      JSON.stringify({ name: layer.packageName }),
    );
    writeFileSync(
      join(layer.path, "i18n", "locales", "app-en-GB.json"),
      JSON.stringify({ greeting: "Hello" }),
    );
    writeFileSync(
      join(layer.path, "i18n", "locales", "app-fr-FR.json"),
      JSON.stringify({ greeting: "Bonjour" }),
    );
    mkdirSync(workspace);
    materializeLayers(workspace, [layer]);
    writeFrontendModuleRegistry(workspace, [layer]);
    writeFileSync(
      join(workspace, "server-entry.ts"),
      'import { loadLocaleMessages } from "./locales.generated";\nexport async function greeting(locale: string) {\n  return (await loadLocaleMessages(locale)).greeting;\n}\n',
    );
    const { createServer } = await import("vite");
    server = await createServer({
      root: workspace,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: true, ws: false },
    });
  });

  after(async () => {
    await server?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serves the regenerated catalogs to the next server render", async () => {
    const render = async (locale: string) =>
      (await server.ssrLoadModule("/server-entry.ts")).greeting(locale);
    assert.equal(await render("en"), "Hello");
    assert.equal(await render("fr"), "Bonjour");
    await regenerate({ "en-GB": { greeting: "Hello from the server" } });
    await eventually(
      async () => (await render("en")) === "Hello from the server",
    );
    await regenerate({ "fr-FR": { greeting: "Bonjour du serveur" } });
    await eventually(async () => (await render("fr")) === "Bonjour du serveur");
  });

  it("applies each regenerated catalog to the running app in place", async () => {
    const { createServerModuleRunner } = await import("vite");
    const runner = createServerModuleRunner(server.environments.ssr, {
      hmr: { logger: false },
    });
    try {
      const catalogs: LocaleCatalogs = await runner.import(
        "/locales.generated.ts",
      );
      const applied: Record<string, Messages> = {};
      catalogs.syncLocaleMessages({
        setLocaleMessage: (locale, messages) => {
          applied[locale] = messages;
        },
      });
      await catalogs.loadLocaleMessages("en");
      await catalogs.loadLocaleMessages("fr");

      await regenerate({
        "en-GB": { greeting: "Hello again" },
        "fr-FR": { greeting: "Bonjour encore" },
      });
      await eventually(
        () =>
          applied.en?.greeting === "Hello again" &&
          applied.fr?.greeting === "Bonjour encore",
      );
      assert.equal(catalogs.localeMessages.en.greeting, "Hello again");
      assert.equal(
        (await catalogs.loadLocaleMessages("fr")).greeting,
        "Bonjour encore",
      );

      await regenerate({ "en-GB": { greeting: "Hello a third time" } });
      await eventually(() => applied.en?.greeting === "Hello a third time");
      assert.equal(catalogs.localeMessages.en.greeting, "Hello a third time");

      await regenerate({
        "en-GB": { greeting: "Hello a third time", farewell: "Goodbye" },
      });
      await eventually(() => applied.fr?.farewell === "Goodbye");
      assert.equal(applied.fr?.greeting, "Bonjour encore");
    } finally {
      await runner.close();
    }
  });

  it("asks for a full reload when a locale appears", async () => {
    const { createServerModuleRunner } = await import("vite");
    const runner = createServerModuleRunner(server.environments.ssr, {
      hmr: { logger: false },
    });
    const invalidated: string[] = [];
    server.environments.ssr.hot.on("vite:invalidate", (payload) => {
      invalidated.push(payload.path);
    });
    try {
      await runner.import("/locales.generated.ts");
      await regenerate({ "de-DE": { greeting: "Hallo" } });
      await eventually(() => invalidated.includes("/locales.generated.ts"));
      assert.ok(invalidated.includes("/locales.generated.ts"));
    } finally {
      await runner.close();
    }
  });
});

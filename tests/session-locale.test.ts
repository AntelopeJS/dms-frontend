import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ViteDevServer } from "vite";
import { type Component, createRenderer, h, nextTick, ref } from "vue";

interface Node {
  parent: Node | null;
  children: Node[];
}

function headlessRenderer() {
  const node = (): Node => ({ parent: null, children: [] });
  return createRenderer<Node, Node>({
    createElement: node,
    createText: node,
    createComment: node,
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: (child) => child.parent,
    nextSibling: () => null,
    insert(child, parent) {
      child.parent = parent;
      parent.children.push(child);
    },
    remove(child) {
      if (child.parent)
        child.parent.children = child.parent.children.filter(
          (other) => other !== child,
        );
    },
  });
}

function page(language: string, updatedAt: number, accountId = "account-a") {
  return {
    path: `/${language}-${updatedAt}`,
    page: {},
    user: { language },
    session: { accountId, updatedAt },
  };
}

interface Fixture {
  runtime: Record<string, any>;
  frontend: Record<string, any>;
  createHead: () => unknown;
}

/** The app runtime, loaded through Vite from a copy of the template. */
async function withRuntime(test: (fixture: Fixture) => Promise<void>) {
  // Inside the repository, so the runtime's dependencies resolve.
  const workspace = realpathSync(mkdtempSync(resolve(".session-locale-")));
  let server: ViteDevServer | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "frontend-paths.generated.json"), "{}");
    writeFileSync(
      join(workspace, "locales.generated.ts"),
      'export const localeMessages={en:{}};export const supportedLocales=["en","fr","de"];export const loadLocaleMessages=async(locale)=>({locale});export const syncLocaleMessages=()=>{};',
    );
    writeFileSync(
      join(workspace, "ui-stub.ts"),
      "import {h} from 'vue'; const appConfig={}; export const useAppConfig=()=>appConfig;export const useToast=()=>({add(){}});export const en={code:'en'};export const fr={code:'fr'};export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};",
    );

    const { createServer } = await import("vite");
    const { default: vue } = await import("@vitejs/plugin-vue");
    const uiStub = join(workspace, "ui-stub.ts");
    server = await createServer({
      root: workspace,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false },
      plugins: [
        {
          name: "fixture-ui",
          resolveId: (id) => (id.startsWith("@nuxt/ui/") ? uiStub : null),
        },
        vue(),
      ],
    });
    const runtime = await server.ssrLoadModule("/app-runtime.ts");
    const frontend = await server.ssrLoadModule("/frontend-module.ts");
    const { createHead } = await import("@unhead/vue/server");
    await test({ runtime, frontend, createHead });
  } finally {
    await server?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** Configure an app on `props`, as a render of the request carrying `cookies`. */
async function configuredApp(
  { runtime, frontend, createHead }: Fixture,
  props: { value: ReturnType<typeof page> | AnonymousPage },
  requestCookies?: string,
) {
  const layout = (runtime.resolveDmsInertiaPage() as { layout: Component })
    .layout;
  const app = headlessRenderer().createApp({
    render: () => h(layout, props.value, { default: () => h("p") }),
  });
  const appRuntime = frontend.createDmsFrontendRuntime(
    undefined,
    {},
    requestCookies !== undefined,
    requestCookies,
  );
  // What the browser's runtime is to watchers, which run outside the app.
  frontend.setDmsServerRuntimeResolver(() => appRuntime);
  await runtime.configureDmsApp({
    app,
    head: createHead(),
    initialPageProps: props.value,
    initialPageUrl: props.value.path,
    inertiaPlugin: { install() {} },
    runtime: appRuntime,
  });
  app.mount({ parent: null, children: [] });
  return app;
}

interface AnonymousPage {
  path: string;
  page: Record<string, never>;
}

const anonymousPage = (): AnonymousPage => ({ path: "/auth", page: {} });

const localeOf = (app: { config: { globalProperties: Record<string, any> } }) =>
  app.config.globalProperties.$i18n.locale.value;

it("takes the interface language from the session, not from a restored page", async () => {
  await withRuntime(async (fixture) => {
    const props = ref(page("fr", 2));
    const app = await configuredApp(fixture, props);
    const settle = async () => {
      await nextTick();
      await new Promise((done) => setTimeout(done));
    };
    assert.equal(localeOf(app), "fr");

    // Back to a page fetched before the user switched to French.
    props.value = page("en", 1);
    await settle();
    assert.equal(localeOf(app), "fr");

    // A page fetched after the session changed again.
    props.value = page("de", 3);
    await settle();
    assert.equal(localeOf(app), "de");

    // Another account signs in, whatever the stamps say.
    props.value = page("en", 1, "account-b");
    await settle();
    assert.equal(localeOf(app), "en");

    app.unmount();
  });
});

it("renders an anonymous visit in the language its browser picked", async () => {
  await withRuntime(async (fixture) => {
    const picked = await configuredApp(
      fixture,
      ref(anonymousPage()),
      "dms_session=x; dms_locale=%22fr%22",
    );
    assert.equal(localeOf(picked), "fr");
    picked.unmount();

    // A language the application does not offer, or a malformed value.
    for (const cookie of ["dms_locale=%22xx%22", "dms_locale=%E0"]) {
      const ignored = await configuredApp(
        fixture,
        ref(anonymousPage()),
        cookie,
      );
      assert.equal(localeOf(ignored), "en");
      ignored.unmount();
    }
  });
});

it("keeps a signed-in user's language over the one the browser picked", async () => {
  await withRuntime(async (fixture) => {
    const app = await configuredApp(
      fixture,
      ref(page("de", 1)),
      "dms_locale=%22fr%22",
    );
    assert.equal(localeOf(app), "de");
    app.unmount();
  });
});

it("remembers the language a visitor picks, for the next page load", async () => {
  await withRuntime(async (fixture) => {
    const app = await configuredApp(fixture, ref(anonymousPage()));
    const written: string[] = [];
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        get cookie() {
          return "";
        },
        set cookie(value: string) {
          written.push(value);
        },
      },
    });
    try {
      const i18n = app.config.globalProperties.$i18n;
      await i18n.setLocale("fr");
      assert.equal(localeOf(app), "fr");
      assert.equal(written.length, 1);
      assert.match(written[0], /^dms_locale=%22fr%22; /);
      assert.match(written[0], /path=\//);
      assert.match(written[0], /max-age=31536000/);
      assert.match(written[0], /samesite=lax/);

      // A language the application does not offer is never remembered.
      await i18n.setLocale("xx");
      assert.equal(written.length, 1);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
      app.unmount();
    }
  });
});

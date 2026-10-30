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
import {
  type App,
  type Component,
  createRenderer,
  h,
  nextTick,
  ref,
} from "vue";
import { isCallable, isObjectLike, isText } from "./helpers/guards";

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

type AppRuntime = Pick<
  typeof import("../templates/vue/app-runtime.ts"),
  "configureDmsApp" | "resolveDmsInertiaPage"
>;
type FrontendModule = Pick<
  typeof import("../templates/vue/frontend-module.ts"),
  "createDmsFrontendRuntime" | "setDmsServerRuntimeResolver"
>;
type CreateHead = typeof import("@unhead/vue/server").createHead;

interface Fixture {
  runtime: AppRuntime;
  frontend: FrontendModule;
  createHead: CreateHead;
}

/** What the page `resolveDmsInertiaPage` answers carries besides its render. */
type LayoutPage = Component & { layout: Component };

/** The global composer `vue-i18n` installs on the app in composition mode. */
interface GlobalComposer {
  locale: { value: string };
  setLocale: (locale: string) => Promise<void>;
}

function isAppRuntime(value: unknown): value is AppRuntime {
  return (
    isObjectLike(value) &&
    "configureDmsApp" in value &&
    isCallable(value.configureDmsApp) &&
    "resolveDmsInertiaPage" in value &&
    isCallable(value.resolveDmsInertiaPage)
  );
}

function isFrontendModule(value: unknown): value is FrontendModule {
  return (
    isObjectLike(value) &&
    "createDmsFrontendRuntime" in value &&
    isCallable(value.createDmsFrontendRuntime) &&
    "setDmsServerRuntimeResolver" in value &&
    isCallable(value.setDmsServerRuntimeResolver)
  );
}

function isComponent(value: unknown): value is Component {
  return isObjectLike(value) || isCallable(value);
}

function hasLayout(page: Component): page is LayoutPage {
  return "layout" in page && isComponent(page.layout);
}

function isGlobalComposer(value: unknown): value is GlobalComposer {
  return (
    isObjectLike(value) &&
    "locale" in value &&
    isObjectLike(value.locale) &&
    "value" in value.locale &&
    isText(value.locale.value) &&
    "setLocale" in value &&
    isCallable(value.setLocale)
  );
}

/** The app runtime, loaded through Vite from a copy of the template. */
async function withRuntime(test: (fixture: Fixture) => Promise<void>) {
  const workspace = realpathSync(mkdtempSync(resolve(".session-locale-")));
  let server: ViteDevServer | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "frontend-paths.generated.json"), "{}");
    writeFileSync(
      join(workspace, "locales.generated.ts"),
      'export const localeMessages={en:{}};export const supportedLocales=["en","fr","de"];export const catalogLocale=(locale)=>locale.slice(0,2);export const loadLocaleMessages=async(locale)=>({locale});export const syncLocaleMessages=()=>{};',
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
    const runtime: unknown = await server.ssrLoadModule("/app-runtime.ts");
    const frontend: unknown = await server.ssrLoadModule("/frontend-module.ts");
    assert.ok(
      isAppRuntime(runtime),
      "the app runtime exports its entry points",
    );
    assert.ok(
      isFrontendModule(frontend),
      "the frontend module exports its runtime",
    );
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
  const page = runtime.resolveDmsInertiaPage();
  assert.ok(hasLayout(page), "the Inertia page carries its layout");
  const { layout } = page;
  const app = headlessRenderer().createApp({
    render: () => h(layout, props.value, { default: () => h("p") }),
  });
  const appRuntime = frontend.createDmsFrontendRuntime(
    undefined,
    {},
    requestCookies !== undefined,
    requestCookies,
  );
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

function localeOf(app: App<Node>): string {
  const i18n: unknown = app.config.globalProperties.$i18n;
  assert.ok(isGlobalComposer(i18n), "the app installs the global composer");
  return i18n.locale.value;
}

it("takes the interface language from the session, not from a restored page", async () => {
  await withRuntime(async (fixture) => {
    const props = ref(page("fr", 2));
    const app = await configuredApp(fixture, props);
    const settle = async () => {
      await nextTick();
      await new Promise((done) => setTimeout(done));
    };
    assert.equal(localeOf(app), "fr");

    props.value = page("en", 1);
    await settle();
    assert.equal(localeOf(app), "fr");

    props.value = page("de", 3);
    await settle();
    assert.equal(localeOf(app), "de");

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

      await i18n.setLocale("xx");
      assert.equal(written.length, 1);
    } finally {
      Reflect.deleteProperty(globalThis, "document");
      app.unmount();
    }
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInertiaApp } from "@inertiajs/vue3";
import { renderToString } from "@vue/server-renderer";
import {
  type App,
  createSSRApp,
  defineAsyncComponent,
  defineComponent,
  h,
  nextTick,
  onScopeDispose,
  ref,
  Suspense,
  useId,
  type VNode,
} from "vue";
import {
  createDmsFrontendRuntime,
  createDmsError,
  defineDmsPageMeta,
  dmsPageSuspenseProps,
  type DmsSession,
  hydrateDmsPageProps,
  provideDmsFrontendRuntime,
  registerDmsComponent,
  resolveDmsAsyncComponents,
  trackDmsAsyncComponents,
  trackDmsServerScopes,
  useDmsCookie,
  useDmsState,
  useDmsRoute,
  useDmsPageLoading,
  useDmsUserSession,
  setupFrontendModules,
} from "../templates/vue/frontend-module.ts";
import {
  application,
  mountRuntime,
  registerGlobalMiddleware,
} from "./fixtures/vue-runtime.mts";

describe("Cookie refs", () => {
  it("shares one browser ref per cookie and writes it to the document", (context) => {
    const cookieJar = { cookie: "dms-shared-pref=%22small%22" };
    Object.assign(globalThis, { document: cookieJar });
    context.after(() => {
      Reflect.deleteProperty(globalThis, "document");
    });
    const pageRef = useDmsCookie<string>("dms-shared-pref");
    const pluginRef = useDmsCookie<string>("dms-shared-pref");
    assert.equal(pageRef, pluginRef);
    assert.equal(pluginRef.value, "small");
    pageRef.value = "large";
    assert.equal(pluginRef.value, "large");
    assert.match(cookieJar.cookie, /^dms-shared-pref=%22large%22; path=\//);
  });

  it("reads a server ref from the rendered request, isolated per request", () => {
    const render = (cookieHeader: string) => {
      const app = createSSRApp({ render: () => null });
      const runtime = createDmsFrontendRuntime(
        undefined,
        {},
        true,
        cookieHeader,
      );
      provideDmsFrontendRuntime(app, runtime);
      return app.runWithContext(() => {
        const first = useDmsCookie<string>("dms-scale", {
          default: () => "normal",
        });
        const second = useDmsCookie<string>("dms-scale");
        first.value = "small";
        return { shared: first === second, value: second.value };
      });
    };
    assert.deepEqual(render("session=abc; dms-scale=%22large%22"), {
      shared: true,
      value: "small",
    });
    const untouched = createSSRApp({ render: () => null });
    const runtime = createDmsFrontendRuntime(
      undefined,
      {},
      true,
      "dms-scale=%22large%22",
    );
    provideDmsFrontendRuntime(untouched, runtime);
    assert.equal(
      untouched.runWithContext(() => useDmsCookie<string>("dms-scale").value),
      "large",
    );
    assert.equal(
      untouched.runWithContext(
        () =>
          useDmsCookie<string>("dms-other", { default: () => "normal" }).value,
      ),
      "normal",
    );
  });
});

describe("Async component hydration", () => {
  const asyncBlock = (label: string) =>
    defineAsyncComponent(async () =>
      defineComponent({ render: () => h("span", label) }),
    );

  it("records the registered async components a server render reaches", async () => {
    const rendered = asyncBlock("rendered");
    registerDmsComponent("TrackedRenderedBlock", rendered);
    registerDmsComponent("TrackedUnusedBlock", asyncBlock("unused"));
    const app = createSSRApp({ render: () => h(rendered) });
    const names = trackDmsAsyncComponents(app);
    assert.match(await renderToString(app), /rendered/);
    assert.deepEqual([...names], ["TrackedRenderedBlock"]);
  });

  it("resolves the recorded async components before hydration", async () => {
    const block = asyncBlock("ahead");
    registerDmsComponent("ResolvedAheadBlock", block);
    const isResolved = () =>
      "__asyncResolved" in block && block.__asyncResolved !== undefined;
    assert.equal(isResolved(), false);
    await resolveDmsAsyncComponents(["ResolvedAheadBlock", "UnknownBlock"]);
    assert.equal(isResolved(), true);
  });
});

describe("Server render scopes", () => {
  it("stops the scope of every component a server render created", async () => {
    const disposed: string[] = [];
    const disposable = (label: string, child?: () => VNode) =>
      defineComponent({
        setup() {
          onScopeDispose(() => disposed.push(label));
          return () => h("span", [label, child?.()]);
        },
      });
    const Leaf = disposable("leaf");
    const app = createSSRApp(disposable("root", () => h(Leaf)));
    const stopScopes = trackDmsServerScopes(app);
    assert.match(await renderToString(app), /root.*leaf/);
    assert.deepEqual(disposed, []);
    stopScopes();
    assert.deepEqual(disposed, ["root", "leaf"]);
  });
});

describe("Page meta", () => {
  const DeclaringPage = defineComponent({
    setup() {
      defineDmsPageMeta({ auth: true });
      useDmsRoute();
      return () => h("p", "page");
    },
  });

  async function renderDeclaringPage(url: string): Promise<void> {
    const runtime = createDmsFrontendRuntime(undefined, {}, true);
    const props = { path: new URL(url, "http://frontend.local").pathname };
    await createInertiaApp({
      page: {
        component: "Page",
        props: { ...props, page: {} },
        url,
        version: "",
      },
      render: renderToString,
      resolve: () => DeclaringPage,
      setup({ App, props: inertiaProps }) {
        const app = createSSRApp({ render: () => h(App, inertiaProps) });
        provideDmsFrontendRuntime(app, runtime);
        app.runWithContext(() => {
          hydrateDmsPageProps({ ...props, page: {} }, url);
          useDmsRoute();
        });
        return app;
      },
    });
    await runtime.pendingNavigation;
  }

  it("keeps the meta a page declared once it reads its route", async () => {
    const seen: unknown[] = [];
    await setupFrontendModules([
      {
        options: { public: {} },
        module: {
          setup(sdk) {
            sdk.registerMiddleware(
              "awaits",
              async () => {
                await Promise.resolve();
              },
              { global: true },
            );
            sdk.registerMiddleware("auth", (to) => {
              seen.push(to.meta.auth);
            });
          },
        },
      },
    ]);
    await renderDeclaringPage("/first?tab=a");
    await renderDeclaringPage("/second");
    assert.deepEqual(seen, [true, true]);
  });

  it("renders a page once its middleware is done, with the same ids in the browser", async () => {
    await registerGlobalMiddleware(async () => {
      const guard = useDmsState("guard", () => "");
      await new Promise((resolve) => setTimeout(resolve, 5));
      guard.value = "ready";
    });
    const ids = new Map<string, string>();
    const Child = defineComponent({
      props: { label: { type: String, required: true } },
      setup(props) {
        const id = useId();
        ids.set(props.label, id);
        return () => h("i", id);
      },
    });
    const Page = defineComponent({
      setup() {
        defineDmsPageMeta({});
        const guard = useDmsState("guard", () => "");
        return () =>
          h("p", [`guard:${guard.value}`, h(Child, { label: "inside" })]);
      },
    });
    const Root = {
      render: () => h("div", [h(Page), h(Child, { label: "after" })]),
    };
    const runtime = createDmsFrontendRuntime(undefined, {}, true);
    const app = createSSRApp(Root);
    provideDmsFrontendRuntime(app, runtime);
    assert.match(await renderToString(app), /guard:ready/);
    const serverIds = Object.fromEntries(ids);
    ids.clear();

    const browser = mountRuntime(createDmsFrontendRuntime(), Root);
    browser.unmount();
    assert.deepEqual(Object.fromEntries(ids), serverIds);
  });

  it("keeps a page's meta while it stays on screen and drops it for the next page", async () => {
    await setupFrontendModules([]);
    const { app, runtime } = application("first");
    app.runWithContext(() => {
      hydrateDmsPageProps({ path: "/declared", page: {} }, "/declared");
      defineDmsPageMeta({ auth: true });
      hydrateDmsPageProps({ path: "/declared", page: {} }, "/declared?tab=b");
    });
    assert.deepEqual(runtime.route.meta, { auth: true });
    app.runWithContext(() =>
      hydrateDmsPageProps({ path: "/next", page: {} }, "/next"),
    );
    assert.deepEqual(runtime.route.meta, {});
  });

  it("shows the error a middleware throws in place of the page", async () => {
    await registerGlobalMiddleware(async (to) => {
      await Promise.resolve();
      if (to.path === "/missing")
        throw createDmsError({ statusCode: 404, statusMessage: "Not here" });
    });
    const { app, runtime } = application("first");
    app.runWithContext(() => {
      hydrateDmsPageProps({ path: "/missing", page: {} }, "/missing");
      defineDmsPageMeta({ auth: true });
    });
    await runtime.pendingNavigation;
    assert.equal(runtime.currentError.value?.statusCode, 404);
    assert.equal(runtime.currentError.value?.message, "Not here");
  });

  it("drops a page's meta when an error page replaces it at the same path", async () => {
    await setupFrontendModules([]);
    const { app, runtime } = application("first");
    app.runWithContext(() => {
      hydrateDmsPageProps({ path: "/declared", page: {} }, "/declared");
      defineDmsPageMeta({ auth: true });
      hydrateDmsPageProps(
        { path: "/declared", page: {}, error: { statusCode: 500 } },
        "/declared",
      );
    });
    assert.deepEqual(runtime.route.meta, {});
  });
});

describe("Page loading state", () => {
  function settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve));
  }

  function suspendingPage() {
    let release = () => {};
    const page = defineComponent({
      async setup() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => h("p", "page");
      },
    });
    return { page, release: () => release() };
  }

  function mountPage(page: ReturnType<typeof defineComponent>) {
    const runtime = createDmsFrontendRuntime();
    const shown = ref(true);
    let loading: ReturnType<typeof useDmsPageLoading> = ref(false);
    mountRuntime(
      runtime,
      defineComponent({
        setup() {
          loading = useDmsPageLoading();
          return () =>
            shown.value
              ? h(Suspense, dmsPageSuspenseProps(), { default: () => h(page) })
              : null;
        },
      }),
    );
    return { loading: () => loading.value, shown };
  }

  it("is pending while the page suspends and settles once it resolves", async () => {
    const { page, release } = suspendingPage();
    const { loading } = mountPage(page);
    assert.equal(loading(), true);
    release();
    await settle();
    assert.equal(loading(), false);
  });

  it("settles when a page is left before it resolves", async () => {
    const { page } = suspendingPage();
    const { loading, shown } = mountPage(page);
    assert.equal(loading(), true);
    shown.value = false;
    await nextTick();
    assert.equal(loading(), false);
  });

  it("never turns on for a page that does not suspend", () => {
    const { loading } = mountPage(defineComponent({ render: () => h("p") }));
    assert.equal(loading(), false);
  });
});

describe("Session hydration", () => {
  function hydrate(app: App, language: string, session: Partial<DmsSession>) {
    app.runWithContext(() =>
      hydrateDmsPageProps({
        path: "/page",
        page: {},
        user: { language },
        session: { accountId: "account-a", ...session },
      }),
    );
  }

  function currentLanguage(app: App) {
    return app.runWithContext(() => useDmsUserSession().user.value?.language);
  }

  it("keeps a newer session over the one a restored page carries", () => {
    const { app } = application("first");
    hydrate(app, "fr", { updatedAt: 2 });
    hydrate(app, "en", { updatedAt: 1 });
    assert.equal(currentLanguage(app), "fr");
  });

  it("takes the session of a fresh page, or of another account", () => {
    const { app } = application("first");
    hydrate(app, "fr", { updatedAt: 2 });
    hydrate(app, "de", { updatedAt: 3 });
    assert.equal(currentLanguage(app), "de");
    hydrate(app, "en", { accountId: "account-b", updatedAt: 1 });
    assert.equal(currentLanguage(app), "en");
  });

  it("takes every session a server without stamps sends", () => {
    const { app } = application("first");
    hydrate(app, "fr", {});
    hydrate(app, "en", {});
    assert.equal(currentLanguage(app), "en");
  });

  it("clears the session of a signed-out page", () => {
    const { app } = application("first");
    hydrate(app, "fr", { updatedAt: 2 });
    app.runWithContext(() => hydrateDmsPageProps({ path: "/auth", page: {} }));
    assert.equal(currentLanguage(app), undefined);
  });
});

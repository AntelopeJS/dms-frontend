import assert from "node:assert/strict";
import {
  afterEach,
  beforeEach,
  describe,
  it,
  type TestContext,
} from "node:test";
import { createInertiaApp, router } from "@inertiajs/vue3";
import { renderToString } from "@vue/server-renderer";
import {
  type App,
  createSSRApp,
  defineComponent,
  type EffectScope,
  effectScope,
  h,
  nextTick,
  watch,
} from "vue";
import {
  createDmsFrontendRuntime,
  type DmsFrontendRuntime,
  provideDmsFrontendRuntime,
  useDmsRoute,
  useDmsRouter,
} from "../templates/vue/frontend-module.ts";

const Page = defineComponent({ setup: () => () => h("p", "page") });

/**
 * Makes `url` Inertia's page: Inertia keeps it in one module-level ref, which
 * a render writes as it starts, and which `usePage()` reads.
 */
async function showPage(url: string): Promise<void> {
  await createInertiaApp({
    page: { component: "Page", props: {}, url, version: "" },
    render: renderToString,
    resolve: () => Page,
    setup: ({ App, props }) => createSSRApp({ render: () => h(App, props) }),
  });
}

describe("Route stability", () => {
  let app: App;
  let runtime: DmsFrontendRuntime;
  let scope: EffectScope;
  function inScope<T>(callback: () => T): T {
    return scope.run(() => app.runWithContext(callback)) as T;
  }

  beforeEach(async () => {
    await showPage("/runs?tab=open");
    app = createSSRApp({ render: () => null });
    runtime = createDmsFrontendRuntime();
    provideDmsFrontendRuntime(app, runtime);
    scope = effectScope();
  });

  afterEach(() => scope.stop());

  it("keeps the same query and params while the URL does not change", async () => {
    const route = inScope(() => useDmsRoute());
    const { query, params, matched } = route;
    let changes = 0;
    inScope(() =>
      watch(
        () => [route.query, route.params, route.matched],
        () => changes++,
      ),
    );

    // Each component of the page reads the route on its own.
    inScope(() => useDmsRoute());
    await showPage("/runs?tab=open");
    await nextTick();

    assert.equal(route.query, query);
    assert.equal(route.params, params);
    assert.equal(route.matched, matched);
    assert.equal(changes, 0);
  });

  it("replaces the query once the query string changes", async () => {
    const route = inScope(() => useDmsRoute());
    let changes = 0;
    inScope(() =>
      watch(
        () => route.query,
        () => changes++,
      ),
    );

    await showPage("/runs?tab=closed");
    await nextTick();

    assert.deepEqual({ ...route.query }, { tab: "closed" });
    assert.equal(changes, 1);
  });

  it("replaces the params once the path changes", async () => {
    const route = inScope(() => useDmsRoute("/runs/:id"));
    await showPage("/runs/1");
    await nextTick();
    const params = route.params;

    await showPage("/runs/2");
    await nextTick();

    assert.notEqual(route.params, params);
    assert.deepEqual({ ...route.params }, { id: "2" });
  });
});

describe("Navigation to the URL shown", () => {
  const globals = globalThis as Record<string, unknown>;
  let app: App;
  let location: URL;

  // A component writes the URL in place (a record deep link): the browser
  // shows it, while Inertia's page, and so the route, never saw it.
  const showUrl = (url: string) => {
    location.href = new URL(url, location.origin).href;
  };

  async function navigations(
    navigate: (dmsRouter: ReturnType<typeof useDmsRouter>) => Promise<void>,
    context: TestContext,
  ): Promise<string[]> {
    const urls: string[] = [];
    context.mock.method(router, "visit", (url: string, options) => {
      urls.push(url);
      options?.onFinish?.({});
    });
    await navigate(app.runWithContext(useDmsRouter));
    return urls;
  }

  beforeEach(async () => {
    await showPage("/runs?tab=open");
    // A browser runtime set up while the page was the one Inertia showed.
    app = createSSRApp({ render: () => null });
    const runtime = createDmsFrontendRuntime();
    provideDmsFrontendRuntime(app, runtime);
    app.runWithContext(() => useDmsRoute());
    location = new URL("http://localhost/runs?tab=open");
    globals.window = { location };
  });

  afterEach(() => {
    delete globals.window;
  });

  it("navigates when the URL moved away from the route", async (context) => {
    showUrl("/runs?tab=open&record=r1");

    const urls = await navigations(
      (dmsRouter) => dmsRouter.replace({ query: { tab: "open" } }),
      context,
    );

    assert.deepEqual(urls, ["/runs?tab=open"]);
  });

  it("does not navigate to the URL already shown, however it is spelled", async (context) => {
    showUrl("/runs?tab=open&record=r1&q=a+b");

    const urls = await navigations(async (dmsRouter) => {
      await dmsRouter.replace("/runs?tab=open&record=r1&q=a+b");
      await dmsRouter.replace({
        query: { tab: "open", record: "r1", q: "a b" },
      });
      await dmsRouter.push("/runs?tab=open&record=r1&q=a%20b");
    }, context);

    assert.deepEqual(urls, []);
  });

  it("navigates to another site at the same path", async (context) => {
    const urls = await navigations(
      (dmsRouter) => dmsRouter.push("https://elsewhere.example/runs?tab=open"),
      context,
    );

    assert.deepEqual(urls, ["https://elsewhere.example/runs?tab=open"]);
  });
});

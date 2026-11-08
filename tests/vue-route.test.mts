import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInertiaApp } from "@inertiajs/vue3";
import { renderToString } from "@vue/server-renderer";
import {
  type App,
  createSSRApp,
  type DefineComponent,
  defineComponent,
  h,
} from "vue";
import * as Vue from "vue";
import {
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  provideDmsFrontendRuntime,
  useDmsRoute,
} from "../templates/vue/frontend-module.ts";
import { inertiaPage } from "./helpers/inertia-page";

type WithAsyncContext = (
  getAwaitable: () => Promise<void>,
) => [awaitable: Promise<void>, restore: () => void];

function isAsyncContext(value: unknown): value is WithAsyncContext {
  return typeof value === "function";
}

/** The helper Vue's compiler wraps around an `await` in `<script setup>`; the typings leave it out. */
function vueAsyncContext(): WithAsyncContext {
  const exported: unknown = Object.getOwnPropertyDescriptor(
    Vue,
    "withAsyncContext",
  )?.value;
  assert.ok(isAsyncContext(exported), "Vue exports withAsyncContext");
  return exported;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function pageProps(url: string) {
  return { path: new URL(url, "http://frontend.local").pathname, page: {} };
}

/**
 * Renders `url` the way the SSR entry does: the runtime is given the
 * request's page before the plugins set up, then Inertia renders the page.
 */
async function render(
  url: string,
  page: DefineComponent,
  props: { delay?: number } = {},
  setUpPlugins: (app: App) => void = () => {},
): Promise<string> {
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  let body: string | undefined;
  await createInertiaApp({
    page: inertiaPage(url, { ...pageProps(url), ...props }),
    render: async (app: App) => (body = await renderToString(app)),
    resolve: () => page,
    setup({ App, props: inertiaProps }) {
      const app = createSSRApp({ render: () => h(App, inertiaProps) });
      provideDmsFrontendRuntime(app, runtime);
      app.runWithContext(() => hydrateDmsPageProps(pageProps(url), url));
      setUpPlugins(app);
      return app;
    },
  });
  assert.ok(body !== undefined, "Inertia rendered the page");
  return body;
}

describe("Route of the page", () => {
  it("keeps the initial URL for a plugin reading it before the app mounts", () => {
    const app = createSSRApp({ render: () => null });
    const runtime = createDmsFrontendRuntime();
    provideDmsFrontendRuntime(app, runtime);
    const seen = app.runWithContext(() => {
      hydrateDmsPageProps(pageProps("/initial"), "/initial?tab=a");
      return useDmsRoute().fullPath;
    });
    assert.equal(seen, "/initial?tab=a");
  });

  it("gives a plugin its own request's URL during a server render", async () => {
    const Page: DefineComponent = defineComponent({
      setup: () => () => h("p", "page"),
    });
    const seen: string[] = [];
    const readRoute = (app: App) =>
      seen.push(app.runWithContext(() => useDmsRoute().fullPath));
    await render("/first?x=1", Page, {}, readRoute);
    await render("/second?y=2", Page, {}, readRoute);
    assert.deepEqual(seen, ["/first?x=1", "/second?y=2"]);
  });

  it("gives a component its own request's URL after an await, while another request renders", async () => {
    const RouteAfterAwait = defineComponent({
      inheritAttrs: false,
      async setup(_props, { attrs }) {
        const [pending, restore] = vueAsyncContext()(() =>
          sleep(Number(attrs.delay)),
        );
        await pending;
        restore();
        const route = useDmsRoute();
        return () => h("p", `route:${route.fullPath}`);
      },
    });
    const Page: DefineComponent = defineComponent({
      inheritAttrs: false,
      setup:
        (_props, { attrs }) =>
        () =>
          h("div", [h(RouteAfterAwait, attrs)]),
    });
    const first = render("/orders/1?tab=a", Page, { delay: 30 });
    await sleep(5);
    const second = render("/orders/2?tab=b", Page, { delay: 1 });
    const bodies = await Promise.all([first, second]);
    assert.deepEqual(
      bodies.map((body) => body.match(/route:([^<]*)/)?.[1]),
      ["/orders/1?tab=a", "/orders/2?tab=b"],
    );
  });
});

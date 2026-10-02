import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInertiaApp } from "@inertiajs/vue3";
import { renderToString } from "@vue/server-renderer";
import {
  type App,
  type Component,
  createSSRApp,
  defineComponent,
  h,
  withAsyncContext,
} from "vue";
import {
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  provideDmsFrontendRuntime,
  useDmsRoute,
} from "../templates/vue/frontend-module.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pageProps(url: string) {
  return { path: new URL(url, "http://frontend.local").pathname, page: {} };
}

/**
 * Renders `url` the way the SSR entry does: the runtime is given the
 * request's page before the plugins set up, then Inertia renders the page.
 */
async function render(
  url: string,
  page: Component,
  props: Record<string, unknown> = {},
  setUpPlugins: (app: App) => void = () => {},
): Promise<string> {
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  const result = await createInertiaApp({
    page: {
      component: "Page",
      props: { ...pageProps(url), ...props },
      url,
      version: "",
    },
    render: renderToString,
    resolve: () => page,
    setup({ App, props: inertiaProps }) {
      const app = createSSRApp({ render: () => h(App, inertiaProps) });
      provideDmsFrontendRuntime(app, runtime);
      app.runWithContext(() => hydrateDmsPageProps(pageProps(url), url));
      setUpPlugins(app);
      return app;
    },
  });
  assert.ok(result);
  return result.body;
}

// Inertia keeps its page in one module-level ref: the browser test must run
// first, while no render of this process has written it yet.
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
    const Page = defineComponent({ setup: () => () => h("p", "page") });
    const seen: string[] = [];
    // dms-ui's `register` plugin reads the route while it sets up, before the
    // request's page has rendered.
    const readRoute = (app: App) =>
      seen.push(app.runWithContext(() => useDmsRoute().fullPath));
    await render("/first?x=1", Page, {}, readRoute);
    await render("/second?y=2", Page, {}, readRoute);
    assert.deepEqual(seen, ["/first?x=1", "/second?y=2"]);
  });

  it("gives a component its own request's URL after an await, while another request renders", async () => {
    const RouteAfterAwait = defineComponent({
      props: { delay: { type: Number, required: true } },
      async setup(props) {
        // What `<script setup>` compiles a top-level await to.
        let pending: unknown;
        let restore: () => void;
        [pending, restore] = withAsyncContext(() => sleep(props.delay));
        await pending;
        restore();
        const route = useDmsRoute();
        return () => h("p", `route:${route.fullPath}`);
      },
    });
    const Page = defineComponent({
      props: { delay: { type: Number, required: true } },
      setup: (props) => () => h("div", [h(RouteAfterAwait, props)]),
    });
    // The first request waits longer: the second one starts, then renders,
    // while the first is still suspended.
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

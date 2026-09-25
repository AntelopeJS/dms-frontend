import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { router } from "@inertiajs/vue3";
import { renderToString } from "@vue/server-renderer";
import {
  createSSRApp,
  createRenderer,
  defineAsyncComponent,
  defineComponent,
  h,
  nextTick,
  ref,
} from "vue";
import {
  addDmsMiddleware,
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  navigateDms,
  provideDmsFrontendRuntime,
  registerDmsComponent,
  resolveDmsAsyncComponents,
  serializeDmsAsyncData,
  trackDmsAsyncComponents,
  useDmsAsyncData,
  useError,
  useDmsRuntimeHooks,
  useDmsState,
  useDmsFetch,
  useDmsRouter,
} from "../templates/vue/frontend-module.ts";

function application(label: string, hydrated = {}, isServer = false) {
  const app = createSSRApp({ render: () => null });
  const requests: string[] = [];
  const runtime = createDmsFrontendRuntime(
    async (url: string) => {
      requests.push(url);
      await new Promise((resolve) =>
        setTimeout(resolve, label === "first" ? 10 : 1),
      );
      return label;
    },
    hydrated,
    isServer,
  );
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime, requests };
}

function mountRuntime(runtime, root) {
  const node = () => ({ parent: null, children: [] });
  const renderer = createRenderer({
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
      child.parent.children = child.parent.children.filter(
        (other) => other !== child,
      );
    },
  });
  const app = renderer.createApp(root);
  provideDmsFrontendRuntime(app, runtime);
  app.mount(node());
  return app;
}

describe("Vue request runtime", () => {
  it("keeps relative middleware redirects out of the browser router during SSR", async (context) => {
    const { app } = application("server", {}, true);
    addDmsMiddleware(
      (to) => (to.path === "/requires-onboarding" ? "/onboarding" : undefined),
      undefined,
      true,
    );
    const visit = context.mock.method(router, "visit", (url: string) => {
      new URL(url);
    });

    await app.runWithContext(() => navigateDms("/requires-onboarding"));

    assert.equal(visit.mock.callCount(), 0);
  });

  it("skips identical compatibility navigation but preserves explicit Inertia refreshes", async (context) => {
    const { app, runtime } = application("first");
    Object.assign(runtime.route, {
      path: "/dashboard",
      fullPath: "/dashboard?tab=failed#section",
      query: { tab: "failed" },
    });
    const calls: string[] = [];
    context.mock.method(router, "visit", (url, options) => {
      calls.push(url);
      options?.onFinish?.({});
    });
    const navigation = app.runWithContext(useDmsRouter);
    await navigation.push("/dashboard?tab=failed#section");
    await navigation.replace({ query: { tab: "failed" }, hash: "#section" });
    assert.deepEqual(calls, []);
    await navigation.push({ query: { tab: "failed" }, hash: "#other" });
    await navigation.replace({ query: { tab: "success" }, hash: "#section" });
    await app.runWithContext(() => navigateDms(runtime.route.fullPath));
    router.visit(runtime.route.fullPath);
    assert.deepEqual(calls, [
      "/dashboard?tab=failed#other",
      "/dashboard?tab=success#section",
      "/dashboard?tab=failed#section",
      "/dashboard?tab=failed#section",
    ]);
  });

  it("rebinds cached async data to mounted consumers and rejects disposed or superseded requests", async () => {
    const runtime = createDmsFrontendRuntime(undefined, { table: "SSR rows" });
    const visible = ref(true);
    const filters = [ref("all"), ref("all")];
    const requests: Array<{
      owner: number;
      filter: string;
      resolve(value: string): void;
    }> = [];
    const entries = [];
    let mounts = 0;
    const Consumer = defineComponent({
      setup() {
        const owner = mounts++;
        void useDmsAsyncData(
          "table",
          () =>
            new Promise<string>((resolve) => {
              requests.push({ owner, filter: filters[owner].value, resolve });
            }),
          { watch: [filters[owner]] },
        ).then((entry) => entries.push(entry));
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, {
      render: () => (visible.value ? h(Consumer) : null),
    });
    try {
      await nextTick();
      assert.equal(requests.length, 0, "SSR hydration must not fetch twice");
      filters[0].value = "old-pending";
      await nextTick();
      assert.equal(requests.length, 1);
      visible.value = false;
      await nextTick();
      visible.value = true;
      await nextTick();
      filters[0].value = "disposed-filter";
      filters[1].value = "failed";
      await nextTick();
      assert.deepEqual(
        requests.map(({ owner, filter }) => ({ owner, filter })),
        [
          { owner: 0, filter: "old-pending" },
          { owner: 1, filter: "failed" },
        ],
      );
      filters[1].value = "success";
      await nextTick();
      requests[2].resolve("current success rows");
      await new Promise((resolve) => setImmediate(resolve));
      requests[1].resolve("superseded failed rows");
      requests[0].resolve("disposed rows");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        entries[0],
        entries[1],
        "Consumers retain shared keyed refs",
      );
      assert.equal(entries[1].data.value, "current success rows");
      assert.equal(entries[1].status.value, "success");
      assert.equal(entries[1].pending.value, false);
    } finally {
      app.unmount();
    }
  });

  it("starts a fresh initial load after its pending consumer unmounts", async () => {
    const runtime = createDmsFrontendRuntime();
    const visible = ref(true);
    const requests: Array<{
      resolve(value: string): void;
      reject(reason: Error): void;
    }> = [];
    const Consumer = defineComponent({
      setup() {
        void useDmsAsyncData(
          "pending-table",
          () =>
            new Promise<string>((resolve, reject) =>
              requests.push({ resolve, reject }),
            ),
        );
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, {
      render: () => (visible.value ? h(Consumer) : null),
    });
    try {
      await nextTick();
      visible.value = false;
      await nextTick();
      visible.value = true;
      await nextTick();
      assert.equal(
        requests.length,
        2,
        "Remount must not wait for a disposed request",
      );
      requests[1].resolve("new rows");
      await new Promise((resolve) => setImmediate(resolve));
      requests[0].reject(new Error("late obsolete failure"));
      await new Promise((resolve) => setImmediate(resolve));
      const entry = runtime.asyncData.get("pending-table");
      assert.equal(entry?.data.value, "new rows");
      assert.equal(entry?.error.value, null);
      assert.equal(entry?.status.value, "success");
    } finally {
      app.unmount();
    }
  });

  it("refreshes stable keyed data when its consumer returns after navigation", async () => {
    const runtime = createDmsFrontendRuntime(undefined, { table: "Live" });
    const visible = ref(true);
    let backendValue = "Live";
    let requests = 0;
    const Consumer = defineComponent({
      setup() {
        void useDmsAsyncData("table", async () => {
          requests++;
          return backendValue;
        });
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, {
      render: () => (visible.value ? h(Consumer) : null),
    });
    try {
      await nextTick();
      assert.equal(requests, 0, "Initial hydration must not fetch twice");
      visible.value = false;
      await nextTick();
      visible.value = true;
      await nextTick();
      assert.equal(requests, 0, "A local remount must retain the keyed result");
      visible.value = false;
      await nextTick();
      backendValue = "Draft";
      app.runWithContext(() =>
        hydrateDmsPageProps({ path: "/editor", page: {} }),
      );
      visible.value = true;
      await nextTick();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 1);
      assert.equal(runtime.asyncData.get("table")?.data.value, "Draft");
    } finally {
      app.unmount();
    }
  });

  it("replaces explicit query objects rather than restoring removed tab keys", async (context) => {
    const { app, runtime } = application("first");
    runtime.route.path = "/dashboard";
    runtime.route.query = { tab: "archived", keep: "old" };
    const urls: string[] = [];
    context.mock.method(router, "visit", (url, options) => {
      urls.push(url);
      options.onFinish({});
    });
    const navigation = app.runWithContext(useDmsRouter);
    await navigation.replace({ query: { keep: "new" } });
    await navigation.replace({ query: {} });
    await navigation.push({ path: "/elsewhere" });
    await navigation.push({
      query: { tags: ["a b", "c"], flag: null, omit: undefined },
    });
    assert.deepEqual(urls, [
      "/dashboard?keep=new",
      "/dashboard",
      "/elsewhere",
      "/dashboard?tags=a%20b&tags=c&flag",
    ]);
  });

  it("isolates overlapping transport, state, async data and hooks", async () => {
    const first = application("first");
    const second = application("second");
    const calls: string[] = [];
    const pending = [first, second].map(({ app }, index) =>
      app.runWithContext(() => {
        useDmsState("identity", () => index);
        const hooks = useDmsRuntimeHooks();
        hooks.hook("changed", () => {
          calls.push(String(index));
        });
        const request = useDmsFetch<string>(`/request/${index}`, {
          immediate: false,
        });
        return useDmsAsyncData("same-key", async () => {
          await request.execute();
          await hooks.callHook("changed");
          return request.data.value;
        });
      }),
    );
    const [a, b] = await Promise.all(pending);
    assert.equal(a.data.value, "first");
    assert.equal(b.data.value, "second");
    assert.deepEqual(calls, ["1", "0"]);
    assert.deepEqual(first.requests, ["/request/0"]);
    assert.deepEqual(second.requests, ["/request/1"]);
    assert.equal(first.runtime.sharedState.get("identity")?.value, 0);
    assert.equal(second.runtime.sharedState.get("identity")?.value, 1);
    assert.deepEqual(serializeDmsAsyncData(first.runtime), {
      "same-key": "first",
    });
    assert.throws(() => useDmsState("identity"), /outside a Vue application/);
  });

  it("hydrates falsy async data without fetching twice and refreshes explicitly", async () => {
    const { app } = application("client", { empty: null });
    let count = 0;
    const load = () =>
      app.runWithContext(() => useDmsAsyncData("empty", async () => ++count));
    const [first, second] = await Promise.all([load(), load()]);
    assert.equal(count, 0);
    assert.equal(first, second);
    assert.equal(first.data.value, null);
    await first.refresh();
    assert.equal(first.data.value, 1);
    assert.equal(count, 1);
  });

  it("deduplicates concurrent async data consumers within one request", async () => {
    const { app } = application("first");
    let count = 0;
    const load = () =>
      app.runWithContext(() =>
        useDmsAsyncData("key", async () => {
          count++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return 42;
        }),
      );
    const [first, second] = await Promise.all([load(), load()]);
    assert.equal(count, 1);
    assert.equal(first, second);
    assert.equal(second.data.value, 42);
  });

  it("replaces shared permission data on navigation and disposes hooks", async () => {
    const { app, runtime } = application("first");
    let calls = 0;
    const hooks = app.runWithContext(useDmsRuntimeHooks);
    const dispose = hooks.hook("changed", () => {
      calls++;
    });
    await hooks.callHook("changed");
    dispose();
    await hooks.callHook("changed");
    assert.equal(calls, 1);
    app.runWithContext(() => {
      hydrateDmsPageProps({
        path: "/one",
        page: {
          route: { layoutUrl: "/private-layout" },
          layout: { componentName: "PrivateLayout" },
          shared: {
            isOwner: true,
            modules: ["private"],
            quickActions: ["delete"],
          },
        },
      });
      hydrateDmsPageProps({
        path: "/two",
        page: {
          route: { layoutUrl: "/public-layout" },
          layout: { componentName: "PublicLayout" },
          shared: { isOwner: false, modules: [], quickActions: [] },
        },
      });
    });
    assert.equal(runtime.sharedState.get("dms-isOwner")?.value, false);
    assert.deepEqual(runtime.sharedState.get("dms-modules")?.value, []);
    assert.deepEqual(runtime.sharedState.get("dms-quickActions")?.value, []);
    assert.deepEqual(runtime.sharedState.get("dms-pageLayouts")?.value, {
      "/public-layout": { componentName: "PublicLayout" },
    });
  });

  it("restores isolated application contexts between asynchronous middleware", async () => {
    const first = application("first");
    const second = application("second");
    const capturedErrors = new Map<string, ReturnType<typeof useError>>();
    addDmsMiddleware(
      async () => {
        await Promise.resolve();
      },
      undefined,
      true,
    );
    addDmsMiddleware(
      (to) => {
        capturedErrors.set(to.path, useError());
        return false;
      },
      undefined,
      true,
    );
    await Promise.all([
      first.app.runWithContext(() => navigateDms("/first-middleware")),
      second.app.runWithContext(() => navigateDms("/second-middleware")),
    ]);
    assert.equal(
      capturedErrors.get("/first-middleware"),
      first.runtime.currentError,
    );
    assert.equal(
      capturedErrors.get("/second-middleware"),
      second.runtime.currentError,
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
    const block = asyncBlock("ahead") as { __asyncResolved?: unknown };
    registerDmsComponent("ResolvedAheadBlock", block as never);
    assert.equal(block.__asyncResolved, undefined);
    await resolveDmsAsyncComponents(["ResolvedAheadBlock", "UnknownBlock"]);
    assert.ok(block.__asyncResolved);
  });
});

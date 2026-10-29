import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { router } from "@inertiajs/vue3";
import { defineComponent, h, nextTick, ref } from "vue";
import {
  createDmsFrontendRuntime,
  dmsPageSuspenseProps,
  hydrateDmsPageProps,
  navigateDms,
  useDmsAsyncData,
  useDmsRouter,
  setupFrontendModules,
} from "../templates/vue/frontend-module.ts";
import {
  recordVisits,
  application,
  mountRuntime,
  registerGlobalMiddleware,
} from "./fixtures/vue-runtime.mts";

describe("Vue request runtime", () => {
  it("runs the middlewares registered as parallel together, the first result in order winning", async () => {
    const { app } = application("server", {}, true);
    const started: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((settle) => (release = settle));
    await setupFrontendModules([
      {
        module: {
          setup(sdk) {
            sdk.registerMiddleware(
              "session",
              async (to) => {
                started.push(`session ${to.path}`);
                await gate;
              },
              { global: true, parallel: true },
            );
            sdk.registerMiddleware(
              "flags",
              async (to) => {
                started.push(`flags ${to.path}`);
                await gate;
                return to.path === "/both" ? "/from-flags" : undefined;
              },
              { global: true, parallel: true },
            );
            sdk.registerMiddleware(
              "after",
              (to) => {
                started.push(`after ${to.path}`);
                return to.path === "/both" ? "/from-after" : undefined;
              },
              { global: true },
            );
          },
        },
        options: { public: {} },
      },
    ]);
    const navigation = app.runWithContext(() => navigateDms("/both"));
    await new Promise((settle) => setTimeout(settle, 0));
    assert.deepEqual(started, ["session /both", "flags /both"]);
    release();
    await navigation;
    assert.deepEqual(started, [
      "session /both",
      "flags /both",
      "session /from-flags",
      "flags /from-flags",
      "after /from-flags",
    ]);
  });

  it("keeps relative middleware redirects out of the browser router during SSR", async (context) => {
    const { app } = application("server", {}, true);
    await registerGlobalMiddleware((to) =>
      to.path === "/requires-onboarding" ? "/onboarding" : undefined,
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
    const visits = recordVisits(context);
    const calls = () => visits.map(({ kind, url }) => `${kind} ${url}`);
    const navigation = app.runWithContext(useDmsRouter);
    await navigation.push("/dashboard?tab=failed#section");
    await navigation.replace({ query: { tab: "failed" }, hash: "#section" });
    assert.deepEqual(calls(), []);
    await navigation.push({ query: { tab: "failed" }, hash: "#other" });
    await navigation.replace({ query: { tab: "success" }, hash: "#section" });
    await app.runWithContext(() => navigateDms(runtime.route.fullPath));
    router.visit(runtime.route.fullPath);
    assert.deepEqual(calls(), [
      "push /dashboard?tab=failed#other",
      "replace /dashboard?tab=success#section",
      "push /dashboard?tab=failed#section",
      "server /dashboard?tab=failed#section",
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

  it("shows keyed data at once when its consumer returns, and reads it again but on hydration", async () => {
    const runtime = createDmsFrontendRuntime(undefined, { table: "Live" });
    const visible = ref(true);
    let backendValue = "Live";
    let requests = 0;
    const shown: string[] = [];
    const Consumer = defineComponent({
      setup() {
        const { data } = useDmsAsyncData("table", async () => {
          requests++;
          return backendValue;
        });
        return () => {
          shown.push(String(data.value));
          return h("p");
        };
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
      assert.equal(requests, 0, "A remount while the page hydrates neither");
      app.runWithContext(() => dmsPageSuspenseProps()).onResolve();
      await nextTick();
      visible.value = false;
      await nextTick();
      backendValue = "Draft";
      app.runWithContext(() =>
        hydrateDmsPageProps({ path: "/editor", page: {} }),
      );
      shown.length = 0;
      visible.value = true;
      await nextTick();
      assert.equal(shown[0], "Live", "the cached data shows at once");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 1, "and is read again in the background");
      assert.equal(runtime.asyncData.get("table")?.data.value, "Draft");
      visible.value = false;
      await nextTick();
      visible.value = true;
      await nextTick();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests, 2, "every mount reads it again");
    } finally {
      app.unmount();
    }
  });

  it("replaces explicit query objects rather than restoring removed tab keys", async (context) => {
    const { app, runtime } = application("first");
    runtime.route.path = "/dashboard";
    runtime.route.query = { tab: "archived", keep: "old" };
    const visits = recordVisits(context);
    const navigation = app.runWithContext(useDmsRouter);
    await navigation.replace({ query: { keep: "new" } });
    await navigation.replace({ query: {} });
    await navigation.push({ path: "/elsewhere" });
    await navigation.push({
      query: { tags: ["a b", "c"], flag: null, omit: undefined },
    });
    assert.deepEqual(
      visits.map(({ url }) => url),
      [
        "/dashboard?keep=new",
        "/dashboard",
        "/elsewhere",
        "/dashboard?tags=a%20b&tags=c&flag",
      ],
    );
  });

  it("keeps the page mounted when a navigation only changes the query or hash", async (context) => {
    const { app, runtime } = application("first");
    runtime.route.path = "/data";
    runtime.route.fullPath = "/data";
    runtime.route.query = {};
    const visits = recordVisits(context);
    const navigation = app.runWithContext(useDmsRouter);
    await navigation.replace({ query: { table: "tags" } });
    await navigation.push("/data#rows");
    await navigation.push("/schemas");
    await navigation.push(
      { query: { table: "posts" } },
      { preserveState: false },
    );
    assert.deepEqual(visits, [
      {
        kind: "replace",
        url: "/data?table=tags",
        preserveState: true,
        preserveScroll: true,
      },
      {
        kind: "push",
        url: "/data#rows",
        preserveState: true,
        preserveScroll: true,
      },
      {
        kind: "server",
        url: "/schemas",
        preserveState: false,
        preserveScroll: false,
      },
      {
        kind: "push",
        url: "/data?table=posts",
        preserveState: false,
        preserveScroll: true,
      },
    ]);
  });

  it("asks the server for a query-only navigation it alone can honour", async (context) => {
    const { app, runtime } = application("first");
    Object.assign(runtime.route, { path: "/data", fullPath: "/data" });
    const visits = recordVisits(context);
    const navigation = app.runWithContext(useDmsRouter);
    await navigation.push({ query: { a: "1" } }, { only: ["page"] });
    await navigation.push({ query: { a: "2" } }, { onStart: () => {} });
    await navigation.push({ query: { a: "3" } }, { headers: { x: "y" } });
    runtime.currentError.value = new Error("shown");
    await navigation.push({ query: { a: "4" } });
    runtime.currentError.value = null;
    runtime.pageKey = "error:/data";
    await navigation.push({ query: { a: "5" } });
    assert.deepEqual(
      visits.map(({ kind, url }) => `${kind} ${url}`),
      [
        "server /data?a=1",
        "server /data?a=2",
        "server /data?a=3",
        "server /data?a=4",
        "server /data?a=5",
      ],
    );
  });

  it("keeps the callbacks of a query-only navigation that stays in the browser", async (context) => {
    const { app, runtime } = application("first");
    Object.assign(runtime.route, { path: "/data", fullPath: "/data" });
    recordVisits(context);
    const seen: string[] = [];
    context.mock.method(router, "push", (params) => {
      params.onSuccess?.({ url: params.url });
      params.onFinish?.(params);
    });
    await app.runWithContext(() =>
      navigateDms(
        { query: { tab: "b" } },
        {
          onSuccess: (page) => seen.push(`success ${page.url}`),
          onFinish: () => seen.push("finish"),
        },
      ),
    );
    assert.deepEqual(seen, ["success /data?tab=b", "finish"]);
  });
});

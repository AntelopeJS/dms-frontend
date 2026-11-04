import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { router } from "@inertiajs/vue3";
import {
  type DmsPageProps,
  hydrateDmsPageProps,
  keepSharedOverHistory,
  navigateDms,
  serializeDmsAsyncData,
  useDmsAsyncData,
  useDmsError,
  useDmsRuntimeHooks,
  useDmsState,
  useDmsFetch,
  useDmsUserSession,
} from "../templates/vue/frontend-module.ts";
import {
  application,
  registerGlobalMiddleware,
} from "./fixtures/vue-runtime.mts";

type PopstateListener = (event: Pick<PopStateEvent, "state">) => void;

type NavigateListener = (event: {
  detail: { page: { props: Pick<DmsPageProps, "path" | "shared"> } };
}) => void;

describe("Vue request runtime", () => {
  it("copies a site layout into the state once, whatever the pages that carry it", () => {
    const { app, runtime } = application("first");
    const shared = { isOwner: true, modules: ["first"], quickActions: [] };
    const state = (key: string) => runtime.sharedState.get(key)?.value;
    app.runWithContext(() => {
      hydrateDmsPageProps({ path: "/one", page: {}, shared });
      useDmsState("dms-modules").value = ["refreshed"];
      useDmsState("dms-lastRefreshTime").value = 1;
      hydrateDmsPageProps({ path: "/two", page: {}, shared });
      hydrateDmsPageProps({ path: "/three", page: {} });
    });
    assert.deepEqual(state("dms-modules"), ["refreshed"]);
    assert.equal(state("dms-lastRefreshTime"), 1);
    app.runWithContext(() =>
      hydrateDmsPageProps({
        path: "/four",
        page: {},
        shared: { isOwner: false, modules: ["second"], quickActions: [] },
      }),
    );
    assert.deepEqual(state("dms-modules"), ["second"]);
    assert.equal(state("dms-isOwner"), false);
    assert.notEqual(state("dms-lastRefreshTime"), 1);
  });

  it("keeps the newest site layout when Back puts an older page back", (context) => {
    const { app, runtime } = application("first");
    const listeners = new Map<string, PopstateListener>();
    const hadWindow = "window" in globalThis;
    Reflect.set(globalThis, "window", {
      addEventListener: (type: string, listener: PopstateListener) =>
        listeners.set(type, listener),
      removeEventListener: (type: string) => listeners.delete(type),
    });
    let onNavigate: NavigateListener | undefined;
    context.mock.method(
      router,
      "on",
      (type: string, callback: NavigateListener) => {
        if (type === "navigate") onNavigate = callback;
        return () => {};
      },
    );
    const replaced: unknown[] = [];
    context.mock.method(router, "replaceProp", (name: string, value) =>
      replaced.push([name, value]),
    );
    try {
      const older = { isOwner: false, modules: ["older"], quickActions: [] };
      const newer = { isOwner: false, modules: ["newer"], quickActions: [] };
      app.runWithContext(() => {
        keepSharedOverHistory();
        hydrateDmsPageProps({ path: "/one", page: {}, shared: newer });
      });
      listeners.get("popstate")?.({ state: { page: {} } });
      app.runWithContext(() =>
        hydrateDmsPageProps({ path: "/zero", page: {}, shared: older }),
      );
      onNavigate?.({
        detail: { page: { props: { path: "/zero", shared: older } } },
      });
      assert.deepEqual(runtime.sharedState.get("dms-modules")?.value, [
        "newer",
      ]);
      assert.deepEqual(replaced, [["shared", newer]]);
      const fresh = { isOwner: true, modules: ["fresh"], quickActions: [] };
      app.runWithContext(() =>
        hydrateDmsPageProps({ path: "/two", page: {}, shared: fresh }),
      );
      assert.deepEqual(runtime.sharedState.get("dms-modules")?.value, [
        "fresh",
      ]);
    } finally {
      if (!hadWindow) Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("forgets prefetched pages when the session becomes another one", async (context) => {
    const { app } = application("first");
    const flushes = context.mock.method(router, "flushAll", () => {});
    const sessions = [
      { session: { accountId: "a", activeTenantId: "t1" } },
      { session: { accountId: "a", activeTenantId: "t1", updatedAt: 2 } },
      { session: { accountId: "a", activeTenantId: "t2" } },
      { session: { accountId: "b", activeTenantId: "t2" } },
    ];
    context.mock.method(globalThis, "fetch", async () =>
      Response.json(sessions.shift() ?? {}),
    );
    const hadWindow = "window" in globalThis;
    Reflect.set(globalThis, "window", globalThis);
    try {
      const session = app.runWithContext(useDmsUserSession);
      const counts: number[] = [];
      for (let index = 0; index < 4; index++) {
        await session.fetch();
        counts.push(flushes.mock.callCount());
      }
      await session.clear();
      counts.push(flushes.mock.callCount());
      assert.deepEqual(counts, [1, 1, 2, 3, 4]);
    } finally {
      if (!hadWindow) Reflect.deleteProperty(globalThis, "window");
    }
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
    const transferred = serializeDmsAsyncData(first.runtime);
    assert.equal(transferred["same-key"], "first");
    assert.deepEqual(new Set(Object.values(transferred)), new Set(["first"]));
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
        },
        shared: {
          isOwner: true,
          modules: ["private"],
          quickActions: ["delete"],
        },
      });
      hydrateDmsPageProps({
        path: "/two",
        page: {
          route: { layoutUrl: "/public-layout" },
          layout: { componentName: "PublicLayout" },
        },
        shared: { isOwner: false, modules: [], quickActions: [] },
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
    const capturedErrors = new Map<string, ReturnType<typeof useDmsError>>();
    await registerGlobalMiddleware(
      async () => {
        await Promise.resolve();
      },
      (to) => {
        capturedErrors.set(to.path, useDmsError());
        return false;
      },
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

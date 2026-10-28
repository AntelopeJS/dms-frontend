import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import { createI18n } from "vue-i18n";
import {
  type Component,
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  isShallow,
  nextTick,
  ref,
} from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const {
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  provideDmsFrontendRuntime,
  useDmsAsyncData,
} = runtimeModule;

type Runtime = ReturnType<typeof createDmsFrontendRuntime>;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function clientApp(runtime: Runtime = createDmsFrontendRuntime()) {
  const app = createSSRApp({ render: () => null });
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime };
}

function serverRender(root: Component, prepare?: (runtime: Runtime) => void) {
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  prepare?.(runtime);
  const app = createSSRApp(root);
  provideDmsFrontendRuntime(app, runtime);
  return { runtime, render: () => renderToString(app) };
}

/** Mounts components without a DOM, the way the browser runtime runs them. */
function mountRuntime(runtime: Runtime, root: Component) {
  interface Node {
    parent: Node | null;
    children: Node[];
  }
  const node = (): Node => ({ parent: null, children: [] });
  const renderer = createRenderer<Node, Node>({
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
      if (!child.parent) return;
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

/** A component showing `key`, which a ref mounts and unmounts. */
function toggled(key: string, handler: () => Promise<string>) {
  const visible = ref(true);
  const shown: string[] = [];
  const Consumer = defineComponent({
    setup() {
      const { data, status } = useDmsAsyncData(key, handler);
      return () => {
        shown.push(`${status.value}:${String(data.value)}`);
        return h("p");
      };
    },
  });
  return {
    visible,
    shown,
    root: { render: () => (visible.value ? h(Consumer) : null) },
  };
}

describe("Stale while revalidate", () => {
  it("shows the data at once on a remount, and reads it again in the background", async () => {
    let calls = 0;
    const answers: Array<ReturnType<typeof deferred<string>>> = [];
    const { visible, shown, root } = toggled("banner", () => {
      calls++;
      const answer = deferred<string>();
      answers.push(answer);
      return answer.promise;
    });
    const app = mountRuntime(createDmsFrontendRuntime(), root);
    answers[0].resolve("3 seats");
    await settle();
    visible.value = false;
    await nextTick();
    shown.length = 0;

    visible.value = true;
    await nextTick();
    assert.equal(shown[0], "pending:3 seats", "the cached data, at once");
    assert.equal(calls, 2);
    answers[1].resolve("4 seats");
    await settle();
    assert.equal(shown.at(-1), "success:4 seats");
    app.unmount();
  });

  it("spares a caller joining data another one has just read a second read", async () => {
    let calls = 0;
    const second = ref(false);
    const Reader = defineComponent({
      setup() {
        const { data } = useDmsAsyncData("security", async () => {
          calls++;
          return "summary";
        });
        return () => h("p", String(data.value));
      },
    });
    const app = mountRuntime(createDmsFrontendRuntime(), {
      render: () => h("div", [h(Reader), second.value ? h(Reader) : null]),
    });
    await settle();
    assert.equal(calls, 1);
    second.value = true;
    await nextTick();
    await settle();
    assert.equal(calls, 1, "no second read for a caller joining at once");
    app.unmount();
  });

  it("does not hold an awaiting caller for data it already has", async () => {
    const { app } = clientApp();
    const first = await app.runWithContext(() =>
      useDmsAsyncData("held", async () => "first"),
    );
    assert.equal(first.data.value, "first");
    const never = new Promise<string>(() => {});
    let resumed = false;
    void app
      .runWithContext(() => useDmsAsyncData("held", () => never))
      .then(() => (resumed = true));
    await settle();
    assert.equal(resumed, true);
    assert.equal(
      first.status.value,
      "success",
      "not read again: the first caller has just read it",
    );
    assert.equal(first.data.value, "first");
  });

  it("does not read again while the page the server rendered hydrates", async () => {
    let calls = 0;
    const runtime = createDmsFrontendRuntime(undefined, { hydrated: "server" });
    const { visible, root } = toggled("hydrated", async () => {
      calls++;
      return "browser";
    });
    const app = mountRuntime(runtime, root);
    visible.value = false;
    await nextTick();
    visible.value = true;
    await nextTick();
    await settle();
    assert.equal(calls, 0);
    app.unmount();
  });
});

describe("Async data failures and keys", () => {
  it("keeps the failure until the next answer, and the data of the last success", async () => {
    const { app } = clientApp();
    const answers: Array<ReturnType<typeof deferred<string>>> = [];
    const entry = app.runWithContext(() =>
      useDmsAsyncData("kept-error", () => {
        const answer = deferred<string>();
        answers.push(answer);
        return answer.promise;
      }),
    );
    answers[0].resolve("rows");
    await settle();
    void entry.refresh();
    answers[1].reject(new Error("down"));
    await settle();
    assert.equal(entry.status.value, "error");
    assert.equal(entry.data.value, "rows");

    void entry.refresh();
    assert.equal(entry.status.value, "pending");
    assert.equal((entry.error.value as Error).message, "down", "still shown");
    answers[2].resolve("rows again");
    await settle();
    assert.equal(entry.error.value, null);
    assert.equal(entry.data.value, "rows again");
  });

  it("names its key, and hands it to transform", async () => {
    const { app } = clientApp();
    const seen: unknown[] = [];
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("named", async () => 2, {
        transform: (value, context) => {
          seen.push(context);
          return (value as number) * 10;
        },
      }),
    );
    assert.equal(entry.key.value, "named");
    assert.equal(entry.data.value, 20);
    assert.deepEqual(seen, [{ key: "named" }]);
  });

  it("hands useDmsFetch's transform the key and the URL the answer is for", async () => {
    const { app } = clientApp();
    const seen: unknown[] = [];
    const entry = await app.runWithContext(() =>
      runtimeModule.useDmsFetch<string>("/api/items", {
        $fetch: (async () => "raw") as never,
        transform: (value, context) => {
          seen.push(context);
          return `${String(value)}!`;
        },
      }),
    );
    assert.equal(entry.data.value, "raw!");
    assert.deepEqual(seen, [{ key: entry.key.value, url: "/api/items" }]);
    assert.match(String(entry.key.value), /^\$dmsfetch:/);
  });

  it("tracks the replacement of the whole value only, unless deep", async () => {
    const { app } = clientApp();
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("shallow-default", async () => ({ rows: [1] })),
    );
    assert.equal(isShallow(entry.data), true);
  });
});

describe("Page refresh", () => {
  it("reads again the data on screen, but what opted out or waits for execute()", async () => {
    const calls: string[] = [];
    const handler = (name: string) => async () => {
      calls.push(name);
      return name;
    };
    const Page = defineComponent({
      setup() {
        useDmsAsyncData("kpi", handler("kpi"));
        useDmsAsyncData("menu", handler("menu"), {
          refreshOnPageRefresh: false,
        });
        useDmsAsyncData("dialog", handler("dialog"), { immediate: false });
        return () => h("p");
      },
    });
    const runtime = createDmsFrontendRuntime();
    const app = mountRuntime(runtime, { render: () => h(Page) });
    await settle();
    assert.deepEqual(calls, ["kpi", "menu"]);

    await app.runWithContext(() => runtimeModule.refreshDmsPageData());
    assert.deepEqual(calls, ["kpi", "menu", "kpi"]);
    app.unmount();
    await app.runWithContext(() => runtimeModule.refreshDmsPageData());
    assert.deepEqual(calls, ["kpi", "menu", "kpi"], "nothing off screen");
  });

  it("loads a dialog's data on execute(), then keeps it in step", async () => {
    const { app } = clientApp();
    let calls = 0;
    const entry = app.runWithContext(() =>
      useDmsAsyncData("drawer", async () => ++calls, { immediate: false }),
    );
    await settle();
    assert.equal(calls, 0);
    await entry.execute();
    assert.equal(entry.data.value, 1);
    await app.runWithContext(() => runtimeModule.refreshDmsPageData());
    assert.equal(entry.data.value, 2);
  });

  it("reads again on an interval while shown", async () => {
    let calls = 0;
    const visible = ref(true);
    const Poller = defineComponent({
      setup() {
        useDmsAsyncData("polled", async () => ++calls, { refreshInterval: 10 });
        return () => h("p");
      },
    });
    const app = mountRuntime(createDmsFrontendRuntime(), {
      render: () => (visible.value ? h(Poller) : null),
    });
    await sleep(45);
    const polled = calls;
    assert.ok(polled >= 3, `read ${polled} times`);
    visible.value = false;
    await nextTick();
    await sleep(30);
    assert.equal(calls, polled, "no read once unmounted");
    app.unmount();
  });
});

describe("Async data scope", () => {
  it("keeps the same key of two scopes apart, and drops the data on a change", async () => {
    const { app, runtime } = clientApp();
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-a"));
    const first = await app.runWithContext(() =>
      useDmsAsyncData("plan", async () => "plan of a"),
    );
    assert.equal(first.data.value, "plan of a");
    assert.deepEqual([...runtime.asyncData.keys()], ["account-a|plan"]);

    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    assert.equal(runtime.asyncData.size, 0);
    assert.equal(first.data.value, null, "the other account's data is gone");
    const second = await app.runWithContext(() =>
      useDmsAsyncData("plan", async () => "plan of b"),
    );
    assert.equal(second.data.value, "plan of b");
    await app.runWithContext(() => runtimeModule.refreshDmsData("plan"));
    assert.deepEqual([...runtime.asyncData.keys()], ["account-b|plan"]);
  });

  it("finds the data the server transferred under the same scope", async () => {
    const Plan = defineComponent({
      setup() {
        const { data } = useDmsAsyncData("plan", async () => "server plan");
        return () => h("p", String(data.value));
      },
    });
    const { runtime: server, render } = serverRender(Plan, (runtime) => {
      runtime.asyncDataScope = "tenant-1";
    });
    assert.equal(await render(), "<p>server plan</p>");
    const payload = runtimeModule.serializeDmsPayload(server);
    assert.deepEqual(Object.keys(payload.data), ["tenant-1|plan"]);

    const browser = createDmsFrontendRuntime();
    runtimeModule.restoreDmsPayload(browser, payload);
    const { app } = clientApp(browser);
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("tenant-1"));
    let calls = 0;
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("plan", async () => {
        calls++;
        return "browser plan";
      }),
    );
    assert.equal(calls, 0);
    assert.equal(entry.data.value, "server plan");
  });
});

describe("Plugin order", () => {
  it("sets the scope from a pre plugin before another module's plugin reads", async () => {
    const reads: Array<{ data: { value: unknown } }> = [];
    await runtimeModule.setupFrontendModules([
      {
        options: { public: {} },
        module: {
          setup(sdk) {
            sdk.registerPlugin(() => {
              reads.push(
                useDmsAsyncData("sidecar-info", async () => {
                  await sleep(5);
                  return "running";
                }),
              );
            });
          },
        },
      },
      {
        options: { public: {} },
        module: {
          setup(sdk) {
            sdk.registerPlugin(
              () => runtimeModule.setDmsAsyncDataScope("account-a"),
              { enforce: "pre" },
            );
            sdk.registerPlugin(() => {}, { enforce: "post" });
          },
        },
      },
    ]);
    try {
      const { app, runtime } = clientApp();
      const i18n = createI18n({ legacy: false, locale: "en", messages: {} });
      await runtimeModule.installDmsPlugins(
        app,
        i18n.global,
        runtime,
        async () => ({}),
        ["en"],
      );
      await sleep(20);
      assert.equal(reads.length, 1);
      assert.equal(reads[0].data.value, "running", "the read was not aborted");
      assert.deepEqual(
        [...runtime.asyncData.keys()],
        ["account-a|sidecar-info"],
      );
    } finally {
      await runtimeModule.setupFrontendModules([]);
    }
  });
});

describe("Async data a server cannot transfer", () => {
  it("leaves a call without a key to the browser, rendering its default", async () => {
    let calls = 0;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(message);
    try {
      const Keyless = defineComponent({
        setup() {
          const { data } = useDmsAsyncData(
            async () => {
              calls++;
              return "server";
            },
            undefined,
            { default: () => "default" },
          );
          return () => h("p", String(data.value));
        },
      });
      const { render } = serverRender(Keyless, (runtime) => {
        runtime.devWarnings = true;
      });
      assert.equal(await render(), "<p>default</p>");
      assert.equal(calls, 0);
      assert.match(String(warnings[0]), /without a key/);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("warns in development about a backend read outside async data", async () => {
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (message: unknown) => warnings.push(message);
    let inHandler = false;
    try {
      const Watcher = defineComponent({
        async setup() {
          const transferred = useDmsAsyncData("transferred", () =>
            runtimeModule.$fetch<string>("/api/transferred"),
          );
          await runtimeModule.$fetch("/api/watched");
          const { data } = await transferred;
          return () => h("p", String(data.value));
        },
      });
      const { render } = serverRender(Watcher, (runtime) => {
        runtime.serverFetch = (async (url: string) => url) as never;
        runtime.devWarnings = true;
        runtime.runAsyncDataHandler = (run) => {
          inHandler = true;
          try {
            return run();
          } finally {
            inHandler = false;
          }
        };
        runtime.inAsyncDataHandler = () => inHandler;
      });
      assert.equal(await render(), "<p>/api/transferred</p>");
      assert.equal(warnings.length, 1);
      assert.match(
        String(warnings[0]),
        /\/api\/watched was read during a server render/,
      );
      assert.match(
        String(warnings[0]),
        /unless the code hands the answer over \(useDmsState with transfer: true\)/,
      );
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("Async data on a later page", () => {
  it("keeps showing a key loaded on an earlier page, read again, after a navigation", async () => {
    let value = "v1";
    let calls = 0;
    const { visible, shown, root } = toggled("A", async () => {
      calls++;
      return value;
    });
    const runtime = createDmsFrontendRuntime();
    const app = mountRuntime(runtime, root);
    await settle();
    visible.value = false;
    await nextTick();
    app.runWithContext(() => hydrateDmsPageProps({ path: "/b", page: {} }));
    app.runWithContext(() => hydrateDmsPageProps({ path: "/a", page: {} }));
    value = "v2";
    shown.length = 0;
    visible.value = true;
    await nextTick();
    assert.equal(shown[0], "pending:v1");
    await settle();
    assert.equal(shown.at(-1), "success:v2");
    assert.equal(calls, 2);
    app.unmount();
  });
});

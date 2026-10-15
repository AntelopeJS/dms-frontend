import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import {
  type Component,
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  isRef,
  isShallow,
  nextTick,
  ref,
  computed,
  Suspense,
  useId,
  watch,
} from "vue";
import { createI18n } from "vue-i18n";
// The module namespace rather than named imports: a name the runtime does not
// export yet fails the test that uses it, not the whole file.
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const {
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  installDmsPlugins,
  provideDmsFrontendRuntime,
  serializeDmsAsyncData,
  setupFrontendModules,
  useDmsAsyncData,
  useDmsLazyAsyncData,
} = runtimeModule;

type Runtime = ReturnType<typeof createDmsFrontendRuntime>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = () => new Promise((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function serverRender(root: Component) {
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  const app = createSSRApp(root);
  provideDmsFrontendRuntime(app, runtime);
  return { runtime, render: () => renderToString(app) };
}

function clientApp(runtime: Runtime = createDmsFrontendRuntime()) {
  const app = createSSRApp({ render: () => null });
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime };
}

// Mounts components without a DOM, the way the browser runtime runs them.
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

describe("Async data in a server render", () => {
  it("awaits lazy data before rendering it, so the HTML shows what the payload carries (E2)", async () => {
    const Lazy = defineComponent({
      setup() {
        const { data, status } = useDmsLazyAsyncData("e2", async () => {
          await sleep(1);
          return "fresh";
        });
        return () => h("p", `${status.value}:${String(data.value)}`);
      },
    });
    const Slow = defineComponent({
      async setup() {
        await sleep(30);
        return () => h("p", "slow sibling");
      },
    });
    const { runtime, render } = serverRender({
      render: () => h("div", [h(Lazy), h(Slow)]),
    });

    assert.equal(
      await render(),
      "<div><p>success:fresh</p><p>slow sibling</p></div>",
    );
    assert.deepEqual(serializeDmsAsyncData(runtime), { e2: "fresh" });
  });

  it("leaves server: false data to the browser (E4)", async () => {
    let calls = 0;
    const Root = defineComponent({
      async setup() {
        const { data, status } = await useDmsAsyncData(
          "e4",
          async () => {
            calls++;
            return "server ran it";
          },
          { server: false, default: () => "default" },
        );
        return () => h("p", `${status.value}:${String(data.value)}`);
      },
    });
    const { runtime, render } = serverRender(Root);

    assert.equal(await render(), "<p>idle:default</p>");
    assert.equal(calls, 0);
    assert.deepEqual(serializeDmsAsyncData(runtime), {});
  });

  it("fetches the keys of one setup in parallel when it does not await them (E6)", async () => {
    const started: string[] = [];
    const gates = { a: deferred<string>(), b: deferred<string>() };
    const load = (name: "a" | "b") =>
      useDmsAsyncData(`e6-${name}`, () => {
        started.push(name);
        return gates[name].promise;
      });
    const Root = defineComponent({
      setup() {
        const a = load("a");
        const b = load("b");
        return () => h("p", `${a.data.value}+${b.data.value}`);
      },
    });
    const { render } = serverRender(Root);

    const rendering = render();
    await settle();
    // The second request leaves before the first one answers: no waterfall.
    assert.deepEqual(started, ["a", "b"]);
    gates.b.resolve("B");
    gates.a.resolve("A");
    assert.equal(await rendering, "<p>A+B</p>");
  });

  it("still holds a server render for lazy data its setup awaits", async () => {
    const Root = defineComponent({
      async setup() {
        const { data } = await useDmsAsyncData(
          "awaited-lazy",
          async () => {
            await sleep(5);
            return "loaded";
          },
          { lazy: true },
        );
        const seen = String(data.value);
        return () => h("p", seen);
      },
    });
    const { render } = serverRender(Root);

    assert.equal(await render(), "<p>loaded</p>");
  });

  it("renders the data plugins start before the page, with one request when a plugin refreshes it at once", async () => {
    let calls = 0;
    const handler = (ms: number) => async () => {
      const call = ++calls;
      await sleep(ms);
      return `state ${call}`;
    };
    await setupFrontendModules([
      {
        options: { public: {} },
        module: {
          setup(sdk) {
            // Started, never awaited, and slower than everything after it: the
            // render must wait for it all the same.
            sdk.registerPlugin(() => {
              useDmsLazyAsyncData("plugin-lazy", handler(40));
            });
            // The DMS seo plugin: a lazy key, then an explicit refresh in the
            // same turn, which replaces the scheduled first run.
            sdk.registerPlugin(async () => {
              const entry = useDmsLazyAsyncData("plugin-refreshed", handler(5));
              if (!entry.data.value) await entry.refresh();
            });
          },
        },
      },
    ]);
    const runtime = createDmsFrontendRuntime(undefined, {}, true);
    const app = createSSRApp({ render: () => null });
    provideDmsFrontendRuntime(app, runtime);
    const i18n = createI18n({ legacy: false, locale: "en", messages: {} });

    await installDmsPlugins(app, i18n.global, runtime, async () => ({}), [
      "en",
    ]);

    assert.equal(calls, 2);
    assert.deepEqual(serializeDmsAsyncData(runtime), {
      "plugin-lazy": "state 1",
      "plugin-refreshed": "state 2",
    });
    await setupFrontendModules([]);
  });

  it("gives the components after a non-awaited key the same ids in the browser", async () => {
    const ids = new Map<string, string>();
    const Child = defineComponent({
      props: { label: { type: String, required: true } },
      setup(props) {
        const id = useId();
        ids.set(props.label, id);
        return () => h("i", id);
      },
    });
    const Parent = defineComponent({
      setup() {
        useDmsAsyncData("ids", async () => "value");
        return () => h(Child, { label: "inside" });
      },
    });
    const Root = {
      render: () => h("div", [h(Parent), h(Child, { label: "after" })]),
    };
    const { render } = serverRender(Root);
    await render();
    const serverIds = Object.fromEntries(ids);
    ids.clear();

    const app = mountRuntime(
      createDmsFrontendRuntime(undefined, { ids: "value" }),
      Root,
    );
    await settle();
    app.unmount();

    assert.deepEqual(Object.fromEntries(ids), serverIds);
  });
});

describe("Async data in the browser", () => {
  it("hands a hydrating component the server's data when the server's render had it", async () => {
    const rendered: string[] = [];
    // Selects the first schema once there is one, as the dms-database schemas
    // page does: on the server, the watcher runs once, before the data is in.
    const Selection = defineComponent({
      setup() {
        const { data } = useDmsAsyncData("schemas", async () => ["demo"]);
        const selected = ref<string | null>(null);
        watch(
          data,
          (list) => {
            if (!selected.value && list?.[0]) selected.value = list[0];
          },
          { immediate: true },
        );
        return () => {
          const text = `${selected.value ?? "none"}:${String(data.value)}`;
          rendered.push(text);
          return h("p", text);
        };
      },
    });
    const { runtime: server, render } = serverRender(Selection);
    assert.equal(await render(), "<p>none:demo</p>");
    rendered.length = 0;

    const app = mountRuntime(
      createDmsFrontendRuntime(undefined, serializeDmsAsyncData(server)),
      { render: () => h(Selection) },
    );
    assert.equal(rendered[0], "none:demo", "hydration matches the HTML");
    await settle();
    assert.equal(rendered.at(-1), "demo:demo", "then the watcher catches up");
    app.unmount();
  });

  it("hands an awaiting setup the server's data once it resumes", async () => {
    let seen: unknown;
    const Awaiting = defineComponent({
      async setup() {
        const { data } = await useDmsAsyncData("awaited", async () => "late");
        seen = data.value;
        return () => h("p");
      },
    });
    const app = mountRuntime(
      createDmsFrontendRuntime(undefined, { awaited: "server value" }),
      { render: () => h(Suspense, null, { default: () => h(Awaiting) }) },
    );
    await settle();
    app.unmount();

    assert.equal(seen, "server value");
  });

  it("returns refs usable at once, and the same ones once awaited", async () => {
    const { app } = clientApp();

    const result = app.runWithContext(() =>
      useDmsAsyncData("both", async () => "value"),
    );

    assert.ok(isRef(result.data), "the refs exist before any await");
    const awaited = await result;
    assert.equal(awaited.data, result.data);
    assert.equal(awaited.data.value, "value");
  });

  it("does not hold a navigation for lazy data (E3)", async () => {
    const { app } = clientApp();
    const answer = deferred<string>();
    let awaited = false;

    const result = app.runWithContext(() =>
      useDmsAsyncData("e3", () => answer.promise, { lazy: true }),
    );
    void Promise.resolve(result).then(() => {
      awaited = true;
    });
    await settle();

    assert.equal(awaited, true, "awaiting lazy data must not wait for it");
    assert.equal(result.status.value, "pending");
    answer.resolve("loaded");
    await settle();
    assert.equal(result.data.value, "loaded");
    assert.equal(result.status.value, "success");
  });

  it("fetches server: false data once its hydrated component is mounted", async () => {
    const runtime = createDmsFrontendRuntime(undefined, { other: 1 });
    const rendered: string[] = [];
    let calls = 0;
    const Consumer = defineComponent({
      setup() {
        const { data, status } = useDmsAsyncData(
          "client-only",
          async () => {
            calls++;
            return "browser value";
          },
          { server: false, default: () => "default" },
        );
        return () => {
          rendered.push(`${status.value}:${String(data.value)}`);
          return h("p");
        };
      },
    });

    const app = mountRuntime(runtime, { render: () => h(Consumer) });
    // The first render must match the server's HTML, which showed the default.
    assert.equal(rendered[0], "idle:default");
    await settle();
    await nextTick();
    app.unmount();

    assert.equal(calls, 1);
    assert.equal(rendered.at(-1), "success:browser value");
  });

  it("hands the handler a signal a newer run aborts, unless it defers to the run in flight", async () => {
    const { app } = clientApp();
    const signals: AbortSignal[] = [];
    const answers: Array<ReturnType<typeof deferred<string>>> = [];
    const entry = app.runWithContext(() =>
      useDmsAsyncData("signal", ({ signal }) => {
        signals.push(signal);
        const answer = deferred<string>();
        answers.push(answer);
        return answer.promise;
      }),
    );

    void entry.refresh();
    assert.equal(signals.length, 2);
    assert.equal(signals[0].aborted, true, "a newer run cancels the old one");
    assert.equal(signals[1].aborted, false);
    answers[1].resolve("current");
    answers[0].resolve("superseded");
    await settle();
    assert.equal(entry.data.value, "current");

    void entry.refresh();
    void entry.refresh({ dedupe: "defer" });
    assert.equal(signals.length, 3, "defer waits for the run in flight");
    answers[2].resolve("deferred");
    await settle();
    assert.equal(entry.data.value, "deferred");
  });

  it("aborts a run once the last component showing its key unmounts", async () => {
    const runtime = createDmsFrontendRuntime();
    const signals: AbortSignal[] = [];
    const first = ref(true);
    const second = ref(true);
    const Consumer = defineComponent({
      setup() {
        useDmsAsyncData(
          "shared-run",
          ({ signal }) => {
            signals.push(signal);
            return new Promise<string>(() => {});
          },
          { lazy: true },
        );
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, {
      render: () =>
        h("div", [
          first.value ? h(Consumer) : null,
          second.value ? h(Consumer) : null,
        ]),
    });
    await settle();
    assert.equal(signals.length, 1, "both components share one run");

    first.value = false;
    await nextTick();
    assert.equal(signals[0].aborted, false, "another component still shows it");
    second.value = false;
    await nextTick();
    assert.equal(signals[0].aborted, true);
    assert.equal(runtime.asyncData.get("shared-run")?.status.value, "idle");
    app.unmount();
  });

  it("drops, at the next navigation, the data no component shows any more", async () => {
    const runtime = createDmsFrontendRuntime();
    const visible = ref(true);
    const Consumer = (key: string) =>
      defineComponent({
        setup() {
          useDmsAsyncData(key, async () => key);
          return () => h("p");
        },
      });
    const Kept = Consumer("kept");
    const Dropped = Consumer("dropped");
    const app = mountRuntime(runtime, {
      render: () => h("div", [h(Kept), visible.value ? h(Dropped) : null]),
    });
    await settle();
    visible.value = false;
    await nextTick();
    assert.ok(
      runtime.asyncData.has("dropped"),
      "the page still on screen may show it again",
    );

    app.runWithContext(() => hydrateDmsPageProps({ path: "/next", page: {} }));

    assert.equal(runtime.asyncData.has("dropped"), false);
    assert.ok(runtime.asyncData.has("kept"));
    app.unmount();
  });

  it("reads the data again when a component asking for it mounts again, before it renders", async () => {
    const runtime = createDmsFrontendRuntime();
    const open = ref(true);
    const calls = { fresh: 0, kept: 0 };
    const seen: string[] = [];
    const Drawer = (name: "fresh" | "kept") =>
      defineComponent({
        async setup() {
          const { data } = await useDmsAsyncData(
            `drawer-${name}`,
            async () => {
              await sleep(1);
              return `${name} ${++calls[name]}`;
            },
            { refreshOnMount: name === "fresh" },
          );
          seen.push(String(data.value));
          return () => h("p");
        },
      });
    const Fresh = Drawer("fresh");
    const Kept = Drawer("kept");
    const app = mountRuntime(runtime, {
      render: () =>
        h(Suspense, null, {
          default: () => h("div", open.value ? [h(Fresh), h(Kept)] : []),
        }),
    });
    await sleep(20);
    assert.deepEqual(seen, ["fresh 1", "kept 1"]);

    open.value = false;
    await nextTick();
    open.value = true;
    await sleep(20);

    assert.deepEqual(calls, { fresh: 2, kept: 1 });
    assert.deepEqual(
      seen.slice(2).sort(),
      ["fresh 2", "kept 1"],
      "the setup awaits the new read, not the data shown before",
    );
    app.unmount();
  });

  it("does not read again on mount what the server rendered, nor what another caller is reading", async () => {
    let calls = 0;
    const Shared = defineComponent({
      setup() {
        const { data } = useDmsAsyncData(
          "mounted-twice",
          async () => {
            await sleep(1);
            return `read ${++calls}`;
          },
          { refreshOnMount: true },
        );
        return () => h("p", String(data.value));
      },
    });
    const Page = { render: () => h("div", [h(Shared), h(Shared)]) };

    const { runtime: server, render } = serverRender(Page);
    assert.equal(await render(), "<div><p>read 1</p><p>read 1</p></div>");
    assert.equal(calls, 1, "the server reads it once");

    const app = mountRuntime(
      createDmsFrontendRuntime(undefined, serializeDmsAsyncData(server)),
      Page,
    );
    await sleep(20);
    assert.equal(calls, 1, "the hydration takes the server's data");
    app.unmount();

    const browser = mountRuntime(createDmsFrontendRuntime(), Page);
    await sleep(20);
    assert.equal(calls, 2, "two components mounting together share one read");
    browser.unmount();
  });

  it("forgets the server data no component claimed once hydration is over", async () => {
    const { app } = clientApp(
      createDmsFrontendRuntime(undefined, { unclaimed: "server value" }),
    );
    let calls = 0;

    app.runWithContext(() => runtimeModule.dmsPageSuspenseProps()).onResolve();
    await nextTick();
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("unclaimed", async () => {
        calls++;
        return "fresh";
      }),
    );

    assert.equal(calls, 1);
    assert.equal(entry.data.value, "fresh");
  });

  it("ends the hydration the tick the page suspense resolves, without showing the page as loading", async () => {
    const runtime = createDmsFrontendRuntime(undefined, {
      unclaimed: "server value",
    });
    const { app } = clientApp(runtime);
    const suspense = app.runWithContext(() =>
      runtimeModule.dmsPageSuspenseProps(),
    );

    // A hydrating suspense resolves without ever being pending.
    suspense.onResolve();
    assert.equal(
      runtime.hydrating,
      true,
      "the components after the page hydrate in the same tick",
    );
    assert.equal(runtime.pageLoading.value, false);
    await nextTick();
    assert.equal(runtime.hydrating, false);
    assert.equal(runtime.hydratedAsyncData.size, 0);
    assert.equal(runtime.pageLoading.value, false);
  });

  it("clears the data and aborts its run", async () => {
    const { app } = clientApp();
    let signal: AbortSignal | undefined;
    const entry = app.runWithContext(() =>
      useDmsAsyncData(
        "cleared",
        (context) => {
          signal = context.signal;
          return new Promise<string>(() => {});
        },
        { default: () => "empty" },
      ),
    );

    entry.clear();

    assert.equal(signal?.aborted, true);
    assert.equal(entry.data.value, "empty");
    assert.equal(entry.status.value, "idle");
  });

  it("keeps the data shallow on request", async () => {
    const { app } = clientApp();

    const [shallow, deep] = await Promise.all(
      [false, true].map((deep) =>
        app.runWithContext(() =>
          useDmsAsyncData(`deep-${deep}`, async () => ({ rows: [1] }), {
            deep,
          }),
        ),
      ),
    );

    assert.equal(isShallow(shallow.data), true);
    assert.equal(isShallow(deep.data), false);
  });
});

describe("Server payload", () => {
  const serverPayload = async (setup: () => () => ReturnType<typeof h>) => {
    const { runtime, render } = serverRender(defineComponent({ setup }));
    const html = await render();
    return { html, payload: runtimeModule.serializeDmsPayload(runtime) };
  };

  it("transfers a failed server run, so hydration does not run it again (E5)", async () => {
    const { html, payload } = await serverPayload(() => {
      const { status, error } = useDmsAsyncData("e5", async () => {
        throw runtimeModule.createError({
          statusCode: 404,
          statusMessage: "Not Found",
          message: "No such order",
          data: { message: "orders.not_found" },
        });
      });
      return () =>
        h(
          "p",
          `${status.value}:${(error.value as { statusCode?: number })?.statusCode}`,
        );
    });
    assert.equal(html, "<p>error:404</p>");
    assert.deepEqual(payload.errors, {
      e5: {
        statusCode: 404,
        statusMessage: "Not Found",
        message: "No such order",
        data: { message: "orders.not_found" },
      },
    });

    const runtime = createDmsFrontendRuntime();
    runtimeModule.restoreDmsPayload(runtime, payload);
    let calls = 0;
    const { app } = clientApp(runtime);
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("e5", async () => ++calls, { default: () => 0 }),
    );

    assert.equal(calls, 0);
    assert.equal(entry.status.value, "error");
    assert.equal(entry.data.value, 0, "the default the server rendered");
    assert.equal(
      (entry.error.value as { statusCode?: number }).statusCode,
      404,
    );
    assert.deepEqual((entry.error.value as { data?: unknown }).data, {
      message: "orders.not_found",
    });
  });

  it("keeps the backend's address out of a fetch error it transfers", async () => {
    const { payload } = await serverPayload(() => {
      useDmsAsyncData("fetch-error", async () => {
        throw Object.assign(
          new Error(
            '[GET] "http://10.0.0.5:5500/api/x": 503 Service Unavailable',
          ),
          {
            name: "FetchError",
            statusCode: 503,
            statusMessage: "Service Unavailable",
            data: "error.backend",
          },
        );
      });
      return () => h("p");
    });

    assert.deepEqual(payload.errors["fetch-error"], {
      statusCode: 503,
      statusMessage: "Service Unavailable",
      message: "Service Unavailable",
      data: "error.backend",
    });
  });

  it("transfers an unexpected failure as its status alone", async (context) => {
    context.mock.method(console, "error", () => {});
    const { payload } = await serverPayload(() => {
      useDmsAsyncData("unexpected", async () => {
        throw new Error("private database hostname");
      });
      return () => h("p");
    });

    assert.deepEqual(payload.errors, { unexpected: { statusCode: 500 } });
  });

  it("transfers only the state a key opts into (E5)", async () => {
    let browserInit = 0;
    const { payload } = await serverPayload(() => {
      runtimeModule.useDmsState("onboarding", () => ({ done: true }), {
        transfer: true,
      });
      runtimeModule.useDmsState("server-only", () => "not for the browser");
      return () => h("p");
    });
    assert.deepEqual(payload.state, { onboarding: { done: true } });

    const runtime = createDmsFrontendRuntime();
    runtimeModule.restoreDmsPayload(runtime, payload);
    const { app } = clientApp(runtime);
    const onboarding = app.runWithContext(() =>
      runtimeModule.useDmsState("onboarding", () => {
        browserInit++;
        return { done: false };
      }),
    );

    assert.equal(browserInit, 0, "the browser starts from the server's state");
    assert.deepEqual(onboarding.value, { done: true });
    assert.equal(runtime.hydrating, true);
  });
});

describe("useDmsFetch", () => {
  function fetchingRuntime(isServer: boolean) {
    const requests: Array<{ url: string; options: Record<string, unknown> }> =
      [];
    const runtime = createDmsFrontendRuntime(
      (async (url: string, options: Record<string, unknown> = {}) => {
        requests.push({ url, options });
        return `data:${url}`;
      }) as never,
      undefined,
      isServer,
    );
    return { runtime, requests };
  }

  it("renders and transfers a server response instead of discarding it (E1)", async () => {
    const { runtime, requests } = fetchingRuntime(true);
    const app = createSSRApp(
      defineComponent({
        setup() {
          const { data } = runtimeModule.useDmsFetch<string>("/api/e1");
          return () => h("p", String(data.value));
        },
      }),
    );
    provideDmsFrontendRuntime(app, runtime);

    assert.equal(await renderToString(app), "<p>data:/api/e1</p>");
    assert.deepEqual(
      requests.map(({ url }) => url),
      ["/api/e1"],
    );
    const payload = runtimeModule.serializeDmsPayload(runtime);
    assert.deepEqual(Object.values(payload.data), ["data:/api/e1"]);

    const browser = fetchingRuntime(false);
    runtimeModule.restoreDmsPayload(browser.runtime, payload);
    const { app: client } = clientApp(browser.runtime);
    const hydrated = await client.runWithContext(() =>
      runtimeModule.useDmsFetch<string>("/api/e1"),
    );
    assert.equal(hydrated.data.value, "data:/api/e1");
    assert.deepEqual(browser.requests, [], "hydration does not fetch again");
  });

  it("shares one request per method, URL, query and body, whatever the headers", async () => {
    const { runtime, requests } = fetchingRuntime(false);
    const { app } = clientApp(runtime);
    const load = (url: string, options = {}) =>
      app.runWithContext(() => runtimeModule.useDmsFetch(url, options));

    await Promise.all([
      load("/api/list", { query: { page: 1, sort: "name" } }),
      load("/api/list", {
        query: { sort: "name", page: 1 },
        headers: { "x-trace": "a" },
      }),
      load("/api/list", { query: { page: 2, sort: "name" } }),
      load("/api/list", { method: "POST", body: { page: 1 } }),
      load("/api/list", { method: "POST", body: { page: 2 } }),
    ]);

    assert.deepEqual(
      requests.map(({ url, options }) => [
        url,
        options.method ?? "GET",
        JSON.stringify(options.query ?? options.body),
      ]),
      [
        ["/api/list", "GET", '{"page":1,"sort":"name"}'],
        ["/api/list", "GET", '{"page":2,"sort":"name"}'],
        ["/api/list", "POST", '{"page":1}'],
        ["/api/list", "POST", '{"page":2}'],
      ],
    );
  });

  it("follows a URL getter to the key of each URL, showing the previous data meanwhile", async () => {
    const runtime = createDmsFrontendRuntime();
    const id = ref(1);
    const answers = new Map<string, ReturnType<typeof deferred<string>>>();
    const signals: AbortSignal[] = [];
    const fetcher = ((url: string, options: { signal: AbortSignal }) => {
      signals.push(options.signal);
      const answer = deferred<string>();
      answers.set(url, answer);
      return answer.promise;
    }) as never;
    let entry: ReturnType<typeof runtimeModule.useDmsFetch<string>> | undefined;
    const Consumer = defineComponent({
      setup() {
        entry = runtimeModule.useDmsFetch<string>(
          () => `/api/orders/${id.value}`,
          { $fetch: fetcher },
        );
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, { render: () => h(Consumer) });
    answers.get("/api/orders/1")!.resolve("order 1");
    await settle();
    assert.equal(entry!.data.value, "order 1");

    id.value = 2;
    await nextTick();
    assert.equal(entry!.status.value, "pending");
    assert.equal(entry!.data.value, "order 1", "no flash while it loads");
    answers.get("/api/orders/2")!.resolve("order 2");
    await settle();
    assert.equal(entry!.data.value, "order 2");
    assert.equal(signals.length, 2, "the custom fetcher gets the signal");
    assert.ok(signals.every((signal) => signal instanceof AbortSignal));

    app.runWithContext(() =>
      hydrateDmsPageProps({ path: "/elsewhere", page: {} }),
    );
    assert.deepEqual(
      [...runtime.asyncData.values()].map((result) => result.data.value),
      ["order 2"],
      "the first URL's data went with the key nobody shows",
    );
    app.unmount();
  });

  it("follows a reactive query and body to the key of each request", async () => {
    const runtime = createDmsFrontendRuntime();
    const page = ref(1);
    const requests: string[] = [];
    const fetcher = (async (
      url: string,
      options: { method?: string; query?: unknown; body?: unknown },
    ) => {
      requests.push(
        `${options.method ?? "GET"} ${url} ${JSON.stringify(options.query ?? options.body)}`,
      );
      return JSON.stringify(options.query ?? options.body);
    }) as never;
    const listed: Array<ReturnType<typeof runtimeModule.useDmsFetch<string>>> =
      [];
    const Consumer = defineComponent({
      setup() {
        listed.push(
          runtimeModule.useDmsFetch<string>("/api/list", {
            query: () => ({ page: page.value }),
            $fetch: fetcher,
          }),
          runtimeModule.useDmsFetch<string>("/api/count", {
            method: "POST",
            body: computed(() => ({ page: page.value })),
            $fetch: fetcher,
          }),
        );
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, { render: () => h(Consumer) });
    await settle();
    page.value = 2;
    await settle();

    assert.deepEqual(requests, [
      'GET /api/list {"page":1}',
      'POST /api/count {"page":1}',
      'GET /api/list {"page":2}',
      'POST /api/count {"page":2}',
    ]);
    assert.deepEqual(
      listed.map((result) => result.data.value),
      ['{"page":2}', '{"page":2}'],
    );
    app.unmount();
  });

  it("requests nothing while the URL is null, on the server as in the browser", async () => {
    const server = fetchingRuntime(true);
    const Waiting = defineComponent({
      setup() {
        const { data, status } = runtimeModule.useDmsFetch<string>(() => null, {
          default: () => "none",
        });
        return () => h("p", `${status.value}:${data.value}`);
      },
    });
    const ssr = createSSRApp(Waiting);
    provideDmsFrontendRuntime(ssr, server.runtime);
    assert.equal(await renderToString(ssr), "<p>idle:none</p>");
    assert.deepEqual(server.requests, []);
    assert.deepEqual(
      runtimeModule.serializeDmsPayload(server.runtime).data,
      {},
    );

    const browser = fetchingRuntime(false);
    const id = ref<number | null>(null);
    let entry: ReturnType<typeof runtimeModule.useDmsFetch<string>> | undefined;
    const app = mountRuntime(browser.runtime, {
      render: () =>
        h(
          defineComponent({
            setup() {
              entry = runtimeModule.useDmsFetch<string>(() =>
                id.value === null ? null : `/api/orders/${id.value}`,
              );
              return () => h("p");
            },
          }),
        ),
    });
    await settle();
    await entry!.refresh();
    assert.deepEqual(browser.requests, [], "not even when refreshed");
    assert.equal(entry!.status.value, "idle");

    id.value = 7;
    await settle();
    assert.deepEqual(
      browser.requests.map(({ url }) => url),
      ["/api/orders/7"],
    );
    assert.equal(entry!.data.value, "data:/api/orders/7");

    id.value = null;
    await settle();
    assert.equal(entry!.data.value, "data:/api/orders/7", "kept on screen");
    assert.equal(browser.requests.length, 1);
    app.unmount();
  });
});

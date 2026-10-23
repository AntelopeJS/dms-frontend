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
        const { data, status } = useDmsAsyncData(
          "e2",
          async () => {
            await sleep(1);
            return "fresh";
          },
          { lazy: true },
        );
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
              useDmsAsyncData("plugin-lazy", handler(40), { lazy: true });
            });
            // The DMS seo plugin: a lazy key, then an explicit refresh in the
            // same turn, which replaces the scheduled first run.
            sdk.registerPlugin(async () => {
              const entry = useDmsAsyncData("plugin-refreshed", handler(5), {
                lazy: true,
              });
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

  it("keeps, past a navigation, the most recently shown data no component shows any more", async () => {
    const runtime = createDmsFrontendRuntime();
    const shownKeys = ref<string[]>([]);
    const Consumer = defineComponent({
      props: { name: { type: String, required: true } },
      setup(props) {
        useDmsAsyncData(props.name, async () => props.name);
        return () => h("p");
      },
    });
    const app = mountRuntime(runtime, {
      render: () =>
        h(
          "div",
          shownKeys.value.map((name) => h(Consumer, { name, key: name })),
        ),
    });
    // 60 keys shown one after the other, then a page showing "kept".
    for (let index = 0; index < 60; index++) {
      shownKeys.value = [`key-${index}`];
      await nextTick();
    }
    shownKeys.value = ["kept"];
    await nextTick();

    app.runWithContext(() => hydrateDmsPageProps({ path: "/next", page: {} }));

    assert.ok(runtime.asyncData.has("kept"));
    assert.ok(
      runtime.asyncData.has("key-59"),
      "a return to it shows it at once",
    );
    assert.ok(runtime.asyncData.has("key-10"));
    assert.equal(runtime.asyncData.has("key-9"), false, "the oldest go");
    assert.equal(runtime.asyncData.size, 51);
    app.unmount();
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

  it("says whether the browser hydrates: until the page has, and never in a page the server did not render", async () => {
    const hydrated = createDmsFrontendRuntime(undefined, {});
    const { app } = clientApp(hydrated);
    const isHydrating = () => app.runWithContext(runtimeModule.isDmsHydrating);
    const suspense = app.runWithContext(() =>
      runtimeModule.dmsPageSuspenseProps(),
    );

    assert.equal(isHydrating(), true);
    suspense.onResolve();
    assert.equal(isHydrating(), true);
    await nextTick();
    assert.equal(isHydrating(), false);

    for (const runtime of [
      createDmsFrontendRuntime(),
      createDmsFrontendRuntime(undefined, {}, true),
    ]) {
      const other = clientApp(runtime).app;
      assert.equal(other.runWithContext(runtimeModule.isDmsHydrating), false);
    }
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
        throw runtimeModule.createDmsError({
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
    });
  });

  it("keeps the body of a backend's 5xx out of the payload, and a 4xx's in", async () => {
    const backendFailure = (statusCode: number, data: unknown) =>
      Object.assign(new Error(`[GET] "/api/x": ${statusCode}`), {
        name: "FetchError",
        statusCode,
        statusMessage: "Failure",
        data,
      });
    const { payload } = await serverPayload(() => {
      useDmsAsyncData("server-failure", async () => {
        throw backendFailure(500, { stack: "at db.query (pg://secret)" });
      });
      useDmsAsyncData("client-failure", async () => {
        throw backendFailure(422, { field: "email" });
      });
      return () => h("p");
    });

    assert.deepEqual(payload.errors["server-failure"], {
      statusCode: 500,
      statusMessage: "Failure",
      message: "Failure",
    });
    assert.deepEqual(payload.errors["client-failure"], {
      statusCode: 422,
      statusMessage: "Failure",
      message: "Failure",
      data: { field: "email" },
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
      ["order 1", "order 2"],
      "the first URL's data stays for a return to it",
    );
    // Back to the first URL: its data at once, read again in the background.
    id.value = 1;
    await nextTick();
    assert.equal(entry!.data.value, "order 1");
    assert.equal(entry!.status.value, "pending");
    assert.equal(signals.length, 3);
    answers.get("/api/orders/1")!.resolve("order 1, again");
    await settle();
    assert.equal(entry!.data.value, "order 1, again");
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

  function switchingFetcher() {
    const requests: string[] = [];
    const answers = new Map<
      string,
      { resolve: (value: string) => void; reject: (reason: unknown) => void }
    >();
    const fetcher = ((url: string) => {
      requests.push(url);
      return new Promise<string>((resolve, reject) => {
        answers.set(url, { resolve, reject });
      });
    }) as never;
    return { fetcher, requests, answers };
  }

  function followOrders(fetcher: never, id: ReturnType<typeof ref<number>>) {
    const runtime = createDmsFrontendRuntime();
    let entry: ReturnType<typeof runtimeModule.useDmsFetch<string>> | undefined;
    const app = mountRuntime(runtime, {
      render: () =>
        h(
          defineComponent({
            setup() {
              entry = runtimeModule.useDmsFetch<string>(
                () => `/api/orders/${id.value}`,
                { $fetch: fetcher },
              );
              return () => h("p");
            },
          }),
        ),
    });
    return { runtime, app, entry: () => entry! };
  }

  it("refetches a key whose run a switch away aborted, never showing another key's data as its own", async () => {
    const { fetcher, requests, answers } = switchingFetcher();
    const id = ref(1);
    const { runtime, app, entry } = followOrders(fetcher, id);
    answers.get("/api/orders/1")!.resolve("order 1");
    await settle();

    id.value = 2;
    await nextTick();
    assert.equal(entry().data.value, "order 1", "no flash while it loads");
    id.value = 1;
    await nextTick();
    // Back on a key loaded before: its data at once, read again meanwhile.
    assert.equal(entry().data.value, "order 1");
    assert.equal(entry().placeholder.value, false);
    assert.equal(entry().status.value, "pending");
    const second = [...runtime.asyncData.values()][1];
    assert.equal(second?.status.value, "idle", "the aborted key holds nothing");
    assert.equal(second?.data.value, null);

    id.value = 2;
    await nextTick();
    assert.equal(entry().status.value, "pending");
    assert.equal(entry().data.value, "order 1", "no flash while it loads");
    assert.equal(entry().placeholder.value, true, "and it says so");
    assert.deepEqual(requests, [
      "/api/orders/1",
      "/api/orders/2",
      "/api/orders/1",
      "/api/orders/2",
    ]);
    answers.get("/api/orders/2")!.resolve("order 2");
    await settle();
    assert.equal(entry().status.value, "success");
    assert.equal(entry().data.value, "order 2");
    app.unmount();
  });

  it("shows a failed key's own data and error, not the previous key's data", async () => {
    const { fetcher, answers } = switchingFetcher();
    const id = ref(1);
    const { runtime, app, entry } = followOrders(fetcher, id);
    answers.get("/api/orders/1")!.resolve("order 1");
    await settle();

    id.value = 2;
    await nextTick();
    assert.equal(entry().data.value, "order 1", "no flash while it loads");
    const failure = new Error("not found");
    answers.get("/api/orders/2")!.reject(failure);
    await settle();

    assert.equal(entry().status.value, "error");
    assert.equal(entry().error.value, failure);
    assert.equal(entry().data.value, null);
    assert.deepEqual(
      [...runtime.asyncData.values()].map((result) => result.data.value),
      ["order 1", null],
      "the failed key's entry never held the other key's data",
    );

    entry().data.value = "edited";
    assert.equal(entry().data.value, "edited", "a write reaches the key");
    app.unmount();
  });

  it("transfers its keys without the URL, query or body they request", async () => {
    const { runtime, requests } = fetchingRuntime(true);
    const app = createSSRApp(
      defineComponent({
        setup() {
          runtimeModule.useDmsFetch("/api/orders/secret-path", {
            query: { token: "query-secret" },
          });
          runtimeModule.useDmsFetch("/api/login", {
            method: "POST",
            body: { password: "body-secret" },
          });
          return () => h("p");
        },
      }),
    );
    provideDmsFrontendRuntime(app, runtime);
    await renderToString(app);

    assert.equal(requests.length, 2);
    const payload = runtimeModule.serializeDmsPayload(runtime);
    const keys = Object.keys(payload.data);
    assert.equal(keys.length, 2);
    for (const key of keys)
      for (const secret of [
        "secret-path",
        "query-secret",
        "body-secret",
        "/api",
        "POST",
      ])
        assert.ok(!key.includes(secret), `${key} leaks ${secret}`);

    const browser = fetchingRuntime(false);
    runtimeModule.restoreDmsPayload(browser.runtime, payload);
    const { app: client } = clientApp(browser.runtime);
    const hydrated = await client.runWithContext(() =>
      runtimeModule.useDmsFetch<string>("/api/orders/secret-path", {
        query: { token: "query-secret" },
      }),
    );
    assert.equal(hydrated.data.value, "data:/api/orders/secret-path");
    assert.deepEqual(browser.requests, [], "the browser finds the same key");
  });

  it("keys a request by its params as well as its query", async () => {
    const { runtime, requests } = fetchingRuntime(false);
    const { app } = clientApp(runtime);
    const load = (params: Record<string, unknown>) =>
      app.runWithContext(() =>
        runtimeModule.useDmsFetch("/api/list", { query: { a: 1 }, params }),
      );

    await Promise.all([load({ b: 1 }), load({ b: 2 }), load({ b: 2 })]);

    assert.deepEqual(
      requests.map(({ options }) => options.params),
      [{ b: 1 }, { b: 2 }],
    );
  });

  it("does not retry a server read, unless asked to, and leaves the browser's retries alone", async () => {
    const server = fetchingRuntime(true);
    const ssr = createSSRApp(
      defineComponent({
        setup() {
          runtimeModule.useDmsFetch("/api/default");
          runtimeModule.useDmsFetch("/api/explicit", { retry: 2 });
          return () => h("p");
        },
      }),
    );
    provideDmsFrontendRuntime(ssr, server.runtime);
    await renderToString(ssr);
    await ssr.runWithContext(() =>
      Promise.all([
        runtimeModule.$fetch("/api/direct"),
        runtimeModule.$fetch.create({ retry: 3 })("/api/created"),
      ]),
    );

    assert.deepEqual(
      server.requests.map(({ url, options }) => [url, options.retry]),
      [
        ["/api/default", 0],
        ["/api/explicit", 2],
        ["/api/direct", 0],
        ["/api/created", 3],
      ],
    );

    const browser = fetchingRuntime(false);
    const { app } = clientApp(browser.runtime);
    await app.runWithContext(() =>
      Promise.all([
        runtimeModule.useDmsFetch("/api/default"),
        runtimeModule.$fetch("/api/direct"),
      ]),
    );
    assert.deepEqual(
      browser.requests.map(({ options }) => "retry" in options),
      [false, false],
    );
  });
});

describe("A reactive key a render sets", () => {
  // A backend that answers at once, and records each request on its side.
  function backend(isServer: boolean) {
    const requests: string[] = [];
    const runtime = createDmsFrontendRuntime(
      (async (url: string) => {
        requests.push(url);
        return `data:${url}`;
      }) as never,
      undefined,
      isServer,
    );
    return { runtime, requests };
  }

  // Renders `root` on a server, then mounts it in a browser hydrating that
  // render, and returns what each side requested and what the browser's
  // renders showed.
  async function renderThenHydrate(
    root: (rendered: string[]) => Component,
    expectedHtml: string,
  ) {
    const server = backend(true);
    const ssr = createSSRApp(root([]));
    provideDmsFrontendRuntime(ssr, server.runtime);
    assert.equal(await renderToString(ssr), expectedHtml);
    await sleep(5);
    const payload = runtimeModule.serializeDmsPayload(server.runtime);

    const browser = backend(false);
    runtimeModule.restoreDmsPayload(browser.runtime, payload);
    const rendered: string[] = [];
    const app = mountRuntime(browser.runtime, {
      render: () => h(root(rendered)),
    });
    const first = rendered[0];
    await settle();
    await nextTick();
    app.unmount();
    return {
      serverRequests: server.requests,
      payload: payload.data,
      browserRequests: browser.requests,
      first,
      last: rendered.at(-1),
    };
  }

  it("leaves a server: false read whose key its setup sets to the browser, which reads it once mounted", async () => {
    const result = await renderThenHydrate(
      (rendered) =>
        defineComponent({
          setup() {
            const ready = ref(false);
            const sizes = runtimeModule.useDmsFetch<string>(
              () => (ready.value ? "/api/sizes" : null),
              { server: false, default: () => "none" },
            );
            ready.value = true;
            return () => {
              const text = `${sizes.status.value}:${sizes.data.value}`;
              rendered.push(text);
              return h("p", text);
            };
          },
        }),
      "<p>idle:none</p>",
    );

    assert.deepEqual(result.serverRequests, [], "the server reads nothing");
    assert.deepEqual(result.payload, {}, "nor transfers anything");
    assert.equal(result.first, "idle:none", "hydration matches the HTML");
    assert.deepEqual(result.browserRequests, ["/api/sizes"]);
    assert.equal(result.last, "success:data:/api/sizes");
  });

  it("renders the default for a key a server read moves to once its render stopped waiting, and leaves it to the browser", async () => {
    const result = await renderThenHydrate(
      (rendered) =>
        defineComponent({
          setup() {
            const details = runtimeModule.useDmsFetch<string>("/api/details");
            // Known once the details are in, past the component's prefetch.
            const sizes = runtimeModule.useDmsFetch<string>(
              () => (details.data.value ? "/api/sizes" : null),
              { default: () => "none" },
            );
            return () => {
              const text = `${sizes.status.value}:${sizes.data.value}`;
              rendered.push(text);
              return h("p", text);
            };
          },
        }),
      "<p>idle:none</p>",
    );

    assert.deepEqual(result.serverRequests, ["/api/details"]);
    assert.deepEqual(Object.values(result.payload), ["data:/api/details"]);
    assert.equal(result.first, "idle:none", "hydration matches the HTML");
    assert.deepEqual(result.browserRequests, ["/api/sizes"]);
    assert.equal(result.last, "success:data:/api/sizes");
  });

  it("renders and transfers the key a setup sets for a server read, lazy or not", async () => {
    const result = await renderThenHydrate(
      (rendered) =>
        defineComponent({
          setup() {
            const id = ref<number | null>(null);
            const order = runtimeModule.useDmsFetch<string>(() =>
              id.value === null ? null : `/api/orders/${id.value}`,
            );
            const lines = runtimeModule.useDmsFetch<string>(
              () => (id.value === null ? null : `/api/lines/${id.value}`),
              { lazy: true },
            );
            id.value = 7;
            return () => {
              const text = `${order.data.value}|${lines.data.value}`;
              rendered.push(text);
              return h("p", text);
            };
          },
        }),
      "<p>data:/api/orders/7|data:/api/lines/7</p>",
    );

    assert.deepEqual(result.serverRequests, ["/api/orders/7", "/api/lines/7"]);
    assert.equal(Object.keys(result.payload).length, 2);
    assert.equal(result.first, "data:/api/orders/7|data:/api/lines/7");
    assert.deepEqual(result.browserRequests, [], "the browser reads nothing");
  });

  it("runs no immediate: false read on a server when its key changes, even with a default", async () => {
    const server = backend(true);
    let entry: ReturnType<typeof runtimeModule.useDmsFetch<string>> | undefined;
    const ssr = createSSRApp(
      defineComponent({
        setup() {
          const id = ref<number | null>(null);
          entry = runtimeModule.useDmsFetch<string>(
            () => (id.value === null ? null : `/api/orders/${id.value}`),
            { immediate: false, default: () => "none" },
          );
          id.value = 7;
          return () => h("p", `${entry!.status.value}:${entry!.data.value}`);
        },
      }),
    );
    provideDmsFrontendRuntime(ssr, server.runtime);

    assert.equal(await renderToString(ssr), "<p>idle:none</p>");
    await sleep(5);
    assert.deepEqual(server.requests, []);
    assert.deepEqual(
      runtimeModule.serializeDmsPayload(server.runtime).data,
      {},
    );
  });
});

describe("Another caller's data (useDmsData)", () => {
  interface Rows {
    rows: string[];
  }

  it("follows a key as a caller loads it, keeps it across a navigation, and updates it in place without reading it again", async () => {
    const runtime = createDmsFrontendRuntime();
    const shown = ref(true);
    let calls = 0;
    const rendered: string[] = [];
    const Owner = defineComponent({
      setup() {
        // In place changes need a deep key: keys are shallow by default.
        const { data } = useDmsAsyncData<Rows>(
          "rows",
          async () => {
            calls++;
            return { rows: ["a"] };
          },
          { deep: true },
        );
        return () => {
          rendered.push(data.value?.rows.join() ?? "none");
          return h("p");
        };
      },
    });
    let accessor: ReturnType<typeof runtimeModule.useDmsData<Rows>>;
    const seen: string[] = [];
    const app = mountRuntime(runtime, {
      setup() {
        // Called before any caller loads the key.
        accessor = runtimeModule.useDmsData<Rows>("rows");
        watch(
          () => accessor.data.value?.rows.join() ?? "undefined",
          (value) => seen.push(value),
          { immediate: true },
        );
        return () => h("div", [shown.value ? h(Owner) : null]);
      },
    });
    await settle();
    assert.deepEqual(seen, ["undefined", "a"], "the key's data once it is in");

    accessor!.data.value = { rows: ["a", "b"] };
    await nextTick();
    accessor!.data.value!.rows.push("c");
    await nextTick();
    assert.equal(rendered.at(-1), "a,b,c", "the caller shows both updates");
    assert.equal(calls, 1, "without reading the key again");

    shown.value = false;
    await nextTick();
    assert.equal(seen.at(-1), "a,b,c", "kept once no component shows it");
    app.runWithContext(() => hydrateDmsPageProps({ path: "/next", page: {} }));
    await nextTick();
    assert.equal(
      seen.at(-1),
      "a,b,c",
      "a browser keeps the most recent keys across a navigation",
    );

    const other = app.runWithContext(() =>
      runtimeModule.useDmsData<Rows>("nobody"),
    );
    other.data.value = { rows: ["z"] };
    assert.equal(
      runtime.asyncData.has("nobody"),
      false,
      "a write loads nothing",
    );
    assert.equal(other.data.value, undefined);
    app.unmount();
  });

  it("reads a request's own data on a server, and hydrates with what it rendered", async () => {
    const Owner = (key: string) =>
      defineComponent({
        setup() {
          useDmsAsyncData<Rows>(key, async () => ({ rows: [key] }));
          return () => h("i");
        },
      });
    const Reader = defineComponent({
      props: { name: { type: String, required: true } },
      setup(props) {
        const { data } = runtimeModule.useDmsData<Rows>(() => props.name);
        return () => h("b", data.value?.rows.join() ?? "none");
      },
    });
    const page = (key: string) => ({
      render: () =>
        h("div", [
          h(Reader, { name: key }),
          h(Owner(key)),
          h(Reader, { name: key }),
          h(Owner(`${key}-heavy`)),
          h(Reader, { name: `${key}-heavy` }),
        ]),
    });
    const [first, second] = await Promise.all(
      ["one", "two"].map(async (key) => {
        const { runtime, render } = serverRender(page(key));
        const html = await render();
        return { html, payload: runtimeModule.serializeDmsPayload(runtime) };
      }),
    );
    assert.equal(
      first.html,
      "<div><b>none</b><i></i><b>one</b><i></i><b>one-heavy</b></div>",
      "a reader rendered before the caller has no data, one after has it",
    );
    assert.equal(
      second.html,
      "<div><b>none</b><i></i><b>two</b><i></i><b>two-heavy</b></div>",
      "each request its own",
    );
    assert.deepEqual(first.payload.data, {
      one: { rows: ["one"] },
      "one-heavy": { rows: ["one-heavy"] },
    });

    const texts: string[] = [];
    const Hydrating = defineComponent({
      setup() {
        const { data } = runtimeModule.useDmsData<Rows>("one");
        return () => {
          texts.push(data.value?.rows.join() ?? "none");
          return h("b");
        };
      },
    });
    const runtime = createDmsFrontendRuntime();
    runtimeModule.restoreDmsPayload(runtime, first.payload);
    const app = mountRuntime(runtime, {
      render: () => h("div", [h(Hydrating), h(Owner("one")), h(Hydrating)]),
    });
    assert.deepEqual(texts, ["none", "one"], "the HTML, as hydrated");
    await settle();
    assert.equal(texts.at(-1), "one");
    app.unmount();
  });

  it("gives a reactive key's own data only, not the previous key's shown in its place", async () => {
    const runtime = createDmsFrontendRuntime();
    const id = ref(1);
    const answers = new Map<string, ReturnType<typeof deferred<Rows>>>();
    let owner: ReturnType<typeof useDmsAsyncData<Rows>> | undefined;
    let accessor: ReturnType<typeof runtimeModule.useDmsData<Rows>>;
    const app = mountRuntime(runtime, {
      setup() {
        owner = useDmsAsyncData<Rows>(
          () => `order-${id.value}`,
          () => {
            const answer = deferred<Rows>();
            answers.set(`order-${id.value}`, answer);
            return answer.promise;
          },
        );
        accessor = runtimeModule.useDmsData<Rows>(() => `order-${id.value}`);
        return () => h("p");
      },
    });
    answers.get("order-1")!.resolve({ rows: ["first"] });
    await settle();
    assert.deepEqual(accessor!.data.value, { rows: ["first"] });

    id.value = 2;
    await nextTick();
    assert.deepEqual(owner!.data.value, { rows: ["first"] }, "shown in place");
    assert.equal(accessor!.data.value, undefined, "not order 2's");

    accessor!.data.value = { rows: ["second, from a write"] };
    assert.equal(owner!.placeholder.value, false, "now order 2's own");
    assert.deepEqual(owner!.data.value, { rows: ["second, from a write"] });
    assert.deepEqual(
      runtime.asyncData.get("order-1")?.data.value,
      { rows: ["first"] },
      "order 1 untouched",
    );
    answers.get("order-2")!.resolve({ rows: ["second"] });
    await settle();
    assert.deepEqual(accessor!.data.value, { rows: ["second"] });
    app.unmount();
  });
});

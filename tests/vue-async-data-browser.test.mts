import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import {
  type Component,
  createSSRApp,
  defineComponent,
  h,
  isRef,
  isShallow,
  nextTick,
  ref,
  Suspense,
  watch,
} from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const {
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  provideDmsFrontendRuntime,
  serializeDmsAsyncData,
  useDmsAsyncData,
} = runtimeModule;

import {
  sleep,
  settle,
  deferred,
  serverRender,
  clientApp,
  mountRuntime,
} from "./fixtures/vue-async-data.mts";

describe("Async data in the browser", () => {
  it("hands a hydrating component the server's data when the server's render had it", async () => {
    const rendered: string[] = [];
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

describe("A reactive key a render sets", () => {
  /** A backend that answers at once, and records each request on its side. */
  function backend(isServer: boolean) {
    const requests: string[] = [];
    const runtime = createDmsFrontendRuntime(
      async (url: string) => {
        requests.push(url);
        return `data:${url}`;
      },
      undefined,
      isServer,
    );
    return { runtime, requests };
  }

  /**
   * Renders `root` on a server, then mounts it in a browser hydrating that
   * render, and returns what each side requested and what the browser's
   * renders showed.
   */
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, defineComponent, h, nextTick, ref, computed } from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const {
  createDmsFrontendRuntime,
  hydrateDmsPageProps,
  provideDmsFrontendRuntime,
} = runtimeModule;

import {
  settle,
  deferred,
  clientApp,
  mountRuntime,
} from "./fixtures/vue-async-data.mts";

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

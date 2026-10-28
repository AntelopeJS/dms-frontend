import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import {
  type Component,
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  ref,
} from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const {
  createDmsFrontendRuntime,
  provideDmsFrontendRuntime,
  useDmsAsyncData,
  useDmsFetch,
  useDmsPagedData,
  dmsRequestKey,
} = runtimeModule;

type Runtime = ReturnType<typeof createDmsFrontendRuntime>;

const settle = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function clientApp(runtime: Runtime = createDmsFrontendRuntime()) {
  const app = createSSRApp({ render: () => null });
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime };
}

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

interface Page {
  items: string[];
  next: number | null;
}

/** A list of `total` items served `size` at a time, recording each cursor read. */
function pagedBackend(total: number, size: number, prefix = "item") {
  const reads: Array<number | undefined> = [];
  const handler = async ({ cursor }: { cursor: number | undefined }) => {
    reads.push(cursor);
    const start = cursor ?? 0;
    const end = Math.min(total, start + size);
    const items = Array.from(
      { length: end - start },
      (_, index) => `${prefix}${start + index}`,
    );
    return { items, next: end < total ? end : null } satisfies Page;
  };
  return { reads, handler };
}

const pagedOptions = { nextCursor: (page: Page) => page.next };

describe("Paged async data", () => {
  it("appends each page under one key until there is no next one", async () => {
    const { app, runtime } = clientApp();
    const backend = pagedBackend(5, 2);
    const list = await app.runWithContext(() =>
      useDmsPagedData<Page, number>("files", backend.handler, pagedOptions),
    );
    assert.deepEqual(
      list.pages.value.flatMap((page) => page.items),
      ["item0", "item1"],
    );
    assert.equal(list.hasMore.value, true);

    const loading = list.loadMore();
    assert.equal(list.loadingMore.value, true);
    await loading;
    await list.loadMore();
    assert.deepEqual(
      list.pages.value.flatMap((page) => page.items),
      ["item0", "item1", "item2", "item3", "item4"],
    );
    assert.equal(list.hasMore.value, false);
    assert.equal(list.loadingMore.value, false);
    await list.loadMore();
    assert.deepEqual(backend.reads, [undefined, 2, 4], "no read past the end");
    assert.deepEqual([...runtime.asyncData.keys()], ["files"]);
    assert.equal(runtime.asyncData.get("files")?.data.value, list.data.value);
  });

  it("reads every page loaded again on a revalidation, and replaces them at once", async () => {
    const { app } = clientApp();
    const backend = pagedBackend(6, 2);
    const list = await app.runWithContext(() =>
      useDmsPagedData<Page, number>("changes", backend.handler, pagedOptions),
    );
    await list.loadMore();
    backend.reads.length = 0;
    const shown = list.data.value;

    const refreshing = list.refresh();
    assert.equal(list.data.value, shown, "the pages stay until all are read");
    await refreshing;
    assert.deepEqual(backend.reads, [undefined, 2]);
    assert.equal(list.pages.value.length, 2);
    assert.notEqual(list.data.value, shown);
  });

  it("drops a page a revalidation overtook", async () => {
    const { app } = clientApp();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const list = await app.runWithContext(() =>
      useDmsPagedData<Page, number>(
        "overtaken",
        async ({ cursor }) => {
          if (cursor === 2) await gate;
          return { items: [`at${cursor ?? 0}`], next: 2 };
        },
        pagedOptions,
      ),
    );
    const more = list.loadMore();
    await settle();
    await list.refresh();
    release();
    await more;
    assert.deepEqual(
      list.pages.value.map((page) => page.items[0]),
      ["at0"],
    );
  });

  it("keeps the pages loaded and reports a failure of loadMore", async () => {
    const { app } = clientApp();
    const failure = new Error("offline");
    const list = await app.runWithContext(() =>
      useDmsPagedData<Page, number>(
        "failing",
        async ({ cursor }) => {
          if (cursor !== undefined) throw failure;
          return { items: ["first"], next: 1 };
        },
        pagedOptions,
      ),
    );
    await list.loadMore();
    assert.equal(list.error.value, failure);
    assert.equal(list.pages.value.length, 1);
    assert.equal(list.hasMore.value, true);
  });

  it("starts a new key from its first page", async () => {
    const { app } = clientApp();
    const folder = ref("a");
    const backend = pagedBackend(4, 1);
    const list = app.runWithContext(() =>
      useDmsPagedData<Page, number>(
        () => `folder:${folder.value}`,
        backend.handler,
        pagedOptions,
      ),
    );
    await list;
    await list.loadMore();
    assert.equal(list.pages.value.length, 2);
    backend.reads.length = 0;

    folder.value = "b";
    await settle();
    await sleep(5);
    assert.deepEqual(backend.reads, [undefined]);
    assert.equal(list.pages.value.length, 1);
    assert.equal(list.key.value, "folder:b");
  });

  it("renders the first page on a server, and the browser takes it over", async () => {
    const backend = pagedBackend(3, 2);
    let browserList!: ReturnType<typeof useDmsPagedData<Page, number>>;
    const List = defineComponent({
      setup() {
        const list = useDmsPagedData<Page, number>(
          "media",
          backend.handler,
          pagedOptions,
        );
        browserList = list;
        return () =>
          h("p", list.pages.value.flatMap((page) => page.items).join(","));
      },
    });
    const server = createDmsFrontendRuntime(undefined, {}, true);
    const ssr = createSSRApp(List);
    provideDmsFrontendRuntime(ssr, server);
    assert.equal(await renderToString(ssr), "<p>item0,item1</p>");
    const payload = runtimeModule.serializeDmsPayload(server);
    assert.deepEqual(payload.data, {
      media: { pages: [{ items: ["item0", "item1"], next: 2 }], next: 2 },
    });
    backend.reads.length = 0;

    const browser = createDmsFrontendRuntime();
    runtimeModule.restoreDmsPayload(browser, payload);
    const app = mountRuntime(browser, List);
    await settle();
    assert.deepEqual(backend.reads, [], "hydration reads nothing again");
    assert.equal(browserList.hasMore.value, true);
    await browserList.loadMore();
    assert.deepEqual(backend.reads, [2]);
    assert.equal(browserList.hasMore.value, false);
    app.unmount();
  });
});

describe("Polling", () => {
  it("follows a reactive interval, and stops at 0 or null", async () => {
    const interval = ref<number | null>(10);
    let calls = 0;
    const Poller = defineComponent({
      setup() {
        useDmsAsyncData("reactive-poll", async () => ++calls, {
          refreshInterval: interval,
        });
        return () => h("p");
      },
    });
    const app = mountRuntime(createDmsFrontendRuntime(), Poller);
    await sleep(45);
    assert.ok(calls >= 3, `read ${calls} times`);
    interval.value = 0;
    await nextTick();
    const stopped = calls;
    await sleep(30);
    assert.equal(calls, stopped, "no read at 0");
    interval.value = null;
    await nextTick();
    await sleep(20);
    assert.equal(calls, stopped, "no read at null");
    interval.value = 10;
    await nextTick();
    await sleep(35);
    assert.ok(calls > stopped, "polls again");
    app.unmount();
  });

  it("polls a call made outside any component or scope, for the application's life", async () => {
    const { app, runtime } = clientApp();
    let calls = 0;
    await sleep(0);
    const status = app.runWithContext(() =>
      useDmsAsyncData("sidecar-status", async () => ++calls, {
        refreshInterval: 10,
      }),
    );
    await status;
    await sleep(45);
    assert.ok(calls >= 3, `read ${calls} times`);
    runtime.scope.stop();
    const stopped = calls;
    await sleep(30);
    assert.equal(calls, stopped, "the application's scope ends the polling");
  });

  it("stops a getter interval over reactive state outside a component", async () => {
    const { app } = clientApp();
    const installed = ref(false);
    let calls = 0;
    const check = app.runWithContext(() =>
      useDmsAsyncData("install-check", async () => ++calls, {
        refreshInterval: () => (installed.value ? 0 : 10),
      }),
    );
    await check;
    await sleep(35);
    assert.ok(calls >= 2, `read ${calls} times`);
    installed.value = true;
    await nextTick();
    const stopped = calls;
    await sleep(30);
    assert.equal(calls, stopped);
  });
});

describe("useDmsFetch keys", () => {
  it("follows a reactive key, and requests nothing while it is null", async () => {
    const requests: string[] = [];
    const runtime = createDmsFrontendRuntime((async (url: string) => {
      requests.push(url);
      return url;
    }) as never);
    const { app } = clientApp(runtime);
    const id = ref<string | null>(null);
    const result = app.runWithContext(() =>
      useDmsFetch<string>(() => `/api/items/${id.value ?? "none"}`, {
        key: () => (id.value ? `item:${id.value}` : null),
        transform: (value, { key }) => `${String(value)}@${key}`,
      }),
    );
    await settle();
    assert.deepEqual(requests, []);
    id.value = "7";
    await settle();
    await sleep(5);
    assert.deepEqual(requests, ["/api/items/7"]);
    assert.equal(result.key.value, "item:7");
    assert.equal(result.data.value, "/api/items/7@item:7");
  });

  it("gives tests and refreshDmsData the key of a request", async () => {
    const runtime = createDmsFrontendRuntime((async () => "ok") as never);
    const { app } = clientApp(runtime);
    const result = await app.runWithContext(() =>
      useDmsFetch("/api/orders", { query: { page: 2, sort: "date" } }),
    );
    const key = dmsRequestKey("/api/orders", {
      query: { sort: "date", page: 2 },
    });
    assert.equal(result.key.value, key);
    assert.match(key ?? "", /^\$dmsfetch:[0-9a-z]{14}$/);
    assert.deepEqual([...runtime.asyncData.keys()], [key]);
    assert.notEqual(dmsRequestKey("/api/orders", { method: "POST" }), key);
    assert.equal(
      dmsRequestKey("/api/orders", { body: new FormData() }),
      undefined,
    );
  });
});

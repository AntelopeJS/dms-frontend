import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineComponent, h, isShallow, nextTick, ref } from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";
import { isNumber } from "../src/internal/guards";
import {
  clientApp,
  deferred,
  mountRuntime,
  settle,
  sleep,
  toggled,
  until,
} from "./helpers/vue-async-revalidate.mts";

const { createDmsFrontendRuntime, useDmsAsyncData } = runtimeModule;

void describe("Stale while revalidate", () => {
  void it("shows the data at once on a remount, and reads it again in the background", async () => {
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

  void it("spares a caller joining data another one has just read a second read", async () => {
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

  void it("does not hold an awaiting caller for data it already has", async () => {
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

  void it("does not read again while the page the server rendered hydrates", async () => {
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

void describe("Async data failures and keys", () => {
  void it("keeps the failure until the next answer, and the data of the last success", async () => {
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
    assert.ok(entry.error.value instanceof Error);
    assert.equal(entry.error.value.message, "down", "still shown");
    answers[2].resolve("rows again");
    await settle();
    assert.equal(entry.error.value, null);
    assert.equal(entry.data.value, "rows again");
  });

  void it("names its key, and hands it to transform", async () => {
    const { app } = clientApp();
    const seen: unknown[] = [];
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("named", async () => 2, {
        transform: (value, context) => {
          seen.push(context);
          assert.ok(isNumber(value));
          return value * 10;
        },
      }),
    );
    assert.equal(entry.key.value, "named");
    assert.equal(entry.data.value, 20);
    assert.deepEqual(seen, [{ key: "named" }]);
  });

  void it("hands useDmsFetch's transform the key and the URL the answer is for", async () => {
    const { app } = clientApp();
    const seen: unknown[] = [];
    const entry = await app.runWithContext(() =>
      runtimeModule.useDmsFetch<string>("/api/items", {
        $fetch: async () => "raw",
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

  void it("tracks the replacement of the whole value only, unless deep", async () => {
    const { app } = clientApp();
    const entry = await app.runWithContext(() =>
      useDmsAsyncData("shallow-default", async () => ({ rows: [1] })),
    );
    assert.equal(isShallow(entry.data), true);
  });
});

void describe("Page refresh", () => {
  void it("reads again the data on screen, but what opted out or waits for execute()", async () => {
    const calls: string[] = [];
    const handler = (name: string) => async () => {
      calls.push(name);
      return name;
    };
    const Page = defineComponent({
      setup() {
        void useDmsAsyncData("kpi", handler("kpi"));
        void useDmsAsyncData("menu", handler("menu"), {
          refreshOnPageRefresh: false,
        });
        void useDmsAsyncData("dialog", handler("dialog"), { immediate: false });
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

  void it("loads a dialog's data on execute(), then keeps it in step", async () => {
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

  void it("reads again on an interval while shown", async (context) => {
    let calls = 0;
    const visible = ref(true);
    const Poller = defineComponent({
      setup() {
        void useDmsAsyncData("polled", async () => ++calls, {
          refreshInterval: 10,
        });
        return () => h("p");
      },
    });
    const app = mountRuntime(createDmsFrontendRuntime(), {
      render: () => (visible.value ? h(Poller) : null),
    });
    context.after(() => app.unmount());
    await until(
      () => calls >= 3,
      () => `read ${calls} times`,
    );
    visible.value = false;
    await nextTick();
    const polled = calls;
    await sleep(30);
    assert.equal(calls, polled, "no read once unmounted");
  });
});

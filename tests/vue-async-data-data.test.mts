import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineComponent, h, nextTick, ref, watch } from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const { createDmsFrontendRuntime, hydrateDmsPageProps, useDmsAsyncData } =
  runtimeModule;

import {
  settle,
  deferred,
  serverRender,
  mountRuntime,
} from "./fixtures/vue-async-data.mts";

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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createI18n } from "vue-i18n";
import { defineComponent, h, nextTick, ref } from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";
import {
  clientApp,
  deferred,
  mountRuntime,
  serverRender,
  settle,
  sleep,
  toggled,
} from "./helpers/vue-async-revalidate.mts";

const { createDmsFrontendRuntime, hydrateDmsPageProps, useDmsAsyncData } =
  runtimeModule;

void describe("Async data scope", () => {
  void it("keeps the same key of two scopes apart, and drops the data on a change", async () => {
    const { app, runtime } = clientApp();
    let account = "a";
    const plan = async () => `plan of ${account}`;
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-a"));
    const first = await app.runWithContext(() => useDmsAsyncData("plan", plan));
    assert.equal(first.data.value, "plan of a");
    assert.deepEqual([...runtime.asyncData.keys()], ["account-a|plan"]);

    account = "b";
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    assert.equal(first.data.value, null, "the other account's data is gone");
    const second = await app.runWithContext(() =>
      useDmsAsyncData("plan", plan),
    );
    assert.equal(second.data.value, "plan of b");
    assert.equal(first.data.value, "plan of b");
    await app.runWithContext(() => runtimeModule.refreshDmsData("plan"));
    assert.deepEqual([...runtime.asyncData.keys()], ["account-b|plan"]);
  });
});

void describe("Async data on a scope move", () => {
  void it("reads again, in the new scope, the data a mounted component shows", async () => {
    let account = "a";
    const { shown, root } = toggled("plan", async () => `plan of ${account}`);
    const runtime = createDmsFrontendRuntime();
    runtime.asyncDataScope = "account-a";
    const app = mountRuntime(runtime, root);
    await settle();
    assert.equal(shown.at(-1), "success:plan of a");

    account = "b";
    shown.length = 0;
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    await settle();
    assert.equal(shown.at(-1), "success:plan of b");
    assert.ok(
      shown.every((state) => !state.endsWith("plan of a")),
      `the other account's data never shows: ${shown.join(", ")}`,
    );
    const { data } = app.runWithContext(() =>
      runtimeModule.useDmsData<string>("plan"),
    );
    assert.equal(data.value, "plan of b");
    app.unmount();
  });

  void it("reads again, in the new scope, the data a call without a key shows", async () => {
    const { app } = clientApp();
    let account = "a";
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-a"));
    const plan = await app.runWithContext(() =>
      useDmsAsyncData(async () => `plan of ${account}`),
    );
    assert.equal(plan.data.value, "plan of a");

    account = "b";
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    assert.equal(plan.data.value, null, "the other account's data is gone");
    await settle();
    assert.equal(plan.data.value, "plan of b");
  });

  void it("never lets a late answer of the previous scope replace the new one", async () => {
    const answers = { a: deferred<string>(), b: deferred<string>() };
    let account: keyof typeof answers = "a";
    const { shown, root } = toggled("plan", () => answers[account].promise);
    const runtime = createDmsFrontendRuntime();
    runtime.asyncDataScope = "account-a";
    const app = mountRuntime(runtime, root);
    await settle();

    account = "b";
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    answers.b.resolve("plan of b");
    await settle();
    answers.a.resolve("plan of a");
    await settle();
    assert.equal(shown.at(-1), "success:plan of b");
    app.unmount();
  });

  void it("drops the previous key's data a reactive key carries into the new scope", async () => {
    const { app } = clientApp();
    let account = "a";
    const key = ref("first");
    const second = deferred<string>();
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-a"));
    const plan = await app.runWithContext(() =>
      useDmsAsyncData(
        () => key.value,
        async () =>
          key.value === "first" ? `first of ${account}` : second.promise,
      ),
    );
    key.value = "second";
    assert.equal(plan.data.value, "first of a");

    account = "b";
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    assert.equal(plan.data.value, null, "the other account's data is gone");
    assert.equal(plan.placeholder.value, false);
    second.resolve("second of b");
    await settle();
    assert.equal(plan.data.value, "second of b");
  });

  void it("leaves the data a component waits to execute() unread in the new scope", async () => {
    let calls = 0;
    let result: { status: { value: string } } | undefined;
    const Waiting = defineComponent({
      setup() {
        result = useDmsAsyncData(
          "report",
          async () => {
            calls++;
            return "report";
          },
          { immediate: false },
        );
        return () => h("p");
      },
    });
    const runtime = createDmsFrontendRuntime();
    runtime.asyncDataScope = "account-a";
    const app = mountRuntime(runtime, Waiting);
    await settle();
    app.runWithContext(() => runtimeModule.setDmsAsyncDataScope("account-b"));
    await settle();
    assert.equal(calls, 0);
    assert.equal(result?.status.value, "idle");
    app.unmount();
  });
});

void describe("Async data scope from the server", () => {
  void it("finds the data the server transferred under the same scope", async () => {
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

void describe("Plugin order", () => {
  void it("sets the scope from a pre plugin before another module's plugin reads", async () => {
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

void describe("Async data a server cannot transfer", () => {
  void it("leaves a call without a key to the browser, rendering its default", async () => {
    let calls = 0;
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: Parameters<typeof console.warn>) =>
      warnings.push(args[0]);
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

  void it("warns in development about a backend read outside async data", async () => {
    const warnings: unknown[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: Parameters<typeof console.warn>) =>
      warnings.push(args[0]);
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
        runtime.serverFetch = async (url: string) => url;
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

void describe("Async data on a later page", () => {
  void it("keeps showing a key loaded on an earlier page, read again, after a navigation", async () => {
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

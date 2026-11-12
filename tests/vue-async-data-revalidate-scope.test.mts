import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createI18n } from "vue-i18n";
import { defineComponent, h, nextTick } from "vue";
import * as runtimeModule from "../templates/vue/frontend-module.ts";
import {
  clientApp,
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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSSRApp, defineComponent, h, useId } from "vue";
import { createI18n } from "vue-i18n";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const {
  createDmsFrontendRuntime,
  installDmsPlugins,
  provideDmsFrontendRuntime,
  serializeDmsAsyncData,
  setupFrontendModules,
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
import { isFlag, isNumber, isText } from "../src/internal/guards";

type DmsFailure = Error & runtimeModule.DmsErrorData;

function isDmsFailure(value: unknown): value is DmsFailure {
  return (
    value instanceof Error &&
    (!("statusCode" in value) ||
      value.statusCode === undefined ||
      isNumber(value.statusCode)) &&
    (!("statusMessage" in value) ||
      value.statusMessage === undefined ||
      isText(value.statusMessage)) &&
    (!("fatal" in value) || value.fatal === undefined || isFlag(value.fatal))
  );
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
            sdk.registerPlugin(() => {
              useDmsAsyncData("plugin-lazy", handler(40), { lazy: true });
            });
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
          `${status.value}:${isDmsFailure(error.value) ? error.value.statusCode : undefined}`,
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
    const failure = entry.error.value;
    assert.ok(isDmsFailure(failure));
    assert.equal(failure.statusCode, 404);
    assert.deepEqual(failure.data, { message: "orders.not_found" });
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
    const backendFailure = (statusCode: number, data: Record<string, string>) =>
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

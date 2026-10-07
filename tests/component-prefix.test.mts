import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { renderToString } from "@vue/server-renderer";
import {
  type Component,
  createSSRApp,
  defineAsyncComponent,
  defineComponent,
  h,
} from "vue";
import { createI18n } from "vue-i18n";
import {
  createDmsFrontendRuntime,
  installDmsPlugins,
  preloadDmsPage,
  provideDmsFrontendRuntime,
  resolveDmsAsyncComponents,
  resolveDmsComponent,
  setupFrontendModules,
  trackDmsAsyncComponents,
} from "../templates/vue/frontend-module.ts";

function block(label: string): Component {
  return defineComponent({ render: () => h("p", label) });
}

async function rendered(component: Component | undefined): Promise<string> {
  assert.ok(component, "nothing resolves under that name");
  return renderToString(createSSRApp({ render: () => h(component) }));
}

interface LazyBlock {
  component: Component;
  loads: () => number;
}

function lazyBlock(label: string): LazyBlock {
  let loads = 0;
  const component = defineAsyncComponent(async () => {
    loads += 1;
    return block(label);
  });
  return { component, loads: () => loads };
}

let lazyTotals: LazyBlock;
let warn: ReturnType<typeof mock.method>;

/** One evaluation of the modules' entries, as each side of a render runs. */
async function setupModules(): Promise<void> {
  lazyTotals = lazyBlock("billing lazy totals");
  await setupFrontendModules([
    {
      name: "@acme/billing-frontend",
      options: { public: {} },
      module: {
        componentPrefix: "Billing",
        setup(sdk) {
          sdk.registerComponent("Badge", block("billing badge"));
          sdk.registerComponent("lazy-totals", lazyTotals.component);
        },
      },
    },
    {
      name: "@acme/crm-frontend",
      options: { public: {} },
      module: {
        componentPrefix: "Crm",
        setup(sdk) {
          sdk.registerComponent("Badge", block("crm badge"));
        },
      },
    },
    {
      name: "@antelopejs/dms",
      options: { public: {} },
      module: {
        componentPrefix: "Dms",
        setup(sdk) {
          sdk.registerComponent("Badge", block("dms badge"));
        },
      },
    },
    {
      name: "@acme/plain-frontend",
      options: { public: {} },
      module: {
        setup(sdk) {
          sdk.registerComponent("Badge", block("plain badge"));
        },
      },
    },
  ]);
}

beforeEach(async () => {
  warn = mock.method(console, "warn", () => {});
  await setupModules();
});

afterEach(() => {
  warn.mock.restore();
});

describe("Component prefix", () => {
  it("is put in front of every component a module registers", async () => {
    assert.equal(
      await rendered(resolveDmsComponent("BillingBadge")),
      "<p>billing badge</p>",
    );
    assert.equal(
      await rendered(resolveDmsComponent("crm-badge")),
      "<p>crm badge</p>",
    );
    assert.equal(
      await rendered(resolveDmsComponent("billing-lazy-totals")),
      "<p>billing lazy totals</p>",
    );
    assert.equal(warn.mock.callCount(), 0);
  });

  it("keeps a leading Dms apart from an unprefixed name", async () => {
    assert.equal(
      await rendered(resolveDmsComponent("dms-badge")),
      "<p>dms badge</p>",
    );
    assert.equal(
      await rendered(resolveDmsComponent("Badge")),
      "<p>plain badge</p>",
    );
  });

  it("names the global components by their full name", async () => {
    const app = createSSRApp({ render: () => null });
    const runtime = createDmsFrontendRuntime(undefined, {}, true);
    provideDmsFrontendRuntime(app, runtime);
    const i18n = createI18n({ legacy: false, locale: "en", messages: {} });
    await installDmsPlugins(app, i18n.global, runtime, async () => ({}), [
      "en",
    ]);

    const globals = Object.keys(app._context.components);
    for (const name of ["BillingBadge", "CrmBadge", "DmsBadge", "Badge"])
      assert.ok(globals.includes(name), `${name} is not global`);
    assert.ok(globals.includes("BillingLazyTotals"));
  });

  it("warns when two modules register the same full name", async () => {
    await setupFrontendModules([
      {
        name: "@acme/high",
        options: { public: {} },
        module: {
          componentPrefix: "Acme",
          setup(sdk) {
            sdk.registerComponent("Banner", block("high banner"));
          },
        },
      },
      {
        name: "@acme/low",
        options: { public: {} },
        module: {
          componentPrefix: "Acme",
          setup(sdk) {
            sdk.registerComponent("Banner", block("low banner"));
          },
        },
      },
    ]);

    assert.equal(
      await rendered(resolveDmsComponent("AcmeBanner")),
      "<p>high banner</p>",
    );
    assert.equal(warn.mock.callCount(), 1);
    assert.match(
      String(warn.mock.calls[0].arguments[0]),
      /"AcmeBanner" from module "@acme\/low" is ignored: module "@acme\/high"/,
    );
  });

  it("lets a module replace another's component without a warning", async () => {
    await setupFrontendModules([
      {
        name: "@acme/app",
        options: { public: {} },
        module: {
          componentPrefix: "App",
          setup(sdk) {
            sdk.registerComponent("DmsBadge", block("app badge"), {
              prefix: false,
            });
          },
        },
      },
      {
        name: "@antelopejs/dms",
        options: { public: {} },
        module: {
          componentPrefix: "Dms",
          setup(sdk) {
            sdk.registerComponent("Badge", block("dms badge"));
          },
        },
      },
    ]);

    assert.equal(
      await rendered(resolveDmsComponent("DmsBadge")),
      "<p>app badge</p>",
    );
    assert.equal(warn.mock.callCount(), 0);
  });

  it("preloads the components a page names by their full name", async () => {
    const layout = {
      components: { totals: { componentName: "BillingLazyTotals" } },
    };

    await preloadDmsPage({ path: "/billing", page: { layout } });
    assert.equal(lazyTotals.loads(), 1);
  });

  it("resolves before hydration the components the server render reached", async () => {
    const server = createSSRApp({
      render: () => h(resolveDmsComponent("BillingLazyTotals")!),
    });
    const reached = trackDmsAsyncComponents(server);
    assert.equal(await renderToString(server), "<p>billing lazy totals</p>");

    await setupModules();
    await resolveDmsAsyncComponents(JSON.parse(JSON.stringify([...reached])));

    assert.equal(lazyTotals.loads(), 1);
  });
});

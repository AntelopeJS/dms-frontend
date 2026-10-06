import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
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

const BILLING = "@acme/billing-frontend";
const CRM = "@acme/crm-frontend";

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

/** One evaluation of the modules' entries, as each side of a render runs. */
async function setupModules(): Promise<void> {
  lazyTotals = lazyBlock("billing lazy totals");
  await setupFrontendModules([
    {
      name: BILLING,
      options: { public: {} },
      module: {
        setup(sdk) {
          sdk.registerComponent("InvoiceTotals", block("billing totals"), {
            private: true,
          });
          sdk.registerComponent("StatusBadge", block("billing badge"), {
            private: true,
          });
          sdk.registerComponent("LazyTotals", lazyTotals.component, {
            private: true,
          });
          sdk.registerComponent("Chart", block("billing chart"));
        },
      },
    },
    {
      name: CRM,
      options: { public: {} },
      module: {
        setup(sdk) {
          sdk.registerComponent("StatusBadge", block("public badge"));
        },
      },
    },
  ]);
}

beforeEach(setupModules);

describe("Private components", () => {
  it("are left out of the application's global components", async () => {
    const app = createSSRApp({ render: () => null });
    const runtime = createDmsFrontendRuntime(undefined, {}, true);
    provideDmsFrontendRuntime(app, runtime);
    const i18n = createI18n({ legacy: false, locale: "en", messages: {} });
    await installDmsPlugins(app, i18n.global, runtime, async () => ({}), [
      "en",
    ]);

    const globals = Object.keys(app._context.components);
    assert.ok(globals.includes("Chart"));
    assert.ok(globals.includes("StatusBadge"));
    assert.ok(!globals.includes("InvoiceTotals"));
    assert.ok(!globals.includes("LazyTotals"));
  });

  it("resolve only in the page trees of the module that registered them", async () => {
    assert.equal(resolveDmsComponent("InvoiceTotals"), undefined);
    assert.equal(resolveDmsComponent("InvoiceTotals", CRM), undefined);
    assert.equal(
      await rendered(resolveDmsComponent("dms-invoice-totals", BILLING)),
      "<p>billing totals</p>",
    );
  });

  it("take precedence over a public component of the same name on their pages", async () => {
    assert.equal(
      await rendered(resolveDmsComponent("StatusBadge", BILLING)),
      "<p>billing badge</p>",
    );
    assert.equal(
      await rendered(resolveDmsComponent("StatusBadge", CRM)),
      "<p>public badge</p>",
    );
    assert.equal(
      await rendered(resolveDmsComponent("StatusBadge")),
      "<p>public badge</p>",
    );
  });

  it("stay public when registered without the option", async () => {
    assert.equal(
      await rendered(resolveDmsComponent("Chart", CRM)),
      "<p>billing chart</p>",
    );
  });

  it("never resolve for a module registered without a name", async () => {
    await setupFrontendModules([
      {
        options: { public: {} },
        module: {
          setup(sdk) {
            sdk.registerComponent("Orphan", block("orphan"), { private: true });
          },
        },
      },
    ]);

    assert.equal(resolveDmsComponent("Orphan"), undefined);
    assert.equal(resolveDmsComponent("Orphan", ""), undefined);
  });

  it("are preloaded with the page that owns them, and only that one", async () => {
    const layout = { components: { totals: { componentName: "LazyTotals" } } };

    await preloadDmsPage({ path: "/crm", page: { module: CRM, layout } });
    assert.equal(lazyTotals.loads(), 0);

    await preloadDmsPage({
      path: "/billing",
      page: { module: BILLING, layout },
    });
    assert.equal(lazyTotals.loads(), 1);
  });

  it("resolve before hydration when the server render reached them", async () => {
    const server = createSSRApp({
      render: () => h(resolveDmsComponent("LazyTotals", BILLING)!),
    });
    const reached = trackDmsAsyncComponents(server);
    assert.equal(await renderToString(server), "<p>billing lazy totals</p>");

    await setupModules();
    await resolveDmsAsyncComponents(JSON.parse(JSON.stringify([...reached])));

    assert.equal(lazyTotals.loads(), 1);
  });
});

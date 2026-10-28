import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import { defu } from "defu";
import {
  type Component,
  computed,
  createSSRApp,
  defineComponent,
  h,
  toRaw,
} from "vue";
import { createI18n } from "vue-i18n";
import {
  type DmsFrontendModuleRegistration,
  type DmsLayerAppConfig,
  createDmsFrontendRuntime,
  defineDmsPageMeta,
  getDmsDynamicPage,
  getDmsErrorPage,
  getDmsLayout,
  getDmsPage,
  installDmsPlugins,
  navigateDms,
  provideDmsFrontendRuntime,
  resolveDmsAccessRedirect,
  resolveDmsComponent,
  setupFrontendModules,
  updateDmsAppConfig,
  useDmsAppConfig,
  useDmsInjection,
  useDmsRuntimeConfig,
} from "../templates/vue/frontend-module.ts";

interface Calls {
  plugins: string[];
  installs: string[];
  middleware: string[];
}

function block(label: string): Component {
  return defineComponent({ render: () => h("p", label) });
}

async function rendered(component: Component | undefined): Promise<string> {
  assert.ok(component, "nothing is registered under that name");
  return renderToString(createSSRApp({ render: () => h(component) }));
}

/**
 * The two modules of a project, as one evaluation of their `dms.frontend.ts`
 * sets them up: a development server evaluates them again after each change to
 * a layer, so every component, plugin and option object is a new one. `high`
 * comes first, as the generated loader orders modules by descending priority,
 * and both claim the same names.
 */
function evaluateModules(
  generation: number,
  calls: Calls,
): DmsFrontendModuleRegistration[] {
  return ["high", "low"].map((owner) => {
    const label = `${owner} ${generation}`;
    return {
      options: { public: { owner: label, providers: [owner] } },
      module: {
        setup(sdk) {
          const appConfig = useDmsAppConfig();
          Object.assign(
            appConfig,
            defu(appConfig, { owner: label, variants: [owner] }),
          );
          sdk.registerComponent("Block", block(`component ${label}`));
          sdk.registerPage("page", block(`page ${label}`));
          sdk.registerDynamicPage("default", block(`dynamic page ${label}`));
          sdk.registerLayout("Frame", block(`layout ${label}`));
          sdk.registerErrorPage(block(`error page ${label}`));
          sdk.registerAccessRedirect("blocked", `/${owner}/${generation}`);
          sdk.provide("owner", label);
          sdk.use({ install: () => calls.installs.push(label) });
          sdk.registerPlugin(() => {
            calls.plugins.push(label);
          });
          sdk.registerMiddleware("guard", () => {
            calls.middleware.push(`guard ${label}`);
          });
          sdk.registerMiddleware(
            `${owner}-global`,
            () => {
              calls.middleware.push(`global ${label}`);
            },
            { global: true },
          );
        },
      },
    };
  });
}

function noCalls(): Calls {
  return { plugins: [], installs: [], middleware: [] };
}

async function serverApp() {
  const app = createSSRApp({ render: () => null });
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  provideDmsFrontendRuntime(app, runtime);
  const i18n = createI18n({ legacy: false, locale: "en", messages: {} });
  await installDmsPlugins(app, i18n.global, runtime, async () => ({}), ["en"]);
  return { app, runtime };
}

describe("Frontend module setup", () => {
  it("replaces what an earlier setup registered, keeping module priority", async () => {
    const calls = noCalls();
    await setupFrontendModules(evaluateModules(1, calls));
    await setupFrontendModules(evaluateModules(2, calls));

    assert.equal(
      await rendered(resolveDmsComponent("Block")),
      "<p>component high 2</p>",
    );
    assert.equal(
      await rendered(getDmsPage({ path: "/page", page: {} })),
      "<p>page high 2</p>",
    );
    assert.equal(
      await rendered(getDmsDynamicPage()),
      "<p>dynamic page high 2</p>",
    );
    assert.equal(
      await rendered(
        getDmsLayout({
          path: "/page",
          page: { layout: { componentName: "Frame" } },
        }),
      ),
      "<p>layout high 2</p>",
    );
    assert.equal(await rendered(getDmsErrorPage()), "<p>error page high 2</p>");
    assert.equal(resolveDmsAccessRedirect("blocked"), "/high/2");
    assert.equal(useDmsRuntimeConfig().public.owner, "high 2");
    assert.equal(useDmsAppConfig().owner, "high 2");
    const { app, runtime } = await serverApp();
    assert.equal(
      app.runWithContext(() => useDmsInjection("owner")),
      "high 2",
    );
    app.runWithContext(() => defineDmsPageMeta({ middleware: ["guard"] }));
    await runtime.pendingNavigation;
    assert.equal(calls.middleware.at(-1), "guard high 2");
  });

  it("gives a name back to a lower-priority module once the higher one stops claiming it", async () => {
    const claiming = (
      label: string,
      name?: string,
    ): DmsFrontendModuleRegistration => ({
      options: { public: {} },
      module: {
        setup(sdk) {
          if (name) sdk.registerComponent(name, block(label));
        },
      },
    });
    await setupFrontendModules([
      claiming("project override", "Button"),
      claiming("DMS default", "Button"),
    ]);
    assert.equal(
      await rendered(resolveDmsComponent("Button")),
      "<p>project override</p>",
    );

    await setupFrontendModules([
      claiming("project"),
      claiming("DMS default", "Button"),
    ]);
    assert.equal(
      await rendered(resolveDmsComponent("Button")),
      "<p>DMS default</p>",
    );
  });

  it("keeps each module's registrations once however often the modules are set up", async () => {
    const calls = noCalls();
    for (const generation of [1, 2, 3])
      await setupFrontendModules(evaluateModules(generation, calls));

    const { app } = await serverApp();
    assert.deepEqual(calls.plugins, ["high 3", "low 3"]);
    assert.deepEqual(calls.installs, ["high 3", "low 3"]);
    await app.runWithContext(() => navigateDms("/elsewhere"));
    assert.deepEqual(calls.middleware, ["global high 3", "global low 3"]);
    assert.deepEqual(toRaw(useDmsRuntimeConfig().public.providers), [
      "high",
      "low",
    ]);
    assert.deepEqual(toRaw(useDmsAppConfig().variants), ["high", "low"]);
  });

  it("serves the previous registrations until a new setup is complete", async () => {
    await setupFrontendModules([
      {
        options: { public: {} },
        module: {
          setup: (sdk) => sdk.registerComponent("Block", block("old")),
        },
      },
    ]);
    let finishSetup = () => {};
    const setup = setupFrontendModules([
      {
        options: { public: {} },
        module: {
          async setup(sdk) {
            sdk.registerComponent("Block", block("new"));
            await new Promise<void>((resolve) => {
              finishSetup = resolve;
            });
          },
        },
      },
    ]);

    assert.equal(await rendered(resolveDmsComponent("Block")), "<p>old</p>");
    finishSetup();
    await setup;
    assert.equal(await rendered(resolveDmsComponent("Block")), "<p>new</p>");
  });
});

/** A module whose setup only does `setup`, with `useDmsAppConfig()` at hand. */
function configuring(
  setup: (appConfig: Record<string, any>) => void,
): DmsFrontendModuleRegistration {
  return {
    options: { public: {} },
    module: { setup: () => setup(useDmsAppConfig()) },
  };
}

/** The layer configs of a project above the DMS, highest precedence first. */
function layerConfigs(project: Record<string, unknown>): DmsLayerAppConfig[] {
  return [
    { module: "project", config: project },
    {
      module: "dms",
      config: {
        branding: { name: "DMS", logo: { light: "/dms.svg" } },
        ui: { colors: { primary: "dms", neutral: "neutral" } },
      },
    },
  ];
}

describe("Layer app configs", () => {
  it("are merged into the app config before the first module is set up", async () => {
    let seen: unknown;
    await setupFrontendModules(
      [
        configuring((appConfig) => {
          seen = structuredClone(toRaw(appConfig));
        }),
      ],
      layerConfigs({
        branding: { logo: { light: "/project.svg" } },
        ui: { colors: { primary: "green" } },
      }),
    );
    assert.deepEqual(seen, {
      branding: { name: "DMS", logo: { light: "/project.svg" } },
      ui: { colors: { primary: "green", neutral: "neutral" } },
    });
  });

  it("let the modules extend the app config, but never the layers' configs", async () => {
    const layers = layerConfigs({
      branding: { logo: { light: "/project.svg" } },
    });
    const pristine = structuredClone(layers);
    await setupFrontendModules(
      [
        configuring((appConfig) => {
          appConfig.branding.name = "Renamed by a setup";
          appConfig.extra = { addedBy: "setup" };
        }),
      ],
      layers,
    );
    assert.equal(useDmsAppConfig().branding.name, "Renamed by a setup");
    assert.deepEqual(toRaw(useDmsAppConfig().extra), { addedBy: "setup" });
    assert.deepEqual(layers, pristine);
  });

  it("apply an edit in place, under what the setups changed", async () => {
    await setupFrontendModules(
      [configuring((appConfig) => (appConfig.extra = "by setup"))],
      layerConfigs({ branding: { logo: { light: "/v1.svg" } } }),
    );
    const appConfig = useDmsAppConfig() as Record<string, any>;
    const branding = appConfig.branding;
    const logo = computed(() => appConfig.branding.logo.light);
    assert.equal(logo.value, "/v1.svg");

    updateDmsAppConfig(
      layerConfigs({
        branding: { logo: { light: "/v2.svg", dark: "/v2-dark.svg" } },
        ui: { colors: { primary: "green" } },
      }),
    );
    assert.equal(useDmsAppConfig(), appConfig);
    assert.equal(appConfig.branding, branding);
    assert.equal(logo.value, "/v2.svg");
    assert.deepEqual(toRaw(appConfig), {
      branding: {
        name: "DMS",
        logo: { light: "/v2.svg", dark: "/v2-dark.svg" },
      },
      ui: { colors: { primary: "green", neutral: "neutral" } },
      extra: "by setup",
    });

    updateDmsAppConfig(layerConfigs({}));
    assert.equal(logo.value, "/dms.svg");
    assert.equal("dark" in appConfig.branding.logo, false);
    assert.equal(appConfig.ui.colors.primary, "dms");
    assert.equal(appConfig.extra, "by setup");
  });

  it("repeat the arrays of an entry that still merges its own config", async () => {
    const dms = { ui: { button: { compoundVariants: [{ class: "dms" }] } } };
    await setupFrontendModules(
      [
        configuring((appConfig) =>
          Object.assign(appConfig, defu(appConfig, dms)),
        ),
      ],
      [{ module: "dms", config: dms }],
    );
    const variants = () =>
      toRaw((useDmsAppConfig() as Record<string, any>).ui.button)
        .compoundVariants;
    assert.deepEqual(variants(), [{ class: "dms" }, { class: "dms" }]);
    updateDmsAppConfig([{ module: "dms", config: dms }]);
    assert.deepEqual(variants(), [{ class: "dms" }, { class: "dms" }]);
  });
});

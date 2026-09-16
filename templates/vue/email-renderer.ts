import { renderToString } from "@vue/server-renderer";
import { defu } from "defu";
import { type Component, createSSRApp, h } from "vue";
import { createI18n } from "vue-i18n";
import moduleRegistry from "./generated-frontend-modules.json";
import { loadEmailLocaleMessages } from "./email-locales";

interface EmailModule {
  default: Component;
}

interface EmailRegistry {
  serverEmailTemplates: Record<string, () => Promise<EmailModule>>;
  appConfig?: Record<string, unknown>;
}

interface EmailRenderOptions {
  locale?: string;
}

const registries = import.meta.glob<EmailRegistry>(
  "/frontend-modules/*/dms.email.ts",
  { eager: true },
);

const orderedRegistries = moduleRegistry.modules
  .map((module) => registries[`/frontend-modules/${module.id}/dms.email.ts`])
  .filter((registry): registry is EmailRegistry => Boolean(registry));

function templateEntries(): Array<[string, () => Promise<EmailModule>]> {
  return orderedRegistries.flatMap((registry) =>
    Object.entries(registry.serverEmailTemplates),
  );
}

const EMAIL_ELEMENTS: Record<string, string> = {
  EBody: "body",
  EButton: "a",
  EHr: "hr",
  EHtml: "html",
  EImg: "img",
  EText: "p",
  ELink: "a",
  EColumn: "td",
};

function registerEmailElements(app: ReturnType<typeof createSSRApp>): void {
  Object.entries(EMAIL_ELEMENTS).forEach(([name, tag]) => {
    app.component(name, (_props, context) =>
      h(tag, context.attrs, context.slots.default?.()),
    );
  });
  for (const name of ["EContainer", "ESection"]) {
    app.component(name, (_props, { attrs, slots }) =>
      h(
        "table",
        {
          align: "center",
          width: "100%",
          role: "presentation",
          cellSpacing: 0,
          cellPadding: 0,
          border: 0,
          ...attrs,
          style: [
            name === "EContainer" ? { maxWidth: "37.5em" } : {},
            attrs.style,
          ],
        },
        [h("tbody", null, [h("tr", null, [h("td", null, slots.default?.())])])],
      ),
    );
  }
  app.component("EHead", (_props, { attrs, slots }) =>
    h("head", attrs, [h("meta", { charset: "utf-8" }), slots.default?.()]),
  );
  app.component("EHeading", (_props, { attrs, slots }) => {
    const { as, ...attributes } = attrs;
    const tag = typeof as === "string" && /^h[1-6]$/.test(as) ? as : "h1";
    return h(tag, attributes, slots.default?.());
  });
  app.component("ERow", (_props, { attrs, slots }) =>
    h(
      "table",
      {
        role: "presentation",
        width: "100%",
        cellPadding: 0,
        cellSpacing: 0,
        border: 0,
        ...attrs,
      },
      [h("tbody", null, [h("tr", null, slots.default?.())])],
    ),
  );
  app.component("EPreview", (_props, { attrs, slots }) =>
    h(
      "div",
      {
        ...attrs,
        style: [
          attrs.style,
          {
            display: "none",
            overflow: "hidden",
            lineHeight: "1px",
            opacity: 0,
            maxHeight: 0,
            maxWidth: 0,
            msoHide: "all",
          },
        ],
      },
      slots.default?.(),
    ),
  );
}

export async function renderEmail(
  templateName: string,
  props: Record<string, unknown>,
  options: EmailRenderOptions = {},
): Promise<string> {
  const suffix = `/${templateName}.vue`;
  const entry = templateEntries().find(([path]) => path.endsWith(suffix));
  if (!entry) throw new Error(`Unknown email template: ${templateName}`);
  const component = (await entry[1]()).default;
  const app = createSSRApp(component, props);
  const locale = options.locale ?? "en";
  const messages = await loadEmailLocaleMessages(locale);
  app.use(
    createI18n({
      legacy: false,
      locale,
      fallbackLocale: "en",
      messages,
    }),
  );
  app.provide("dmsEmailLocale", locale);
  app.provide(
    "dmsEmailAppConfig",
    defu({}, ...orderedRegistries.map((registry) => registry.appConfig ?? {})),
  );
  const publicConfig = defu(
    {},
    ...moduleRegistry.modules.map((module) => module.options),
  );
  app.provide("dmsEmailRuntimeConfig", {
    public: defu(
      process.env.DMS_CLIENT_URL
        ? { dms: { clientBaseUrl: process.env.DMS_CLIENT_URL } }
        : {},
      publicConfig,
      { dms: { clientBaseUrl: "" } },
    ),
  });
  registerEmailElements(app);
  return `<!doctype html>${await renderToString(app)}`;
}

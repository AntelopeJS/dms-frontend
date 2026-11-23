import { renderToString } from "@vue/server-renderer";
import { defu } from "defu";
import { type Component, createSSRApp, h } from "vue";
import { createI18n } from "vue-i18n";
import { appConfigs } from "./app-configs.generated";
import moduleRegistry from "./generated-frontend-modules.json";
import { loadEmailLocaleMessages } from "./email-locales";
import { stripSsrMarkers } from "./email-markup";
import type { DmsAppConfig } from "./frontend-runtime/types";
import { parsePublicOptions } from "./public-options";

interface EmailModule {
  default: Component;
}

interface EmailRegistry {
  serverEmailTemplates: Record<string, () => Promise<EmailModule>>;
  appConfig?: DmsAppConfig;
}

/** The props of an email template, as Vue takes the props of a root component. */
type EmailProps = NonNullable<Parameters<typeof createSSRApp>[1]>;

type HeadingTag = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function isHeadingTag(value: unknown): value is HeadingTag {
  return typeof value === "string" && /^h[1-6]$/.test(value);
}

interface EmailRenderOptions {
  locale?: string;
}

const runtimeOptions = parsePublicOptions(process.env.DMS_PUBLIC_OPTIONS);

const registries = import.meta.glob<EmailRegistry>(
  "/frontend-modules/*/dms.email.ts",
  { eager: true },
);

const orderedRegistries = moduleRegistry.modules
  .map((module) => registries[`/frontend-modules/${module.id}/dms.email.ts`])
  .filter((registry): registry is EmailRegistry => Boolean(registry));

/**
 * Every app config an email reads, highest precedence first: module by module,
 * by descending priority, what its `dms.email.ts` declares for emails, then
 * its layers' `app/app.config.ts`. A higher-priority module's layers still
 * override a lower one's email config, and a module's own email config, the
 * more specific of its two, keeps the values it gave emails before the layers'
 * configs applied to them.
 */
const emailAppConfigs = moduleRegistry.modules.flatMap((module) => [
  registries[`/frontend-modules/${module.id}/dms.email.ts`]?.appConfig ?? {},
  ...appConfigs
    .filter((layer) => layer.module === module.id)
    .map((layer) => layer.config),
]);

function templateEntries(): Array<[string, () => Promise<EmailModule>]> {
  return orderedRegistries.flatMap((registry) =>
    Object.entries(registry.serverEmailTemplates),
  );
}

const EMAIL_ELEMENTS = {
  EBody: "body",
  EButton: "a",
  EHr: "hr",
  EHtml: "html",
  EImg: "img",
  EText: "p",
  ELink: "a",
  EColumn: "td",
} as const;

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
    const tag = isHeadingTag(as) ? as : "h1";
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
  props: EmailProps,
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
  app.provide("dmsEmailAppConfig", defu({}, ...emailAppConfigs));
  const publicConfig = defu(
    {},
    ...moduleRegistry.modules.map(
      (module) => runtimeOptions?.[module.id] ?? module.options,
    ),
  );
  app.provide("dmsEmailRuntimeConfig", {
    public: defu(
      process.env.DMS_CLIENT_BASE_URL
        ? { dms: { clientBaseUrl: process.env.DMS_CLIENT_BASE_URL } }
        : {},
      publicConfig,
      { dms: { clientBaseUrl: "" } },
    ),
  });
  registerEmailElements(app);
  return `<!doctype html>${stripSsrMarkers(await renderToString(app))}`;
}

import { AsyncLocalStorage } from "node:async_hooks";
import { createInertiaApp } from "@inertiajs/vue3";
import { createHead, renderSSRHead } from "@unhead/vue/server";
import { renderToString } from "@vue/server-renderer";
import { stringify } from "devalue";
import { type App, createSSRApp, h, readonly, type VNode } from "vue";
import { appConfigs } from "./app-configs.generated";
import {
  DMS_PAYLOAD_ID,
  SSR_ASYNC_COMPONENTS_ID,
  configureDmsApp,
  resolveDmsInertiaPage,
  trackDmsAsyncComponents,
} from "./app-runtime";
import {
  type DmsErrorData,
  type DmsFrontendRuntime,
  type DmsInertiaPage,
  type DmsPageProps,
  type DmsPayload,
  type DmsServerFetch,
  createDmsFrontendRuntime,
  hasDmsPage,
  pageErrorData,
  preloadDmsPage,
  resolveDmsAccessRedirect,
  serializeDmsPayload,
  setDmsServerRuntimeResolver,
  setupFrontendModules,
  trackDmsServerScopes,
  withPublicOptions,
} from "./frontend-module";
import { type DmsMessageSubset, SSR_MESSAGES_ID } from "./message-subset";
import { parsePublicOptions } from "./public-options";
import { frontendModules } from "./frontend-modules.generated";
import {
  SSR_ICONS_ID,
  collectDmsIconSymbols,
  dmsIconSprite,
  serializeDmsIcons,
  trackDmsIcons,
} from "./icon-hydration";

export { registerDmsIconCollections } from "./icon-hydration";

export interface DmsSsrPage {
  component: string;
  props: DmsPageProps;
  url: string;
  version: string;
  clearHistory?: boolean;
  encryptHistory?: boolean;
}

export interface DmsSsrResult {
  body: string;
  head: DmsSsrHead;
  overlays: string;
  /**
   * The id of every single-file component the render created, its path from
   * the workspace root as the client manifest keys it: the server links their
   * stylesheets.
   */
  modules: string[];
  error?: DmsErrorData;
  redirect?: string;
  /**
   * The locale of the catalog the page was rendered with: the server preloads
   * that catalog's file, which the browser loads before it hydrates.
   */
  catalogLocale?: string;
}

export interface DmsSsrHead {
  bodyAttrs: string;
  headTags: string;
  htmlAttrs: string;
}

interface ExpectedFailure extends Error {
  statusCode: number;
}

interface DmsSsrContext {
  /** Filled by `@vitejs/plugin-vue`: each component adds its id as it sets up. */
  modules?: Set<string>;
  teleports?: Record<string, string>;
}

/**
 * Holds the runtime rather than being it: every socket, timer and promise a
 * render starts keeps this store for its whole life, and a pooled backend
 * connection then serving an SSE stream lives for hours. Emptied once the
 * render is over, the store no longer ties the render to them.
 */
interface RuntimeStore {
  runtime?: DmsFrontendRuntime;
}

const runtimeStorage = new AsyncLocalStorage<RuntimeStore>();
setDmsServerRuntimeResolver(() => runtimeStorage.getStore()?.runtime);
/** Set while an async data handler runs: its requests are transferred. */
const asyncDataHandlerStorage = new AsyncLocalStorage<boolean>();

function keepSerializable<V>(
  source: Record<string, V>,
  kept: Record<string, V>,
): void {
  for (const [key, value] of Object.entries(source))
    try {
      stringify(value);
      kept[key] = value;
    } catch (error) {
      console.error(`DMS payload: "${key}" cannot be serialized`, error);
    }
}

/**
 * The payload in devalue's format, which keeps what JSON cannot (a Set, a
 * Date). A value it cannot write, such as a class instance a transform
 * returned, is left out rather than failing the page: the browser starts over
 * for that key, as it did before the key was transferred.
 */
function stringifyPayload(payload: DmsPayload): string {
  try {
    return stringify(payload);
  } catch {
    const kept: DmsPayload = { data: {}, errors: {}, state: {} };
    keepSerializable(payload.data, kept.data);
    keepSerializable(payload.errors, kept.errors);
    keepSerializable(payload.state, kept.state);
    return stringify(kept);
  }
}

/** The payload script, escaped like Inertia's page object so that no value can end it. */
function payloadScript(payload: DmsPayload): string {
  const value = stringifyPayload(payload)
    .replaceAll("/", "\\/")
    .replaceAll("<", "\\u003c");
  return `<script id="${DMS_PAYLOAD_ID}" type="application/json">${value}</script>`;
}

function asyncComponentsScript(names: Set<string>): string {
  const value = JSON.stringify([...names]).replaceAll("<", "\\u003c");
  return `<script id="${SSR_ASYNC_COMPONENTS_ID}" type="application/json">${value}</script>`;
}

function messagesScript(subset: DmsMessageSubset | undefined): string {
  if (!subset) return "";
  const value = JSON.stringify(subset).replaceAll("<", "\\u003c");
  return `<script id="${SSR_MESSAGES_ID}" type="application/json">${value}</script>`;
}

function iconsScript(names: Set<string>): string {
  const value = JSON.stringify(serializeDmsIcons(names)).replaceAll(
    "<",
    "\\u003c",
  );
  return `<script id="${SSR_ICONS_ID}" type="application/json">${value}</script>`;
}

await setupFrontendModules(
  withPublicOptions(
    frontendModules,
    parsePublicOptions(process.env.DMS_PUBLIC_OPTIONS),
  ),
  appConfigs,
);

export function isDmsFrontendPage(path: string): boolean {
  return hasDmsPage(path);
}

export function accessRedirect(code: string): string | undefined {
  return resolveDmsAccessRedirect(code);
}

/**
 * Renders the app to HTML, then hands over the payload. It is read as the HTML
 * is complete: data a run settles afterwards was never rendered, and the
 * browser must not hydrate the page with it.
 */
async function renderWithPayload(
  app: App | VNode,
  ssrContext: DmsSsrContext,
  runtime: DmsFrontendRuntime,
  onPayload: (payload: DmsPayload) => void,
): Promise<string> {
  const html = await renderToString(app, ssrContext);
  onPayload(serializeDmsPayload(runtime));
  return html;
}

/** Holds, on the request's runtime, the page Inertia's app sets as it starts. */
function holdInertiaPage(runtime: DmsFrontendRuntime, page: DmsSsrPage): void {
  runtime.inertiaPage = readonly({ flash: {}, ...page }) as DmsInertiaPage;
}

function isExpectedFailure(failure: Error): failure is ExpectedFailure {
  return (
    "statusCode" in failure &&
    Number.isInteger(failure.statusCode) &&
    typeof failure.statusCode === "number" &&
    failure.statusCode >= 400 &&
    failure.statusCode <= 599
  );
}

/**
 * The error a failed render is retried with. An unexpected failure reaches the
 * page as its status code alone, which the DMS error page describes in the
 * visitor's language; the technical cause only reaches the server log.
 */
function errorForPage(failure: Error): DmsErrorData {
  if (isExpectedFailure(failure)) return pageErrorData(failure);
  console.error("DMS page render failed", failure);
  return { statusCode: 500 };
}

export async function renderDmsPage(
  page: DmsSsrPage,
  serverFetch?: DmsServerFetch,
  requestCookies?: string,
): Promise<DmsSsrResult> {
  const runtime = createDmsFrontendRuntime(
    serverFetch,
    {},
    true,
    requestCookies,
  );
  runtime.runAsyncDataHandler = (run) => asyncDataHandlerStorage.run(true, run);
  runtime.inAsyncDataHandler = () =>
    asyncDataHandlerStorage.getStore() === true;
  runtime.devWarnings = import.meta.env.DEV;
  holdInertiaPage(runtime, page);
  const store: RuntimeStore = { runtime };
  try {
    return await runtimeStorage.run(store, () =>
      renderDmsPageWithRuntime(page, runtime, serverFetch),
    );
  } finally {
    store.runtime = undefined;
  }
}

/**
 * Renders the page with the runtime of its request. The runtime's scope stops
 * only once the head and the async data are serialized: both still read state
 * the rendered components own.
 */
async function renderDmsPageWithRuntime(
  page: DmsSsrPage,
  runtime: DmsFrontendRuntime,
  serverFetch?: DmsServerFetch,
): Promise<DmsSsrResult> {
  await preloadDmsPage(page.props);
  let stopScopes = () => {};
  try {
    const head = createHead();
    const ssrContext: DmsSsrContext = {};
    let asyncComponents = new Set<string>();
    let icons = new Set<string>();
    let iconSymbols = new Map<string, string>();
    let payload: DmsPayload = { data: {}, errors: {}, state: {} };
    let catalogLocale: (() => string | undefined) | undefined;
    let messageSubset: (() => DmsMessageSubset | undefined) | undefined;
    const inertiaResult = await createInertiaApp({
      page,
      render: (app: App | VNode) =>
        renderWithPayload(app, ssrContext, runtime, (rendered) => {
          payload = rendered;
        }),
      resolve: resolveDmsInertiaPage,
      async setup({ App, props, plugin }) {
        const app = createSSRApp({ render: () => h(App, props) });
        asyncComponents = trackDmsAsyncComponents(app);
        icons = trackDmsIcons(app);
        iconSymbols = collectDmsIconSymbols(app);
        stopScopes = trackDmsServerScopes(app);
        const configured = await configureDmsApp({
          app,
          head,
          initialPageProps: page.props,
          initialPageUrl: page.url,
          inertiaPlugin: plugin,
          runtime,
          serverFetch,
        });
        catalogLocale = configured.catalogLocale;
        messageSubset = configured.messageSubset;
        return app;
      },
    });
    if (!inertiaResult) throw new Error("Inertia SSR returned no result");
    await runtime.pendingNavigation;
    if (runtime.serverRedirect) {
      return {
        body: "",
        head: { bodyAttrs: "", headTags: "", htmlAttrs: "" },
        overlays: "",
        modules: [],
        redirect: runtime.serverRedirect,
      };
    }
    const failure = runtime.currentError.value;
    if (failure && !page.props.error) {
      const error = errorForPage(failure);
      return renderDmsPage(
        { ...page, props: { ...page.props, error } },
        serverFetch,
        runtime.requestCookies,
      );
    }
    const renderedHead = await renderSSRHead(head);
    return {
      error: page.props.error,
      body: `${inertiaResult.body}${dmsIconSprite(iconSymbols)}${payloadScript(payload)}${asyncComponentsScript(asyncComponents)}${iconsScript(icons)}${messagesScript(messageSubset?.())}`,
      head: {
        bodyAttrs: renderedHead.bodyAttrs,
        headTags: `${inertiaResult.head.join("")}${renderedHead.headTags}`,
        htmlAttrs: renderedHead.htmlAttrs,
      },
      overlays: ssrContext.teleports?.["#dms-overlays"] ?? "",
      modules: [...(ssrContext.modules ?? [])],
      catalogLocale: catalogLocale?.(),
    };
  } finally {
    stopScopes();
    runtime.scope.stop();
  }
}

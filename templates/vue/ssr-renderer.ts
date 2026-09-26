import { AsyncLocalStorage } from "node:async_hooks";
import { createInertiaApp } from "@inertiajs/vue3";
import { createHead, renderSSRHead } from "@unhead/vue/server";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import {
  type DmsServerFetch,
  SSR_ASYNC_COMPONENTS_ID,
  configureDmsApp,
  resolveDmsInertiaPage,
  serializeDmsAsyncData,
  trackDmsAsyncComponents,
} from "./app-runtime";
import {
  type DmsErrorData,
  type DmsFrontendRuntime,
  type DmsPageProps,
  createDmsFrontendRuntime,
  hasDmsPage,
  preloadDmsPage,
  resolveDmsAccessRedirect,
  setDmsServerRuntimeResolver,
  setupFrontendModules,
  trackDmsServerScopes,
} from "./frontend-module";
import { frontendModules } from "./frontend-modules.generated";

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
  error?: DmsErrorData;
  redirect?: string;
}

export interface DmsSsrHead {
  bodyAttrs: string;
  headTags: string;
  htmlAttrs: string;
}

interface DmsSsrContext {
  teleports?: Record<string, string>;
}

const SSR_ASYNC_DATA_ID = "dms-ssr-async-data";
// Holds the runtime rather than being it: every socket, timer and promise a
// render starts keeps this store for its whole life, and a pooled backend
// connection then serving an SSE stream lives for hours. Emptied once the
// render is over, the store no longer ties the render to them.
const runtimeStorage = new AsyncLocalStorage<{
  runtime?: DmsFrontendRuntime;
}>();
setDmsServerRuntimeResolver(() => runtimeStorage.getStore()?.runtime);

function asyncDataScript(runtime: DmsFrontendRuntime): string {
  const value = JSON.stringify(serializeDmsAsyncData(runtime)).replaceAll(
    "<",
    "\\u003c",
  );
  return `<script id="${SSR_ASYNC_DATA_ID}" type="application/json">${value}</script>`;
}

function asyncComponentsScript(names: Set<string>): string {
  const value = JSON.stringify([...names]).replaceAll("<", "\\u003c");
  return `<script id="${SSR_ASYNC_COMPONENTS_ID}" type="application/json">${value}</script>`;
}

await setupFrontendModules(frontendModules);

export function isDmsFrontendPage(path: string): boolean {
  return hasDmsPage(path);
}

export function accessRedirect(code: string): string | undefined {
  return resolveDmsAccessRedirect(code);
}

export async function renderDmsPage(
  page: DmsSsrPage,
  serverFetch?: DmsServerFetch,
  requestCookies?: string,
): Promise<DmsSsrResult> {
  const runtime = createDmsFrontendRuntime(
    serverFetch as typeof import("ofetch").ofetch,
    {},
    true,
    requestCookies,
  );
  const store = { runtime };
  try {
    return await runtimeStorage.run(store, () =>
      renderDmsPageWithRuntime(page, runtime, serverFetch),
    );
  } finally {
    store.runtime = undefined;
  }
}

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
    const inertiaResult = await createInertiaApp({
      page,
      render: (app) => renderToString(app, ssrContext),
      resolve: resolveDmsInertiaPage,
      async setup({ App, props, plugin }) {
        const app = createSSRApp({ render: () => h(App, props) });
        asyncComponents = trackDmsAsyncComponents(app);
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
        redirect: runtime.serverRedirect,
      };
    }
    if (runtime.currentError.value && !page.props.error) {
      const failure = runtime.currentError.value as Error & DmsErrorData;
      const expected =
        Number.isInteger(failure.statusCode) &&
        failure.statusCode! >= 400 &&
        failure.statusCode! <= 599;
      const error = {
        statusCode: expected ? failure.statusCode : 500,
        message: expected ? failure.message : "An unexpected error occurred",
        statusMessage: expected ? failure.statusMessage : "Application error",
      };
      return renderDmsPage(
        { ...page, props: { ...page.props, error } },
        serverFetch,
        runtime.requestCookies,
      );
    }
    const renderedHead = await renderSSRHead(head);
    return {
      error: page.props.error,
      body: `${inertiaResult.body}${asyncDataScript(runtime)}${asyncComponentsScript(asyncComponents)}`,
      head: {
        bodyAttrs: renderedHead.bodyAttrs,
        headTags: `${inertiaResult.head.join("")}${renderedHead.headTags}`,
        htmlAttrs: renderedHead.htmlAttrs,
      },
      overlays: ssrContext.teleports?.["#dms-overlays"] ?? "",
    };
  } finally {
    // Only once the head and the async data are serialized: both still read
    // state the rendered components own.
    stopScopes();
    runtime.scope.stop();
  }
}

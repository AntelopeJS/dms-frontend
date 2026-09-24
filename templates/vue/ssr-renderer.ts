import { AsyncLocalStorage } from "node:async_hooks";
import { createInertiaApp } from "@inertiajs/vue3";
import { createHead, renderSSRHead } from "@unhead/vue/server";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import {
  type DmsServerFetch,
  configureDmsApp,
  resolveDmsInertiaPage,
  serializeDmsAsyncData,
} from "./app-runtime";
import {
  type DmsErrorData,
  type DmsFrontendRuntime,
  type DmsPageProps,
  createDmsFrontendRuntime,
  hasDmsPage,
  preloadDmsPage,
  setDmsServerRuntimeResolver,
  setupFrontendModules,
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
const runtimeStorage = new AsyncLocalStorage<DmsFrontendRuntime>();
setDmsServerRuntimeResolver(() => runtimeStorage.getStore());

function asyncDataScript(runtime: DmsFrontendRuntime): string {
  const value = JSON.stringify(serializeDmsAsyncData(runtime)).replaceAll(
    "<",
    "\\u003c",
  );
  return `<script id="${SSR_ASYNC_DATA_ID}" type="application/json">${value}</script>`;
}

await setupFrontendModules(frontendModules);

export function isDmsFrontendPage(path: string): boolean {
  return hasDmsPage(path);
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
  return runtimeStorage.run(runtime, () =>
    renderDmsPageWithRuntime(page, runtime, serverFetch),
  );
}

async function renderDmsPageWithRuntime(
  page: DmsSsrPage,
  runtime: DmsFrontendRuntime,
  serverFetch?: DmsServerFetch,
): Promise<DmsSsrResult> {
  await preloadDmsPage(page.props);
  const head = createHead();
  const ssrContext: DmsSsrContext = {};
  const inertiaResult = await createInertiaApp({
    page,
    render: (app) => renderToString(app, ssrContext),
    resolve: resolveDmsInertiaPage,
    async setup({ App, props, plugin }) {
      const app = createSSRApp({ render: () => h(App, props) });
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
    body: `${inertiaResult.body}${asyncDataScript(runtime)}`,
    head: {
      bodyAttrs: renderedHead.bodyAttrs,
      headTags: `${inertiaResult.head.join("")}${renderedHead.headTags}`,
      htmlAttrs: renderedHead.htmlAttrs,
    },
    overlays: ssrContext.teleports?.["#dms-overlays"] ?? "",
  };
}

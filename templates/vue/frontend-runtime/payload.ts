import {
  getCurrentInstance,
  onServerPrefetch,
  type Ref,
  ref,
  toRaw,
} from "vue";
import {
  type DmsAppConfig,
  type DmsErrorData,
  type DmsPayload,
  type DmsRuntimeConfig,
  type DmsStateOptions,
} from "./types";
import {
  type DmsFrontendRuntime,
  type DmsMiddleware,
} from "./module-registration";
import { serializeDmsAsyncData } from "./data-access";
import { appConfig, runtimeConfig, useDmsRuntime } from "./state";
import { runMiddleware, visit } from "./route";
import { failPage } from "./ui";

const HTTP_ERROR_STATUS = { min: 400, max: 599 };
const SERVER_FAILURE_STATUS = 500;
const FETCH_ERROR_NAME = "FetchError";

/** The fields of a failure, under the names `createDmsError` and ofetch use. */
interface DmsFailure extends DmsErrorData {
  name?: string;
  status?: number;
  statusText?: string;
}

/**
 * What of a failure a page may carry, by the rule the error page follows: an
 * HTTP failure keeps its status, status text and message, and its body if it
 * is a 4xx, anything else
 * is a server failure whose cause only reaches the server log. A fetch error
 * names the URL it requested, which on a server is the backend's own address:
 * its status text stands for it.
 */
function transferredError(key: string, reason: unknown): DmsErrorData {
  const failure = (reason ?? {}) as DmsFailure;
  const statusCode = failure.statusCode ?? failure.status;
  if (
    statusCode === undefined ||
    !Number.isInteger(statusCode) ||
    statusCode < HTTP_ERROR_STATUS.min ||
    statusCode > HTTP_ERROR_STATUS.max
  ) {
    console.error(`DMS async data "${key}" failed`, reason);
    return { statusCode: SERVER_FAILURE_STATUS };
  }
  const statusMessage = failure.statusMessage ?? failure.statusText;
  const transferred: DmsErrorData = {
    statusCode,
    statusMessage,
    message:
      failure.name === FETCH_ERROR_NAME ? statusMessage : failure.message,
  };
  // A 5xx body is the backend's own account of its failure, a stack or a
  // query at times: only a 4xx body, written for the client, is transferred.
  if (statusCode < SERVER_FAILURE_STATUS) transferred.data = failure.data;
  return transferred;
}

/**
 * What a page's error page shows of an expected failure (a 4xx or 5xx): its
 * status code, status text and message. A fetch error's message names the URL
 * it requested, on a server the backend's own address: its status text
 * stands for it.
 */
export function pageErrorData(failure: Error & DmsErrorData): DmsErrorData {
  return {
    statusCode: failure.statusCode,
    message:
      failure.name === FETCH_ERROR_NAME
        ? failure.statusMessage
        : failure.message,
    statusMessage: failure.statusMessage,
  };
}

/**
 * Everything a server render hands the browser: the data and the failures of
 * its keys, and the state keys opted into. Read as the HTML is complete.
 */
export function serializeDmsPayload(runtime: DmsFrontendRuntime): DmsPayload {
  const errors = [...runtime.asyncData.entries()]
    .filter(([, entry]) => entry.status.value === "error")
    .map(([key, entry]): [string, DmsErrorData] => [
      key,
      transferredError(key, entry.error.value),
    ]);
  const state = [...runtime.transferredState]
    .map((key): [string, unknown] => [
      key,
      toRaw(runtime.sharedState.get(key)?.value),
    ])
    .filter(([, value]) => value !== undefined);
  return {
    data: serializeDmsAsyncData(runtime),
    errors: Object.fromEntries(errors),
    state: Object.fromEntries(state),
  };
}

/** Starts a browser runtime from what the server rendered. */
export function restoreDmsPayload(
  runtime: DmsFrontendRuntime,
  payload: Partial<DmsPayload>,
): void {
  runtime.hydrating = true;
  for (const [key, value] of Object.entries(payload.data ?? {}))
    runtime.hydratedAsyncData.set(key, value);
  for (const [key, failure] of Object.entries(payload.errors ?? {}))
    runtime.hydratedAsyncErrors.set(key, failure);
  for (const [key, value] of Object.entries(payload.state ?? {}))
    runtime.sharedState.set(key, ref(value));
}

export function useDmsState<T>(
  key: string,
  init?: () => T,
  options: DmsStateOptions = {},
): Ref<T> {
  const runtime = useDmsRuntime();
  if (options.transfer) runtime.transferredState.add(key);
  if (!runtime.sharedState.has(key))
    runtime.sharedState.set(key, ref(init?.()));
  return runtime.sharedState.get(key) as Ref<T>;
}
export function useDmsRuntimeConfig(): DmsRuntimeConfig {
  return runtimeConfig.value;
}
export function useDmsAppConfig(): DmsAppConfig {
  return appConfig.value as DmsAppConfig;
}
export function defineDmsAppConfig<T extends Record<string, unknown>>(
  config: T,
): T {
  return config;
}
export function defineDmsMiddleware(handler: DmsMiddleware): DmsMiddleware {
  return handler;
}
export function defineDmsPageMeta(meta: Record<string, unknown>): void {
  const runtime = useDmsRuntime();
  Object.assign(runtime.route.meta, meta);
  // A middleware that throws fails the page, as in Nuxt: the error page
  // shows in its place with the error's status code, which a server render
  // answers with. A redirect another navigation decided still wins.
  const navigation = runMiddleware(runtime, runtime.route)
    .then(async (result) => {
      if (result !== undefined && result !== false)
        await visit(runtime, result);
    })
    .catch((reason) => failPage(runtime, reason));
  runtime.pendingNavigation = runtime.pendingNavigation
    ? Promise.all([runtime.pendingNavigation, navigation]).then(() => undefined)
    : navigation;
  void runtime.pendingNavigation;
  // A server renders the page's subtree once its middleware is done, so the
  // state a middleware sets is the one the HTML shows and the payload carries.
  // A failure shows the error page in its place (`failPage`). Registered
  // in the browser too, where only a server calls it: both sides must agree
  // on the async boundaries `useId()` counts.
  if (getCurrentInstance())
    onServerPrefetch(() => navigation.then(ignoreSettlement, ignoreSettlement));
}
function ignoreSettlement(): void {}

import { type FetchOptions, ofetch } from "ofetch";
import { isRef, type MaybeRefOrGetter, toValue, watch } from "vue";
import { type DmsFrontendRuntime } from "./module-registration";
import { useDmsRuntime } from "./state";
import {
  type DmsAsyncDataHandler,
  type DmsAsyncDataResult,
  type UseAsyncDataOptions,
  type UseFetchOptions,
} from "./types";
import { useDmsAsyncData } from "./async-data";

/**
 * The options of a request a runtime makes. A server render does not retry a
 * failed read, as ofetch would once: the page waits for it, and a backend
 * failing once mostly fails twice. A browser keeps ofetch's retries, and a
 * caller that names its own keeps them everywhere.
 */
function runtimeFetchOptions(
  runtime: DmsFrontendRuntime,
  options: FetchOptions,
): FetchOptions {
  return runtime.isServer && options.retry === undefined
    ? { ...options, retry: 0 }
    : options;
}

const warnedServerReads = new Set<string>();

/**
 * Warns, in a development server render, about a backend read no async data
 * handler makes: an immediate watcher's, a setup's own `await $fetch`, a
 * middleware's. The server waits for it, but the page carries none of it, so
 * the browser reads it again and may hydrate with other data. Code that hands
 * the answer over itself (`useDmsState` with `transfer: true`) looks the same
 * from here, so the message names that exception rather than guess.
 */
function warnUntransferredRead(
  runtime: DmsFrontendRuntime,
  request: string,
): void {
  if (
    !runtime.isServer ||
    !runtime.devWarnings ||
    !runtime.inAsyncDataHandler ||
    runtime.inAsyncDataHandler() ||
    warnedServerReads.has(request)
  )
    return;
  warnedServerReads.add(request);
  console.warn(
    `DMS: ${request} was read during a server render outside useDmsFetch and useDmsAsyncData ` +
      "(an immediate watcher, a setup's own await, a middleware): unless the code hands the " +
      "answer over (useDmsState with transfer: true), the page does not carry it and the " +
      "browser reads it again. Load it with useDmsFetch or useDmsAsyncData, in a middleware " +
      "or a plugin too, or leave it to the browser (server: false, onMounted).",
  );
}

function createDmsFetch(defaults: FetchOptions = {}): typeof ofetch {
  const execute = (request: string, options?: FetchOptions) => {
    const runtime = useDmsRuntime();
    warnUntransferredRead(runtime, request);
    return (runtime.serverFetch ?? ofetch)(
      request,
      runtimeFetchOptions(runtime, { ...defaults, ...options }),
    );
  };
  return Object.assign(execute, {
    create: (options: FetchOptions) =>
      createDmsFetch({ ...defaults, ...options }),
    native: ofetch.native,
    raw: ofetch.raw,
  }) as typeof ofetch;
}

export const $fetch = createDmsFetch();

/** JSON with sorted keys, or nothing for a value JSON cannot stand for. */
function stableJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value);
  if (typeof value !== "object")
    return ["string", "number", "boolean"].includes(typeof value)
      ? JSON.stringify(value)
      : undefined;
  if (Array.isArray(value)) {
    const items = value.map(stableJson);
    return items.includes(undefined) ? undefined : `[${items.join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((name) => record[name] !== undefined)
    .sort()
    .map((name) => {
      const member = stableJson(record[name]);
      return member === undefined
        ? undefined
        : `${JSON.stringify(name)}:${member}`;
    });
  return members.includes(undefined) ? undefined : `{${members.join(",")}}`;
}

const FETCH_KEY_PREFIX = "$dmsfetch:";
const DEFAULT_FETCH_METHOD = "GET";

// cyrb53's mixing constants, with its two 32-bit lanes both kept: a 64-bit
// digest, as short as Nuxt's keys and as unlikely to collide within a page.
const HASH_SEEDS = [0xdeadbeef, 0x41c6ce57];
const HASH_MULTIPLIERS = [2654435761, 1597334677];
const HASH_FINALIZERS = [2246822507, 3266489909];
const HASH_SHIFTS = [16, 13];
const HASH_RADIX = 36;
const HASH_LANE_LENGTH = 7;

/**
 * A short digest of a text, the same in a server and in a browser: pure
 * JavaScript, so no `node:crypto` reaches a browser bundle.
 */
function hashText(text: string): string {
  let [first, second] = HASH_SEEDS;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, HASH_MULTIPLIERS[0]);
    second = Math.imul(second ^ code, HASH_MULTIPLIERS[1]);
  }
  first = Math.imul(first ^ (first >>> HASH_SHIFTS[0]), HASH_FINALIZERS[0]);
  first ^= Math.imul(second ^ (second >>> HASH_SHIFTS[1]), HASH_FINALIZERS[1]);
  second = Math.imul(second ^ (second >>> HASH_SHIFTS[0]), HASH_FINALIZERS[0]);
  second ^= Math.imul(first ^ (first >>> HASH_SHIFTS[1]), HASH_FINALIZERS[1]);
  return [second, first]
    .map((lane) =>
      (lane >>> 0).toString(HASH_RADIX).padStart(HASH_LANE_LENGTH, "0"),
    )
    .join("");
}

/**
 * The key a request's response is shared and transferred under: a digest of
 * its method, base URL, URL, query and params, and body, the headers aside. A
 * server render writes the key into its HTML, which must not show the URL, a
 * token in its query or a body. A body only a request can read, such as a
 * FormData, gives none.
 */
function requestKey(url: string, options: FetchOptions): string | undefined {
  // ofetch sends the params and the query together, the query winning.
  const query =
    options.query || options.params
      ? { ...options.params, ...options.query }
      : null;
  const request = stableJson([
    (options.method ?? DEFAULT_FETCH_METHOD).toUpperCase(),
    options.baseURL ?? "",
    url,
    query,
    options.body ?? null,
  ]);
  return request === undefined
    ? undefined
    : `${FETCH_KEY_PREFIX}${hashText(request)}`;
}

/** The parts of a request its key is computed from. */
export type DmsRequestKeyOptions = Pick<
  FetchOptions,
  "method" | "baseURL" | "query" | "params" | "body"
>;

/**
 * The key `useDmsFetch` loads a request's response under, without the scope
 * (`setDmsAsyncDataScope`): what `refreshDmsData(keys)` takes, and what a
 * test compares with the keys it finds. `undefined` for a body only a
 * request can read, such as a FormData.
 *
 * @param url The URL as given to `useDmsFetch`, before the base URL and the query
 * @param options The method, base URL, query, params and body of the request
 */
export function dmsRequestKey(
  url: string,
  options: DmsRequestKeyOptions = {},
): string | undefined {
  return requestKey(url, options);
}

/** A URL to request, or nothing to request while it is null or undefined. */
type DmsFetchRequest = string | null | undefined;

function isReactiveSource(value: unknown): boolean {
  return isRef(value) || typeof value === "function";
}

/** The options given, without the ones left undefined. */
function definedOptions(options: FetchOptions): FetchOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as FetchOptions;
}

/**
 * Fetches a URL as `useDmsAsyncData` loads its data, under the key of the
 * request, so that the callers of one request share it and a server render
 * transfers it. A ref or a getter for the URL, the method, the query, the
 * params or the body moves the caller to the key of each request; a URL that
 * is null or undefined requests nothing.
 */
export function useDmsFetch<T>(
  request: MaybeRefOrGetter<DmsFetchRequest>,
  options: UseFetchOptions<T> = {},
): DmsAsyncDataResult<T> {
  const runtime = useDmsRuntime();
  const {
    key,
    immediate,
    lazy,
    server,
    watch: sources,
    default: fallback,
    transform,
    pick,
    deep,
    dedupe,
    refreshOnPageRefresh,
    refreshInterval,
    $fetch: fetcher,
    method,
    query,
    params,
    body,
    ...fixedOptions
  } = options;
  const url = () => toValue(request);
  const requestOptions = (): FetchOptions =>
    definedOptions({
      ...fixedOptions,
      method: toValue(method),
      query: toValue(query),
      params: toValue(params),
      body: toValue(body),
    });
  // A `$fetch` of the caller's own applies its own retries. The transform
  // runs here, where the request a response answers is known: a reactive URL
  // may have changed since it was sent.
  const handler: DmsAsyncDataHandler<T> = async ({ signal }) => {
    const target = url() as string;
    const sent = requestOptions();
    const runKey =
      key === undefined
        ? requestKey(target, sent)
        : (toValue(key) ?? undefined);
    const value: unknown = await (fetcher
      ? fetcher(target, { ...sent, signal })
      : (runtime.serverFetch ?? ofetch)(
          target,
          runtimeFetchOptions(runtime, { ...sent, signal }),
        ));
    if (!transform) return value as T;
    return transform(value, { key: runKey, url: target });
  };
  const asyncOptions: UseAsyncDataOptions<T> = {
    immediate,
    lazy,
    server,
    watch: sources,
    default: fallback,
    pick,
    deep,
    dedupe,
    refreshOnPageRefresh,
    refreshInterval,
  };
  const reactiveSources = [request, method, query, params, body].filter(
    isReactiveSource,
  );
  const isReactive = reactiveSources.length > 0;
  // The request gives its key, which follows the request as it changes.
  const derived = (): string | null | undefined => {
    const target = url();
    return target == null ? null : requestKey(target, requestOptions());
  };
  if (key === undefined && derived() !== undefined)
    return useDmsAsyncData(
      isReactive ? derived : derived(),
      handler,
      asyncOptions,
    );
  // The key the caller names, or none for a body without one, stays put while
  // the request changes: the request is watched instead.
  const watched =
    isReactive && sources !== false
      ? [...reactiveSources, ...(sources ?? [])]
      : sources;
  if (key === undefined)
    return useDmsAsyncData(handler, undefined, {
      ...asyncOptions,
      watch: watched,
    });
  const named = () => (url() == null ? null : toValue(key));
  const followsKey = isReactiveSource(request) || isReactiveSource(key);
  return useDmsAsyncData(followsKey ? named : named(), handler, {
    ...asyncOptions,
    watch: watched,
  });
}

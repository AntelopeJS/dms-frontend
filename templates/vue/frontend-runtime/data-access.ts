import {
  computed,
  getCurrentInstance,
  type MaybeRefOrGetter,
  onServerPrefetch,
  toRaw,
  toValue,
} from "vue";
import { type DmsAsyncDataKey, type DmsData } from "./types";
import { useDmsRuntime } from "./state";
import {
  asyncDataEntries,
  MAX_UNUSED_ASYNC_DATA,
  scopedKey,
} from "./async-data-entry";
import { type DmsFrontendRuntime } from "./module-registration";

/**
 * The data another caller loads under `key`, as Nuxt's `useNuxtData`: to
 * update it in place without reading it again, from what a write answered
 * (an optimistic update) or what a realtime event says changed. It follows
 * the key in the runtime's scope (`setDmsAsyncDataScope`): `undefined` until
 * a caller loads the key, its data once there, `undefined` again once the
 * browser lets the key go (past the most recent keys it keeps) or the scope
 * changes. It does not load the key, nor keep it.
 */
export function useDmsData<T>(
  key: MaybeRefOrGetter<DmsAsyncDataKey>,
): DmsData<T> {
  const runtime = useDmsRuntime();
  const entry = () => {
    const name = toValue(key);
    const result =
      name == null
        ? undefined
        : runtime.asyncData.get(scopedKey(runtime, String(name)));
    return result && asyncDataEntries.get(result);
  };
  // A component after the caller, in the page or in its subtree, renders the
  // data the browser hydrates it with: the server waits for the caller's run
  // too. One before it has none on either side. Whether the key is there as
  // the setup runs is the same on both sides, and so are the async
  // boundaries `useId()` counts.
  const loaded = entry();
  if (loaded && getCurrentInstance()) onServerPrefetch(() => loaded.settled());
  return {
    data: computed({
      get() {
        // An entry only ever holds its own key's data: a caller showing the
        // previous key's data meanwhile keeps it in its own refs.
        return (entry()?.result.data.value ?? undefined) as T | undefined;
      },
      set(value) {
        const current = entry();
        if (!current) return;
        current.result.data.value = value ?? null;
      },
    }),
  };
}

/** Reads the data of the keys given, or of every key, again. */
export async function refreshDmsData(keys?: string | string[]): Promise<void> {
  const runtime = useDmsRuntime();
  const selected = keys
    ? (Array.isArray(keys) ? keys : [keys]).map((key) =>
        scopedKey(runtime, key),
      )
    : [...runtime.asyncData.keys()];
  await Promise.all(
    selected.map((key) => runtime.asyncData.get(key)?.refresh()),
  );
}

/**
 * Reads again the data the components on screen show, but those that opted
 * out (`refreshOnPageRefresh: false`) and those waiting for `execute()`:
 * what a page calls once something changed what it shows, after a save or
 * on a realtime event, instead of each component refreshing its own.
 */
export async function refreshDmsPageData(): Promise<void> {
  const runtime = useDmsRuntime();
  await Promise.all(
    [...runtime.boundAsyncData].map((entry) => entry.pageRefresh()),
  );
}

/**
 * Puts the keys of the async data in a scope, such as a digest of the
 * account and the workspace: the same key in another scope is another
 * entry, never the data of the previous one. Moving to another scope drops
 * the data of every key, aborting its runs; the components on screen then
 * show their default until they load again. Call it on both sides before
 * the page renders, with the same value, so the browser finds the data the
 * server transferred; the scope is written in the page with each key, so a
 * digest rather than an identifier. Call it from a plugin registered with
 * `{ enforce: "pre" }`: a plugin of another module that reads data at setup
 * would otherwise run first, and the new scope abort its read.
 *
 * @param scope The scope, or `undefined` for none
 */
export function setDmsAsyncDataScope(scope: string | undefined): void {
  const runtime = useDmsRuntime();
  if (runtime.asyncDataScope === scope) return;
  runtime.asyncDataScope = scope;
  for (const result of runtime.asyncData.values()) result.clear();
  runtime.asyncData.clear();
}

/**
 * Drops the data no component shows any more, but the most recently shown:
 * a return to a key shows its data at once, and the data does not pile up
 * over a session.
 */
export function dropUnusedAsyncData(runtime: DmsFrontendRuntime): void {
  const unused = [...runtime.asyncData]
    .map(([key, result]) => ({ key, entry: asyncDataEntries.get(result) }))
    .filter(({ entry }) => entry?.unused())
    .sort((left, right) => right.entry!.lastShown() - left.entry!.lastShown());
  for (const { key } of unused.slice(MAX_UNUSED_ASYNC_DATA))
    runtime.asyncData.delete(key);
}

export function serializeDmsAsyncData(
  runtime: DmsFrontendRuntime,
): Record<string, unknown> {
  return Object.fromEntries(
    [...runtime.asyncData.entries()]
      .filter(([, entry]) => entry.status.value === "success")
      .map(([key, entry]) => [key, toRaw(entry.data.value)]),
  );
}

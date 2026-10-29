import {
  computed,
  getCurrentInstance,
  getCurrentScope,
  type MaybeRefOrGetter,
  nextTick,
  onBeforeMount,
  onMounted,
  onScopeDispose,
  onServerPrefetch,
  type Ref,
  type ShallowRef,
  shallowRef,
  toValue,
  watch,
} from "vue";
import {
  type DmsAsyncData,
  type DmsAsyncDataHandler,
  type DmsAsyncDataKey,
  type DmsAsyncDataResult,
  type UseAsyncDataOptions,
} from "./types";
import { useDmsRuntime } from "./state";
import { type DmsFrontendRuntime } from "./module-registration";
import {
  type AsyncDataBindingHandle,
  asyncDataEntry,
  type AsyncDataEntry,
} from "./async-data-entry";

/**
 * Loads data once for every component that shows the same key, with Nuxt's
 * semantics: a server render waits for it before rendering, and transfers it,
 * whether or not the caller awaits it; `lazy` only spares client navigations
 * the wait; `server: false` leaves it to the browser.
 *
 * In the browser, data loaded before is shown at once and read again in the
 * background on each mount and each return to its key (stale while
 * revalidate), except while the page the server rendered hydrates: its data
 * is the server's, just read.
 *
 * A call without a key cannot be transferred: the server leaves it to the
 * browser, as `server: false` does, so the page hydrates with what it shows.
 */
export function useDmsAsyncData<T>(
  keyOrHandler: MaybeRefOrGetter<DmsAsyncDataKey> | DmsAsyncDataHandler<T>,
  handler?: DmsAsyncDataHandler<T>,
  callerOptions: UseAsyncDataOptions<T> = {},
): DmsAsyncDataResult<T> {
  const runtime = useDmsRuntime();
  // A call outside any scope (a plugin past its first await, a callback)
  // belongs to the application: its watchers and its polling live as long.
  if (getCurrentScope() || !runtime.scope.active)
    return createAsyncDataCall(runtime, keyOrHandler, handler, callerOptions);
  return runtime.scope.run(() =>
    createAsyncDataCall(runtime, keyOrHandler, handler, callerOptions),
  )!;
}

function createAsyncDataCall<T>(
  runtime: DmsFrontendRuntime,
  keyOrHandler: MaybeRefOrGetter<DmsAsyncDataKey> | DmsAsyncDataHandler<T>,
  handler: DmsAsyncDataHandler<T> | undefined,
  callerOptions: UseAsyncDataOptions<T>,
): DmsAsyncDataResult<T> {
  // With a handler second, the first argument is the key: a string, or a ref
  // or getter whose changes move the caller to the data of another key.
  const keySource = handler
    ? (keyOrHandler as MaybeRefOrGetter<DmsAsyncDataKey>)
    : undefined;
  const execute = handler ?? keyOrHandler;
  if (typeof execute !== "function")
    throw new Error("useDmsAsyncData requires a handler");
  const keyless = keySource === undefined;
  if (keyless && runtime.isServer && runtime.devWarnings)
    console.warn(
      "DMS: useDmsAsyncData without a key, or useDmsFetch with a body it cannot key, " +
        "is left to the browser: give it a key for the server to render it.",
    );
  const options: UseAsyncDataOptions<T> = keyless
    ? { ...callerOptions, server: false }
    : callerOptions;
  const inComponent = getCurrentInstance() !== null;
  const consumer = shallowRef(
    attachAsyncData(
      runtime,
      keyless ? undefined : (toValue(keySource) ?? null),
      execute as DmsAsyncDataHandler<T>,
      options,
      inComponent,
    ),
  );
  if (getCurrentScope()) onScopeDispose(() => consumer.value.unbind());
  if (options.watch && options.watch.length)
    refreshOnWatchedChange(consumer, options.watch);
  // Registered in the browser too, though only a server calls it: Vue makes
  // a component that prefetches an async boundary, which shifts the ids
  // `useId()` gives the components after it, and both sides must agree. It
  // waits for the key the caller is on by then, which its setup may have set.
  let prefetched = false;
  if (inComponent && options.immediate !== false && options.server !== false)
    onServerPrefetch(() => {
      prefetched = true;
      return consumer.value.entry.settled();
    });
  pollAsyncData(runtime, consumer, options);
  const { entry } = consumer.value;
  const waited = startAsyncData(runtime, entry, options, inComponent);
  const result =
    keySource == null || typeof keySource === "string"
      ? entry.result
      : followAsyncDataKey(
          runtime,
          consumer,
          keySource,
          execute as DmsAsyncDataHandler<T>,
          options,
          inComponent,
          () => !prefetched,
        );
  return Object.assign(
    Promise.resolve(waited).then(() => result),
    result,
  );
}

/**
 * Reads the data again when a watched source changes, but when the caller's
 * key moved in the same turn: the new key's own read already has the change.
 */
function refreshOnWatchedChange<T>(
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  sources: unknown[],
): void {
  let moved = false;
  watch(
    () => consumer.value.entry,
    () => {
      moved = true;
      void nextTick(() => {
        moved = false;
      });
    },
    { flush: "sync" },
  );
  watch(sources as never[], () => {
    if (!moved) void consumer.value.entry.result.refresh();
  });
}

/**
 * Reads the data again every `refreshInterval`, in the browser, following
 * the interval as it changes: none, `0` or `null` stops it.
 */
function pollAsyncData<T>(
  runtime: DmsFrontendRuntime,
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  options: UseAsyncDataOptions<T>,
): void {
  const interval = options.refreshInterval;
  if (runtime.isServer || interval === undefined) return;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  watch(
    () => toValue(interval),
    (period) => {
      stop();
      if (period && period > 0)
        timer = setInterval(() => pollOnce(consumer, options), period);
    },
    { immediate: true },
  );
  if (getCurrentScope()) onScopeDispose(stop);
}

function pollOnce<T>(
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  options: UseAsyncDataOptions<T>,
): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden")
    return;
  const result = consumer.value.entry.result;
  // Data a caller waits to `execute()` is not read before it is.
  if (result.status.value === "idle" && options.immediate === false) return;
  void result.refresh({ dedupe: "defer" });
}

/**
 * Starts the run a caller needs, where its side needs it, and returns what
 * awaiting the call waits for.
 */
function startAsyncData<T>(
  runtime: DmsFrontendRuntime,
  entry: AsyncDataEntry<T>,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
): Promise<void> | undefined {
  const immediate = options.immediate !== false;
  const onServer = options.server !== false;
  const idle = entry.result.status.value === "idle";
  if (runtime.isServer) {
    if (!immediate || !onServer) return undefined;
    // A render that already answers a redirect throws its HTML away: what it
    // still has to read would reach nobody.
    if (runtime.serverRedirect) return undefined;
    if (idle && options.lazy) entry.schedule();
    else if (idle) void entry.load();
    const settled = entry.settled();
    if (!inComponent) runtime.serverPrefetches.add(settled);
    return settled;
  }
  // The server's render had the data once the setup awaited it, and before
  // the component rendered: handed over at the same points, it gives what
  // the setup derives from it, and so the HTML, the same values.
  const adoption = entry.adoption();
  if (adoption) {
    if (inComponent) onBeforeMount(entry.adoptNow);
    return adoption;
  }
  if (!immediate) return undefined;
  const waitForData = () =>
    !options.lazy && entry.result.data.value === null
      ? entry.settled()
      : undefined;
  if (entry.running()) return waitForData();
  if (!idle) {
    // Loaded before: shown at once and read again in the background, except
    // while the page the server rendered hydrates with the server's data, or
    // when another caller of the page has just read it.
    if (!runtime.hydrating && !entry.justReadForAnother()) void entry.load();
    return waitForData();
  }
  // The server rendered the default in place of this data: the browser's
  // first render must show it too, before the request leaves.
  if (runtime.hydrating && (options.lazy || !onServer)) {
    if (inComponent) onMounted(() => void entry.load());
    else entry.schedule();
  } else if (options.lazy) entry.schedule();
  else void entry.load();
  return !options.lazy && entry.result.pending.value
    ? entry.settled()
    : undefined;
}

interface AsyncDataConsumer<T> extends AsyncDataBindingHandle {
  entry: AsyncDataEntry<T>;
  /** Whether no other component showed the key when this one came. */
  alone: boolean;
}

/**
 * Binds a caller to the data of its key. A `null` key has no data to load:
 * the caller holds its default, and nothing runs until it has a key.
 */
function attachAsyncData<T>(
  runtime: DmsFrontendRuntime,
  key: string | null | undefined,
  handler: DmsAsyncDataHandler<T>,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
): AsyncDataConsumer<T> {
  const entry = asyncDataEntry(runtime, key ?? undefined, options, inComponent);
  const alone = entry.unused();
  if (key === null) return { entry, alone, unbind() {} };
  return { entry, alone, ...entry.bind({ handler, options }) };
}

/**
 * Moves a caller to the data of each key its reactive key takes, and returns
 * refs that follow it there. Until the new key's data is in, the previous
 * data stays on screen rather than the default flashing in its place: the
 * caller's refs show it, and `placeholder` says so, while the new key's own
 * data stays its own, so a run that fails or that a switch away aborts never
 * leaves it another key's data. A key loaded before shows its own data at
 * once, and is read again in the background.
 *
 * A new key is read where the first one would have been. A server reads it
 * neither for `server: false` nor for `immediate: false`, and otherwise only
 * while its render still waits for the caller: until the prefetch of the
 * caller's component, or, outside a component, as a call made then. Past
 * that point the server renders the default and the browser reads the key. A
 * browser hydrating the server's HTML reads a key the server did not render
 * once the component is mounted, so that its first render matches the HTML.
 */
function followAsyncDataKey<T>(
  runtime: DmsFrontendRuntime,
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  keySource: MaybeRefOrGetter<DmsAsyncDataKey>,
  handler: DmsAsyncDataHandler<T>,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
  serverWaits: () => boolean,
): DmsAsyncData<T> {
  // A read held back until the hydrating component is mounted.
  let held = false;
  let mounted = !(inComponent && runtime.hydrating);
  if (!mounted)
    onMounted(() => {
      mounted = true;
      const { entry } = consumer.value;
      if (held && entry.result.status.value === "idle") void entry.load();
      held = false;
    });
  const startOnServer = (entry: AsyncDataEntry<T>) => {
    if (
      options.server === false ||
      options.immediate === false ||
      !serverWaits()
    )
      return;
    void entry.load();
    if (!inComponent) runtime.serverPrefetches.add(entry.settled());
  };
  const current = () => consumer.value.entry.result;
  // The previous key's data, shown until the current key settles.
  const carried = shallowRef<{ value: T | null } | undefined>();
  const settled = (result: DmsAsyncData<T>) =>
    result.status.value === "success" || result.status.value === "error";
  const shownData = (): T | null => {
    const result = current();
    return carried.value && !settled(result)
      ? carried.value.value
      : result.data.value;
  };
  watch(
    () => settled(current()),
    (done) => {
      if (done) carried.value = undefined;
    },
    { flush: "sync" },
  );
  // Data written to the current key from elsewhere (`useDmsData`, another
  // caller of the key) is its own: it replaces what is carried.
  watch(
    () => [current(), current().data.value] as const,
    ([result], [previous]) => {
      if (result === previous) carried.value = undefined;
    },
    { flush: "sync" },
  );
  watch(
    () => toValue(keySource) ?? null,
    (key) => {
      const previous = current();
      const shown = shownData();
      const wasRunning = previous.pending.value;
      // Past the setup, the server's data for the new key, if it rendered
      // any, is taken over at once.
      const next = attachAsyncData(runtime, key, handler, options, false);
      const { entry } = next;
      const carry =
        next.alone && entry.result.status.value === "idle" && shown !== null;
      // Unbound first: the previous key's run, aborted, settles it, which
      // must not drop what is carried to the next key.
      consumer.value.unbind();
      consumer.value = next;
      carried.value = carry ? { value: shown } : undefined;
      held = false;
      // `watch: false` keeps the caller on the key it names, without a run.
      if (key === null || options.watch === false) return;
      if (runtime.isServer) return startOnServer(entry);
      const wanted =
        options.immediate !== false || shown !== null || wasRunning;
      if (!wanted) return;
      if (!mounted) held = true;
      else if (!inComponent && runtime.hydrating) entry.schedule();
      else void entry.load();
    },
    { flush: "sync" },
  );
  const through = <V>(read: (result: DmsAsyncData<T>) => Ref<V>): Ref<V> =>
    computed({
      get: () => read(current()).value,
      set: (value) => {
        read(current()).value = value;
      },
    });
  return {
    data: computed({
      get: shownData,
      set: (value) => {
        carried.value = undefined;
        current().data.value = value;
      },
    }),
    key: computed(() => current().key.value),
    placeholder: computed(
      () => carried.value !== undefined && !settled(current()),
    ),
    error: through((result) => result.error),
    pending: computed(() => current().pending.value),
    status: through((result) => result.status),
    execute: (refreshOptions) => current().refresh(refreshOptions),
    refresh: (refreshOptions) => current().refresh(refreshOptions),
    clear: () => {
      carried.value = undefined;
      current().clear();
    },
  };
}

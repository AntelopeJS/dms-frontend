import { computed, type Ref, ref, shallowRef } from "vue";
import {
  type DmsAsyncData,
  type DmsAsyncDataDedupe,
  type DmsAsyncDataHandler,
  type DmsAsyncDataRefreshOptions,
  type DmsAsyncDataStatus,
  type UseAsyncDataOptions,
} from "./types";
import { type DmsFrontendRuntime } from "./module-registration";
import { createDmsError } from "./dms-error";

function pickValue<T>(value: unknown, keys?: string[]): T {
  if (!keys || typeof value !== "object" || value === null) return value as T;
  return Object.fromEntries(
    keys
      .filter((key) => key in value)
      .map((key) => [key, Reflect.get(value, key)]),
  ) as T;
}

interface AsyncDataBinding<T> {
  handler: DmsAsyncDataHandler<T>;
  options: UseAsyncDataOptions<T>;
}

interface AsyncDataRun {
  promise: Promise<void>;
  controller: AbortController;
}

export interface AsyncDataBindingHandle {
  unbind(): void;
}

/** What a key holds before any run of the browser's own. */
interface AsyncDataInitialState<T> {
  data: T | null;
  error: unknown;
  status: DmsAsyncDataStatus;
}

/** What the components showing one key share: its data and its runs. */
export interface AsyncDataEntry<T> {
  result: DmsAsyncData<T>;
  bind(binding: AsyncDataBinding<T>): AsyncDataBindingHandle;
  /** A run: the one in flight, or a new one. */
  load(): Promise<void>;
  /** The first run, once the current turn is over. */
  schedule(): void;
  /** Resolves once no run is in flight, including the runs that replace it. */
  settled(): Promise<void>;
  unused(): boolean;
  /** When a caller last stopped showing the data (`asyncDataClock`). */
  lastShown(): number;
  /**
   * Whether another caller shows the data and its last run answered within
   * `JOIN_WITHOUT_READ_MS`: a caller joining it then reads nothing again.
   */
  justReadForAnother(): boolean;
  running(): boolean;
  /** `refreshDmsPageData`'s run, for data a caller shows and opted into. */
  pageRefresh(): Promise<void> | undefined;
  /**
   * Holds the server's state back, as pending, until the next turn or
   * `adoptNow`, whichever comes first.
   */
  adoptLater(state: AsyncDataInitialState<T>): void;
  adoptNow(): void;
  /** Resolves once the state held back is adopted; nothing when none is. */
  adoption(): Promise<void> | undefined;
}

const DEFAULT_DEDUPE: DmsAsyncDataDedupe = "cancel";
/**
 * How many keys no component shows any more a browser keeps, the most
 * recently shown, for a return to them to show their data at once.
 */
export const MAX_UNUSED_ASYNC_DATA = 50;
/**
 * How long after a run answered a caller that joins a key another caller
 * shows takes the data as it is, instead of reading it again: two components
 * of one page sharing a read mount a moment apart.
 */
const JOIN_WITHOUT_READ_MS = 2000;

export const asyncDataEntries = new WeakMap<
  DmsAsyncData<unknown>,
  AsyncDataEntry<unknown>
>();

function createAsyncDataEntry<T>(
  runtime: DmsFrontendRuntime,
  key: string | undefined,
  initial: AsyncDataInitialState<T>,
  deep: boolean,
): AsyncDataEntry<T> {
  const data = (
    deep ? ref(initial.data) : shallowRef(initial.data)
  ) as Ref<T | null>;
  const error = ref<unknown>(initial.error);
  const status = ref<DmsAsyncDataStatus>(initial.status);
  const pending = computed(() => status.value === "pending");
  const bindings: AsyncDataBinding<T>[] = [];
  let run: AsyncDataRun | undefined;
  let scheduled: Promise<void> | undefined;
  let heldBack: AsyncDataInitialState<T> | undefined;
  let adoption: Promise<void> | undefined;
  let lastShown = 0;
  // When the last run answered, to spare a caller joining at once a second read.
  let answeredAt = 0;
  const adoptNow = () => {
    if (!heldBack) return;
    data.value = heldBack.data;
    error.value = heldBack.error;
    status.value = heldBack.status;
    heldBack = undefined;
  };
  const handle = (binding: AsyncDataBinding<T>, signal: AbortSignal) => {
    const call = () => binding.handler({ signal });
    return runtime.runAsyncDataHandler
      ? runtime.runAsyncDataHandler(call)
      : call();
  };
  const start = (binding: AsyncDataBinding<T>): Promise<void> => {
    heldBack = undefined;
    run?.controller.abort();
    const controller = new AbortController();
    const current: AsyncDataRun = { controller, promise: Promise.resolve() };
    run = current;
    runtime.asyncDataRuns.add(controller);
    // The last failure stays until this run answers, as in Nuxt.
    status.value = "pending";
    // A run another one replaced, or that nobody waits for any more, settles
    // nothing, even when its handler ignores the signal.
    current.promise = (async () => {
      try {
        const value = await handle(binding, controller.signal);
        const transformed = binding.options.transform
          ? await binding.options.transform(value, { key })
          : value;
        if (run !== current) return;
        data.value = pickValue<T>(transformed, binding.options.pick);
        error.value = null;
        status.value = "success";
        answeredAt = Date.now();
      } catch (reason) {
        if (run !== current) return;
        // The data of the last success stays on screen next to the failure.
        error.value = reason;
        status.value = "error";
      } finally {
        runtime.asyncDataRuns.delete(controller);
        if (run === current) run = undefined;
      }
    })();
    return current.promise;
  };
  const refresh = (options: DmsAsyncDataRefreshOptions = {}) => {
    const binding = bindings.at(-1);
    if (!binding) return Promise.resolve();
    const dedupe = options.dedupe ?? binding.options.dedupe ?? DEFAULT_DEDUPE;
    return run && dedupe === "defer" ? run.promise : start(binding);
  };
  const load = (): Promise<void> => {
    if (run) return run.promise;
    const binding = bindings.at(-1);
    return binding ? start(binding) : Promise.resolve();
  };
  const result: DmsAsyncData<T> = {
    data,
    key: computed(() => key),
    placeholder: computed(() => false),
    error,
    pending,
    status,
    execute: refresh,
    refresh,
    clear() {
      heldBack = undefined;
      run?.controller.abort();
      run = undefined;
      data.value = bindings.at(-1)?.options.default?.() ?? null;
      error.value = null;
      status.value = "idle";
    },
  };
  const entry: AsyncDataEntry<T> = {
    result,
    bind(binding) {
      bindings.push(binding);
      runtime.boundAsyncData.add(entry);
      const unbind = () => {
        const index = bindings.indexOf(binding);
        if (index === -1) return;
        bindings.splice(index, 1);
        if (bindings.length > 0) return;
        lastShown = ++runtime.asyncDataClock;
        runtime.boundAsyncData.delete(entry);
        if (!run) return;
        run.controller.abort();
        run = undefined;
        // Back to what the last answer left.
        status.value =
          error.value != null
            ? "error"
            : data.value === null
              ? "idle"
              : "success";
      };
      return { unbind };
    },
    load,
    schedule() {
      // Started after the caller's turn, an explicit refresh in that turn
      // replaces this first run instead of cancelling it mid-request.
      scheduled ??= Promise.resolve().then(() => {
        scheduled = undefined;
        return load();
      });
    },
    async settled() {
      await scheduled;
      await adoption;
      while (run) await run.promise;
    },
    unused: () => bindings.length === 0,
    lastShown: () => lastShown,
    justReadForAnother: () =>
      bindings.length > 1 && Date.now() - answeredAt < JOIN_WITHOUT_READ_MS,
    running: () => run !== undefined,
    pageRefresh() {
      const wanted = bindings.some(
        (binding) => binding.options.refreshOnPageRefresh !== false,
      );
      // Data a caller waits to `execute()` stays unread.
      if (!wanted || (status.value === "idle" && !run)) return undefined;
      return refresh();
    },
    adoptLater(state) {
      heldBack = state;
      status.value = "pending";
      adoption = Promise.resolve().then(adoptNow);
    },
    adoptNow,
    adoption: () => (heldBack ? adoption : undefined),
  };
  return entry;
}

/**
 * The state the server's render left a key in, if it rendered the key: its
 * data, or its failure next to the default it rendered.
 */
function serverAsyncDataState<T>(
  runtime: DmsFrontendRuntime,
  key: string,
  fallback: AsyncDataInitialState<T>,
): AsyncDataInitialState<T> | undefined {
  if (runtime.hydratedAsyncData.has(key))
    return {
      data: runtime.hydratedAsyncData.get(key) as T,
      error: null,
      status: "success",
    };
  const failure = runtime.hydratedAsyncErrors.get(key);
  if (!failure) return undefined;
  return {
    data: fallback.data,
    error: createDmsError(failure),
    status: "error",
  };
}

/**
 * The key an entry is stored and transferred under: the caller's key, in
 * the runtime's scope (`setDmsAsyncDataScope`).
 */
export function scopedKey(runtime: DmsFrontendRuntime, key: string): string {
  return runtime.asyncDataScope === undefined
    ? key
    : `${runtime.asyncDataScope}|${key}`;
}

export function asyncDataEntry<T>(
  runtime: DmsFrontendRuntime,
  key: string | undefined,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
): AsyncDataEntry<T> {
  const stored = key === undefined ? undefined : scopedKey(runtime, key);
  const shared =
    stored === undefined ? undefined : runtime.asyncData.get(stored);
  if (shared) return asyncDataEntries.get(shared) as AsyncDataEntry<T>;
  const fallback: AsyncDataInitialState<T> = {
    data: options.default?.() ?? null,
    error: null,
    status: "idle",
  };
  const server =
    stored === undefined
      ? undefined
      : serverAsyncDataState<T>(runtime, stored, fallback);
  const entry = createAsyncDataEntry<T>(
    runtime,
    key,
    server && !inComponent ? server : fallback,
    options.deep === true,
  );
  // A component's setup saw the server's run in flight, not its result: the
  // browser holds the result back as long, see `startAsyncData`.
  if (server && inComponent) entry.adoptLater(server);
  if (stored === undefined) return entry;
  runtime.hydratedAsyncData.delete(stored);
  runtime.hydratedAsyncErrors.delete(stored);
  const result = entry.result as DmsAsyncData<unknown>;
  runtime.asyncData.set(stored, result);
  asyncDataEntries.set(result, entry as AsyncDataEntry<unknown>);
  return entry;
}

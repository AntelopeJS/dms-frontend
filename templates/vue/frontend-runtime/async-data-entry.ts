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

function isKeyedObject<V>(value: V): value is V & Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickValue<T>(value: Awaited<T>, keys?: string[]): T {
  const picked =
    keys && isKeyedObject(value)
      ? Object.fromEntries(
          keys.filter((key) => key in value).map((key) => [key, value[key]]),
        )
      : value;
  return picked as T;
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
  /**
   * The first run, once the current turn is over: an explicit refresh in that
   * turn replaces it instead of cancelling it mid-request.
   */
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
  /**
   * `refreshDmsPageData`'s run, for data a caller shows and opted into: data
   * a caller waits to `execute()` stays unread.
   */
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

/** What a run writes its answer to, and how it learns it is still wanted. */
interface AsyncDataRunTarget<T> {
  data: Ref<T | null>;
  error: Ref<unknown>;
  status: Ref<DmsAsyncDataStatus>;
  current(): boolean;
  answered(): void;
  finish(): void;
}

function runAsyncDataHandler<T>(
  runtime: DmsFrontendRuntime,
  binding: AsyncDataBinding<T>,
  signal: AbortSignal,
): Promise<T> {
  const call = () => binding.handler({ signal });
  return runtime.runAsyncDataHandler
    ? runtime.runAsyncDataHandler(call)
    : call();
}

/**
 * Reads what one run needs and writes its answer. A run another one replaced,
 * or that nobody waits for any more, settles nothing, even when its handler
 * ignores the signal; a failure leaves the data of the last success on screen
 * next to it.
 */
async function answerAsyncDataRun<T>(
  runtime: DmsFrontendRuntime,
  key: string | undefined,
  binding: AsyncDataBinding<T>,
  controller: AbortController,
  target: AsyncDataRunTarget<T>,
): Promise<void> {
  try {
    const value = await runAsyncDataHandler(
      runtime,
      binding,
      controller.signal,
    );
    const transformed = binding.options.transform
      ? await binding.options.transform(value, { key })
      : value;
    if (!target.current()) return;
    target.data.value = pickValue<T>(transformed, binding.options.pick);
    target.error.value = null;
    target.status.value = "success";
    target.answered();
  } catch (reason) {
    if (!target.current()) return;
    target.error.value = reason;
    target.status.value = "error";
  } finally {
    runtime.asyncDataRuns.delete(controller);
    target.finish();
  }
}

function removeFrom<V>(items: V[], item: V): boolean {
  const index = items.indexOf(item);
  if (index === -1) return false;
  items.splice(index, 1);
  return true;
}

/** What a key shows once its last run is gone, as that run's answer left it. */
function statusAfterLastAnswer(
  failed: boolean,
  empty: boolean,
): DmsAsyncDataStatus {
  if (failed) return "error";
  return empty ? "idle" : "success";
}

/** The server's state a component's setup saw in flight, held back as pending. */
interface AsyncDataAdoption<T> {
  hold: (state: AsyncDataInitialState<T>) => void;
  adopt: () => void;
  release: () => void;
  waiting: () => Promise<void> | undefined;
  pending: () => Promise<void> | undefined;
}

function createAsyncDataAdoption<T>(
  data: Ref<T | null>,
  error: Ref<unknown>,
  status: Ref<DmsAsyncDataStatus>,
): AsyncDataAdoption<T> {
  let heldBack: AsyncDataInitialState<T> | undefined;
  let adoption: Promise<void> | undefined;
  const adopt = () => {
    if (!heldBack) return;
    data.value = heldBack.data;
    error.value = heldBack.error;
    status.value = heldBack.status;
    heldBack = undefined;
  };
  return {
    hold(state) {
      heldBack = state;
      status.value = "pending";
      adoption = Promise.resolve().then(adopt);
    },
    adopt,
    release() {
      heldBack = undefined;
    },
    waiting: () => (heldBack ? adoption : undefined),
    pending: () => adoption,
  };
}

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
  const adoption = createAsyncDataAdoption(data, error, status);
  let lastShown = 0;
  let answeredAt = 0;
  const start = (binding: AsyncDataBinding<T>): Promise<void> => {
    adoption.release();
    run?.controller.abort();
    const controller = new AbortController();
    const current: AsyncDataRun = { controller, promise: Promise.resolve() };
    run = current;
    runtime.asyncDataRuns.add(controller);
    status.value = "pending";
    current.promise = answerAsyncDataRun(runtime, key, binding, controller, {
      data,
      error,
      status,
      current: () => run === current,
      answered: () => {
        answeredAt = Date.now();
      },
      finish: () => {
        if (run === current) run = undefined;
      },
    });
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
      adoption.release();
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
        if (!removeFrom(bindings, binding) || bindings.length > 0) return;
        lastShown = ++runtime.asyncDataClock;
        runtime.boundAsyncData.delete(entry);
        if (!run) return;
        run.controller.abort();
        run = undefined;
        status.value = statusAfterLastAnswer(
          error.value != null,
          data.value === null,
        );
      };
      return { unbind };
    },
    load,
    schedule() {
      scheduled ??= Promise.resolve().then(() => {
        scheduled = undefined;
        return load();
      });
    },
    async settled() {
      await scheduled;
      await adoption.pending();
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
      if (!wanted || (status.value === "idle" && !run)) return undefined;
      return refresh();
    },
    adoptLater: adoption.hold,
    adoptNow: adoption.adopt,
    adoption: adoption.waiting,
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

/**
 * The entry of a key, shared by every caller of it. A component's setup saw
 * the server's run in flight, not its result: the browser holds the result
 * back as long (`adoptLater`), see `startAsyncData`.
 */
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
  if (server && inComponent) entry.adoptLater(server);
  if (stored === undefined) return entry;
  runtime.hydratedAsyncData.delete(stored);
  runtime.hydratedAsyncErrors.delete(stored);
  const { result } = entry;
  runtime.asyncData.set(stored, result);
  asyncDataEntries.set(result, entry);
  return entry;
}

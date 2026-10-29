import {
  computed,
  getCurrentScope,
  type MaybeRefOrGetter,
  onScopeDispose,
  type Ref,
  readonly,
  ref,
  watch,
} from "vue";
import {
  type DmsAsyncData,
  type DmsAsyncDataContext,
  type DmsAsyncDataKey,
  type UseAsyncDataOptions,
} from "./types";
import { useDmsAsyncData } from "./async-data";

/** What a paged read keeps under its key: the pages loaded, in order. */
export interface DmsPagedDataValue<TPage, TCursor> {
  pages: TPage[];
  /** The cursor of the page after the last one; `null` once there is none. */
  next: TCursor | null;
}
/** What a paged read's handler receives. */
export interface DmsPagedDataContext<TCursor> extends DmsAsyncDataContext {
  /** The page to read: `initialCursor` for the first one. */
  cursor: TCursor | undefined;
  /** Its position, from `0`. */
  index: number;
}
export type DmsPagedDataHandler<TPage, TCursor> = (
  context: DmsPagedDataContext<TCursor>,
) => Promise<TPage>;
export interface UseDmsPagedDataOptions<TPage, TCursor> extends Omit<
  UseAsyncDataOptions<DmsPagedDataValue<TPage, TCursor>>,
  "default" | "transform" | "pick"
> {
  /** The cursor of the page after `page`, or `null` (or `undefined`) for none. */
  nextCursor(page: TPage, pages: TPage[]): TCursor | null | undefined;
  /** The first page's cursor; none by default. */
  initialCursor?: TCursor;
}
export interface DmsPagedData<TPage, TCursor> extends DmsAsyncData<
  DmsPagedDataValue<TPage, TCursor>
> {
  /** The pages loaded so far, in order; none before the first answer. */
  pages: Readonly<Ref<TPage[]>>;
  /** Whether `loadMore()` has a page to read. */
  hasMore: Readonly<Ref<boolean>>;
  /** `true` while `loadMore()` reads its page. */
  loadingMore: Readonly<Ref<boolean>>;
  /**
   * Reads the next page and appends it under the same key. It waits for a
   * read in flight first, does nothing once there is no next page, and puts
   * a failure in `error`, keeping the pages loaded.
   */
  loadMore(): Promise<void>;
}
export type DmsPagedDataResult<TPage, TCursor> = DmsPagedData<TPage, TCursor> &
  Promise<DmsPagedData<TPage, TCursor>>;

type PagedValue<TPage, TCursor> = DmsPagedDataValue<TPage, TCursor>;

/** Reads `count` pages from the first, as long as each has a next one. */
async function readPages<TPage, TCursor>(
  handler: DmsPagedDataHandler<TPage, TCursor>,
  options: UseDmsPagedDataOptions<TPage, TCursor>,
  count: number,
  signal: AbortSignal,
): Promise<PagedValue<TPage, TCursor>> {
  const pages: TPage[] = [];
  let cursor: TCursor | undefined = options.initialCursor;
  for (let index = 0; index < count; index++) {
    const page = await handler({ cursor, index, signal });
    pages.push(page);
    const next = options.nextCursor(page, pages);
    if (next == null) return { pages, next: null };
    cursor = next;
  }
  return { pages, next: cursor ?? null };
}

/** Resolves once `result` has no run in flight. */
function untilSettled<T>(result: DmsAsyncData<T>): Promise<void> {
  if (!result.pending.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(result.pending, (pending) => {
      if (pending) return;
      stop();
      resolve();
    });
  });
}

/**
 * A list read page by page under one key: "load more", an infinite list.
 * The first page loads as `useDmsAsyncData` loads its data (a server render
 * waits for it and transfers it), and `loadMore()` appends the next one to
 * the same key, so the pages a component loaded show at once on a return to
 * it. A revalidation (a mount, `refresh()`, `refreshDmsPageData()`, the
 * polling) reads every page loaded so far again, from the first, and
 * replaces them once all are in. Put what filters the list in the key: a new
 * key starts again from its first page.
 *
 * @param key The key, or a ref or getter for it
 * @param handler Reads one page, from the cursor it receives
 * @param options `nextCursor`, `initialCursor` and the async data options
 */
export function useDmsPagedData<TPage, TCursor = unknown>(
  key: MaybeRefOrGetter<DmsAsyncDataKey>,
  handler: DmsPagedDataHandler<TPage, TCursor>,
  options: UseDmsPagedDataOptions<TPage, TCursor>,
): DmsPagedDataResult<TPage, TCursor> {
  const {
    nextCursor: _next,
    initialCursor: _initial,
    ...asyncOptions
  } = options;
  let shown: DmsAsyncData<PagedValue<TPage, TCursor>> | undefined;
  const loadedCount = () =>
    shown && !shown.placeholder.value
      ? Math.max(1, shown.data.value?.pages.length ?? 0)
      : 1;
  const call = useDmsAsyncData<PagedValue<TPage, TCursor>>(
    key,
    ({ signal }) => readPages(handler, options, loadedCount(), signal),
    asyncOptions,
  );
  shown = call;
  const result: DmsPagedData<TPage, TCursor> = Object.assign(
    {},
    call as DmsAsyncData<PagedValue<TPage, TCursor>>,
    pagedControls(call, handler, options),
  );
  return Object.assign(
    call.then(() => result),
    result,
  );
}

function pagedControls<TPage, TCursor>(
  call: DmsAsyncData<PagedValue<TPage, TCursor>>,
  handler: DmsPagedDataHandler<TPage, TCursor>,
  options: UseDmsPagedDataOptions<TPage, TCursor>,
) {
  const loadingMore = ref(false);
  let controller: AbortController | undefined;
  const abort = () => {
    controller?.abort();
    controller = undefined;
    loadingMore.value = false;
  };
  watch(call.key, abort);
  if (getCurrentScope()) onScopeDispose(abort);
  const hasMore = computed(
    () => !call.placeholder.value && (call.data.value?.next ?? null) !== null,
  );
  const loadMore = async (): Promise<void> => {
    if (call.pending.value) await untilSettled(call);
    const before = call.data.value;
    if (!before) return call.execute();
    if (before.next === null || controller) return;
    const current = new AbortController();
    controller = current;
    loadingMore.value = true;
    try {
      const page = await handler({
        cursor: before.next,
        index: before.pages.length,
        signal: current.signal,
      });
      if (controller !== current || call.data.value !== before) return;
      const pages = [...before.pages, page];
      call.data.value = {
        pages,
        next: options.nextCursor(page, pages) ?? null,
      };
    } catch (reason) {
      if (controller === current) call.error.value = reason;
    } finally {
      if (controller === current) abort();
    }
  };
  return {
    pages: computed(() => call.data.value?.pages ?? []),
    hasMore,
    loadingMore: readonly(loadingMore),
    loadMore,
  };
}

import type { createInertiaApp, router } from "@inertiajs/vue3";

/** The page Inertia renders, as `createInertiaApp` takes it. */
type InertiaPage = NonNullable<
  NonNullable<Parameters<typeof createInertiaApp>[0]>["page"]
>;

/** A page of `component` at `url` with the props given, and the rest of a page Inertia fills in. */
export function inertiaPage(
  url: string,
  props: Omit<InertiaPage["props"], "errors"> = {},
  component = "Page",
): InertiaPage {
  return {
    component,
    props: { ...props, errors: {} },
    url,
    version: "",
    rescuedProps: [],
    flash: {},
    rememberedState: {},
  };
}

type VisitOptions = NonNullable<Parameters<typeof router.visit>[1]>;

/** The visit Inertia hands `onFinish` once a visit settles. */
type ActiveVisit = Parameters<NonNullable<VisitOptions["onFinish"]>>[0];

const noop = () => {};

/** A settled visit to `url`: a plain GET that nothing cancelled. */
export function activeVisit(url = "http://frontend.local/"): ActiveVisit {
  return {
    method: "get",
    data: {},
    replace: false,
    preserveScroll: false,
    preserveState: false,
    only: [],
    except: [],
    headers: {},
    errorBag: null,
    forceFormData: false,
    queryStringArrayFormat: "brackets",
    async: true,
    showProgress: false,
    prefetch: false,
    fresh: false,
    reset: [],
    preserveUrl: false,
    preserveErrors: false,
    invalidateCacheTags: [],
    viewTransition: false,
    component: null,
    pageProps: null,
    cached: false,
    id: "visit",
    url: new URL(url),
    completed: true,
    cancelled: false,
    interrupted: false,
    onCancelToken: noop,
    onBefore: noop,
    onBeforeUpdate: noop,
    onStart: noop,
    onProgress: noop,
    onFinish: noop,
    onCancel: noop,
    onSuccess: noop,
    onError: noop,
    onHttpException: noop,
    onNetworkError: noop,
    onFlash: noop,
    onPrefetched: noop,
    onPrefetching: noop,
  };
}

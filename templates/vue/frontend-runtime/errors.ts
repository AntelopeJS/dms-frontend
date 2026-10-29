import { router as inertiaRouter } from "@inertiajs/vue3";
import { ofetch } from "ofetch";
import { computed, nextTick, type Ref, readonly } from "vue";
import {
  type DmsErrorData,
  type DmsPageProps,
  type DmsSession,
  type DmsUser,
  type DmsUserSession,
} from "./types";
import { createDmsError } from "./dms-error";
import { useDmsRuntime } from "./state";
import { navigateDms } from "./route";
import { endHydration, preloadDmsPage } from "./components";
import { useDmsState } from "./payload";

export function showDmsError(
  input: string | DmsErrorData,
): Error & DmsErrorData {
  const error = createDmsError(input);
  useDmsRuntime().currentError.value = error;
  return error;
}
export function useDmsError(): Ref<(Error & DmsErrorData) | null> {
  return useDmsRuntime().currentError as Ref<(Error & DmsErrorData) | null>;
}
export async function clearDmsError(options?: {
  redirect?: string;
}): Promise<void> {
  useDmsRuntime().currentError.value = null;
  if (options?.redirect) await navigateDms(options.redirect);
}

function sessionIdentity(session: unknown): string {
  const { accountId, activeTenantId } = (session ?? {}) as Partial<DmsSession>;
  return `${accountId ?? ""}\n${activeTenantId ?? ""}`;
}

/**
 * Drops the pages Inertia prefetched (a hovered link) once the session is
 * another account's or workspace's, or none: each carries the user, the page
 * and the site layout of the session it was fetched with, and a visit would
 * show them as current.
 */
function forgetPrefetchedPages(): void {
  if (typeof window !== "undefined") inertiaRouter.flushAll();
}

/**
 * Warms what a prefetched page renders (its page, layout and block
 * components) once Inertia has its props, so following the link does not wait
 * for those chunks after the props.
 */
export function preloadPrefetchedDmsPages(): () => void {
  return inertiaRouter.on("prefetched", (event) => {
    const data = event.detail.response.data as unknown;
    let page: { props?: DmsPageProps } | undefined;
    try {
      page = (typeof data === "string" ? JSON.parse(data) : data) as
        | { props?: DmsPageProps }
        | undefined;
    } catch {
      return;
    }
    if (page?.props?.page) void preloadDmsPage(page.props).catch(() => {});
  });
}

export function useDmsUserSession<
  TUser = DmsUser,
  TSession = DmsSession,
>(): DmsUserSession<TUser, TSession> {
  const user = useDmsState<TUser | null>("dms-user", () => null);
  const session = useDmsState<TSession | null>("dms-session", () => null);
  return {
    user,
    session,
    loggedIn: computed(() => user.value !== null),
    fetch: async () => {
      const before = sessionIdentity(session.value);
      const value = await ofetch<{
        user?: TUser;
        session?: TSession;
      }>("/api/_auth/session", { method: "POST" });
      user.value = value.user ?? null;
      session.value = value.session ?? null;
      if (sessionIdentity(session.value) !== before) forgetPrefetchedPages();
    },
    clear: async () => {
      await ofetch("/api/_auth/session", { method: "DELETE" });
      user.value = null;
      session.value = null;
      forgetPrefetchedPages();
    },
  };
}

/**
 * Whether the page loaded by the current navigation is still pending: its
 * chunk, or an async `setup` it awaits, has not resolved yet. A layout reads
 * it to show its own placeholder in place of the page. Always `false` on the
 * server and during hydration, which render the page resolved.
 */
export function useDmsPageLoading(): Readonly<Ref<boolean>> {
  return readonly(useDmsRuntime().pageLoading);
}

/**
 * Whether the browser is hydrating the page the server rendered, whose first
 * render must match the server's HTML: from the start of the application to
 * the tick the page's `<Suspense>` resolves. False on the server, in a page
 * the server did not render, and after a client navigation. As Nuxt's
 * `nuxtApp.isHydrating`; read once, it is not reactive.
 */
export function isDmsHydrating(): boolean {
  return useDmsRuntime().hydrating;
}

/**
 * The props of the `<Suspense>` around the page that keep `useDmsPageLoading`
 * in step with it. Cleared before the boundary unmounts, so a page left while
 * pending never leaves the state set.
 *
 * They also end the hydration: the page is on screen once its suspense
 * resolves, and the components after it once the tick is over, so the
 * browser has then hydrated what the server rendered. A hydrating suspense
 * never reports itself pending: the server rendered the page resolved.
 */
export function dmsPageSuspenseProps(): Record<string, () => void> {
  const runtime = useDmsRuntime();
  const loading = runtime.pageLoading;
  const settle = () => {
    loading.value = false;
  };
  return {
    onPending: () => {
      loading.value = true;
    },
    onResolve: () => {
      settle();
      if (runtime.hydrating) void nextTick(() => endHydration(runtime));
    },
    onVnodeBeforeUnmount: settle,
  };
}

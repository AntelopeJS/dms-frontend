import { router as inertiaRouter } from "@inertiajs/vue3";
import {
  type App,
  type Component,
  type ComponentPublicInstance,
  type EffectScope,
  getCurrentScope,
} from "vue";
import {
  type DmsAsyncComponent,
  type DmsComponentRegistration,
  type DmsFrontendEntry,
  type DmsFrontendRuntime,
} from "./module-registration";
import { registry, useDmsRuntime } from "./state";
import {
  type DmsPageEntryProps,
  type DmsPageLayout,
  type DmsPageProps,
  type DmsSession,
  type DmsSharedPagePayload,
  type DmsUser,
} from "./types";
import { useDmsState } from "./payload";
import { updateRoute } from "./route";
import { dropUnusedAsyncData } from "./data-access";

/**
 * The key a component name is registered and resolved under: case, a leading
 * `lazy` and every non-alphanumeric character ignored, so PascalCase,
 * kebab-case and lowercase spellings match. Unlike `normalizeDmsName`, a
 * leading `Dms` is kept: it is the DMS module's prefix, and dropping it would
 * make `DmsBanner` and another module's `Banner` the same component.
 */
function normalizeDmsComponentName(name: string): string {
  return name
    .replace(/^lazy/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function hasAsyncLoader(
  component: Component,
): component is Component & Required<DmsAsyncComponent> {
  return (
    "__asyncLoader" in component &&
    typeof component.__asyncLoader === "function"
  );
}

async function loadAsyncComponent(
  component: Component | undefined,
): Promise<void> {
  if (component && hasAsyncLoader(component)) await component.__asyncLoader();
}

async function preloadEntry(
  entry: DmsFrontendEntry | undefined,
): Promise<void> {
  await entry?.preload?.();
}

function moduleLabel(module: string | undefined): string {
  return module ? `module "${module}"` : "an unnamed module";
}

/**
 * A component registered under a name already taken is ignored: the first
 * registration, from the module of higher priority, keeps the name. That is
 * how a module replaces another's component, by registering its full name
 * without a prefix, and only a collision neither side asked for is reported.
 */
export function registerDmsComponentEntry(
  entries: Map<string, DmsComponentRegistration>,
  registration: DmsComponentRegistration,
): void {
  const key = normalizeDmsComponentName(registration.name);
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, registration);
    return;
  }
  if (existing.unprefixed || registration.unprefixed) return;
  console.warn(
    `[dms] Component "${registration.name}" from ${moduleLabel(registration.module)} is ignored: ` +
      `${moduleLabel(existing.module)} already registers "${existing.name}". ` +
      "Give the modules different component prefixes.",
  );
}
/** Registers a component unless a higher-priority module already owns its name. */
export function registerDmsComponent(name: string, component: Component): void {
  registerDmsComponentEntry(registry.components, { name, component });
}
/**
 * Resolves a registered component by its full name, prefix included. Case,
 * a leading `lazy` and non-alphanumeric characters are ignored.
 */
export function resolveDmsComponent(name: string): Component | undefined {
  return registry.components.get(normalizeDmsComponentName(name))?.component;
}

/**
 * Records, by registered name, every registered async component a server
 * render reaches, so the client can resolve the same ones before hydrating.
 * Inertia re-renders the tree once on boot; an async component still loading
 * at that moment makes Vue drop its server-rendered markup ("Skipping lazy
 * hydration") and leave it empty until its chunk arrives.
 */
export function trackDmsAsyncComponents(app: App): Set<string> {
  const names = new Map<Component, string>();
  registry.components.forEach(({ component, name }) => {
    if (hasAsyncLoader(component)) names.set(component, name);
  });
  const rendered = new Set<string>();
  app.mixin({
    beforeCreate(this: ComponentPublicInstance) {
      const name = names.get(this.$.type);
      if (name) rendered.add(name);
    },
  });
  return rendered;
}

/**
 * Records the scope of every component a server render creates, and returns
 * the function that stops them once the render is over.
 *
 * A server app is never mounted, so it is never unmounted either: Vue leaves
 * the scope of each component it rendered running, and nothing handed to
 * `onScopeDispose` is ever released. Nuxt UI's `useRuntimeHook` registers in
 * a process-wide hook registry and only unregisters there, so every server
 * render of the dashboard sidebar stayed reachable, its whole component tree
 * and page props with it, until the server ran out of heap.
 *
 * The component's scope is read through `getCurrentScope`: Vue makes it the
 * active scope before it calls `beforeCreate`, and the instance's own `scope`
 * field is internal, absent from the typings a generated workspace checks.
 */
export function trackDmsServerScopes(app: App): () => void {
  const scopes: EffectScope[] = [];
  app.mixin({
    beforeCreate() {
      const scope = getCurrentScope();
      if (scope) scopes.push(scope);
    },
  });
  return () => {
    for (const scope of scopes.splice(0)) scope.stop();
  };
}

export async function resolveDmsAsyncComponents(
  names: readonly string[],
): Promise<void> {
  await Promise.all(
    names.map((name) => loadAsyncComponent(resolveDmsComponent(name))),
  );
}
export async function preloadDmsComponents(names: string[]): Promise<void> {
  const registry = useDmsRuntime().appContext?.vueApp._context.components ?? {};
  await Promise.all(names.map((name) => loadAsyncComponent(registry[name])));
}
export function normalizeDmsName(name: string): string {
  return name
    .replace(/^lazy/i, "")
    .replace(/^dms[-_]?/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Adds to `names` every component a layout tree places: a `component` or
 * `componentName` string anywhere in it, and, where a child places a component
 * definition (`{ id, component: { … } }`), the names inside that definition.
 */
function collectRenderedComponentNames(
  value: unknown,
  names: Set<string>,
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      collectRenderedComponentNames(entry, names);
    });
    return;
  }
  if (isRecord(value)) {
    for (const name of [value.component, value.componentName]) {
      if (isString(name)) names.add(name);
    }
    collectRenderedComponentNames(value.component, names);
    collectRenderedComponentNames(value.children, names);
  }
}

async function preloadDmsLayoutComponents(
  layout: DmsPageLayout | undefined,
): Promise<void> {
  const names = new Set<string>();
  collectRenderedComponentNames(layout?.layout, names);
  Object.values(layout?.components ?? {}).forEach((component) => {
    collectRenderedComponentNames(component, names);
  });
  await Promise.all(
    [...names].map((name) => loadAsyncComponent(resolveDmsComponent(name))),
  );
}

export function normalizeDmsPageKey(name: string): string {
  return name.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
}
const CATCH_ALL_PAGE_KEY = "[...slug]";

function findDmsPageEntry(
  props: DmsPageEntryProps,
): DmsFrontendEntry | undefined {
  const name = [
    props.page.componentName,
    props.page.route?.fullSlug,
    props.path,
  ].find(
    (candidate) =>
      candidate && registry.pages.has(normalizeDmsPageKey(candidate)),
  );
  return name
    ? registry.pages.get(normalizeDmsPageKey(name))
    : registry.dynamicPages.get(CATCH_ALL_PAGE_KEY);
}

/** The path a frontend module registered for a typed backend refusal. */
export function resolveDmsAccessRedirect(code: string): string | undefined {
  return registry.accessRedirects.get(code);
}
export function hasDmsPage(name: string): boolean {
  return registry.pages.has(normalizeDmsPageKey(name));
}
export function getDmsPage(props: DmsPageProps): Component | undefined {
  if (props.error) return registry.errorPage?.component;
  return findDmsPageEntry(props)?.component;
}
export function getDmsDynamicPage(name = "default"): Component | undefined {
  return registry.dynamicPages.get(name)?.component;
}
export function getDmsLayout(props: DmsPageProps): Component | undefined {
  const layout = props.page.layout;
  const name = layout?.layout?.componentName ?? layout?.componentName;
  return name
    ? registry.layouts.get(normalizeDmsName(name))?.component
    : undefined;
}
export function getDmsLayoutProps(props: DmsPageProps) {
  const definition = props.page.layout?.layout;
  return {
    ...definition?.options,
    icon: props.page.route?.icon,
    title: props.page.route?.displayName,
    description: props.page.route?.description,
  };
}

/**
 * Whether a page carries an older session of the same account than the one
 * the app holds: Inertia restores a page from history, or serves it from the
 * prefetch cache, with the props it was fetched with, and those must not undo
 * a later `useDmsUserSession().fetch()`.
 */
function isStaleSession(
  incoming: DmsSession | undefined,
  current: DmsSession | null,
): boolean {
  return (
    !!incoming &&
    !!current &&
    incoming.accountId === current.accountId &&
    (incoming.updatedAt ?? 0) < (current.updatedAt ?? 0)
  );
}

/**
 * Copies the site layout of the page props into the state. A visit carries
 * the layout it was sent over from page to page (a once prop): the same copy
 * is applied once, so the state keeps what a later refresh wrote into it, and
 * `dms-lastRefreshTime` tells when the layout was last received.
 *
 * A page from the history carries the layout it was shown with, which the
 * state has replaced since, so it is not copied: see `keepSharedOverHistory`.
 */
export function hydrateDmsSharedProps(
  shared: DmsSharedPagePayload | undefined,
): void {
  const runtime = useDmsRuntime();
  if (!shared || shared === runtime.appliedShared) return;
  if (runtime.restoringHistory) return;
  runtime.appliedShared = shared;
  useDmsState<unknown>("dms-siteLayout", () => undefined).value =
    shared.siteLayout;
  useDmsState<unknown>("dms-pageTree", () => undefined).value =
    shared.siteLayoutTree;
  useDmsState<unknown>("dms-quickActions", () => undefined).value =
    shared.quickActions;
  useDmsState<unknown>("dms-modules", () => undefined).value = shared.modules;
  useDmsState("dms-isOwner", () => false).value = shared.isOwner ?? false;
  useDmsState("dms-lastRefreshTime", () => 0).value = Date.now();
}

function isInertiaHistoryState(state: unknown): boolean {
  return isRecord(state) && Boolean(state.page);
}

/**
 * Keeps the newest site layout when Back or Forward puts a page back. The
 * page carries the layout it was shown with, which a later reload replaced
 * (a menu change the backend announced); it is not copied into the state, and
 * the page is given the current one, so the next visit carries that over
 * rather than the older one. Inertia restores only the entries it wrote, which
 * hold a page.
 */
export function keepSharedOverHistory(): () => void {
  const runtime = useDmsRuntime();
  const onPopstate = (event: PopStateEvent) => {
    if (isInertiaHistoryState(event.state)) runtime.restoringHistory = true;
  };
  window.addEventListener("popstate", onPopstate);
  const stopListening = inertiaRouter.on("navigate", (event) => {
    if (!runtime.restoringHistory) return;
    runtime.restoringHistory = false;
    const current = runtime.appliedShared;
    const restored = event.detail.page.props.shared;
    if (current && restored !== current)
      inertiaRouter.replaceProp("shared", current);
  });
  return () => {
    window.removeEventListener("popstate", onPopstate);
    stopListening();
  };
}

/**
 * Copies the page props into the state. Pages are keyed by path: another path
 * mounts another page, which declares its own meta, and so does an error page
 * shown in place of the page. A visit that only changes the query keeps the
 * page, and so its meta. Each navigation is a new authorization snapshot, so
 * the layouts of an earlier account, tenant or permission context are never
 * retained.
 */
export function hydrateDmsPageProps(props: DmsPageProps, url?: string): void {
  const runtime = useDmsRuntime();
  if (url) updateRoute(runtime, url);
  const pageKey = props.error ? `error:${props.path}` : props.path;
  if (pageKey !== runtime.pageKey) {
    runtime.pageKey = pageKey;
    runtime.route.meta = {};
  }
  dropUnusedAsyncData(runtime);
  runtime.currentError.value = null;
  const session = useDmsState<DmsSession | null>("dms-session", () => null);
  if (!isStaleSession(props.session, session.value)) {
    useDmsState<DmsUser | null>("dms-user", () => null).value =
      props.user ?? null;
    session.value = props.session ?? null;
  }
  hydrateDmsSharedProps(props.shared);
  const layoutUrl = props.page.route?.layoutUrl ?? props.page.layoutUrl;
  const pageLayouts = useDmsState<Record<string, DmsPageLayout>>(
    "dms-pageLayouts",
    () => ({}),
  );
  pageLayouts.value =
    layoutUrl && props.page.layout ? { [layoutUrl]: props.page.layout } : {};
}
/**
 * Ends the hydration of the page the server rendered. The server's data no
 * component took over is dropped: a later page must not show it as current.
 */
export function endHydration(runtime: DmsFrontendRuntime): void {
  runtime.hydrating = false;
  runtime.hydratedAsyncData.clear();
  runtime.hydratedAsyncErrors.clear();
}

export function getDmsErrorPage(): Component | undefined {
  return registry.errorPage?.component;
}

/**
 * Resolves the components a page needs before it renders. `preload` only warms
 * the module; the async wrapper stays unresolved until its own loader runs.
 * Hydrating an unresolved wrapper defers it, and the first parent render
 * (Inertia's initial swap) then makes Vue drop the server-rendered markup and
 * render the subtree from scratch.
 */
export async function preloadDmsPage(props: DmsPageEntryProps): Promise<void> {
  const layoutName =
    props.page.layout?.layout?.componentName ??
    props.page.layout?.componentName;
  const page = findDmsPageEntry(props) ?? registry.dynamicPages.get("default");
  const layout = layoutName
    ? registry.layouts.get(normalizeDmsName(layoutName))
    : undefined;
  const entries = props.error ? [registry.errorPage] : [page, layout];
  await Promise.all(
    entries.flatMap((entry) => [
      preloadEntry(entry),
      loadAsyncComponent(entry?.component),
    ]),
  );
  if (!props.error) await preloadDmsLayoutComponents(props.page.layout);
}

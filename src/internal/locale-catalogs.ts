/** @internal */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @internal */
export function mergeLocaleMessages(
  source: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...source };
  for (const [key, value] of Object.entries(existing)) {
    const sourceValue = merged[key];
    merged[key] =
      isRecord(sourceValue) && isRecord(value)
        ? mergeLocaleMessages(sourceValue, value)
        : value;
  }
  return merged;
}

/**
 * The locale every catalog falls back to: the generated catalog of any other
 * locale carries its messages wherever that locale has none.
 * @internal
 */
export const FALLBACK_LOCALE = "en";

/**
 * Messages the renderer translates itself and overrides only with a locale's
 * own message, which it asks `te()` for (`templates/vue/network-error.ts`).
 * They stay out of the English fill: a French visitor of an application that
 * overrides one in English alone keeps the renderer's French text.
 * @internal
 */
export const RENDERER_TRANSLATED_KEYS = ["error.network"];

/**
 * `messages` without the message or subtree at the dotted `key`, nor a group
 * it leaves empty.
 * @internal
 */
export function withoutMessage(
  messages: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const [head, ...rest] = key.split(".");
  if (!(head in messages)) return messages;
  const { [head]: value, ...others } = messages;
  if (!rest.length) return others;
  if (!isRecord(value)) return messages;
  const remaining = withoutMessage(value, rest.join("."));
  return Object.keys(remaining).length
    ? { ...others, [head]: remaining }
    : others;
}

/**
 * The module the application imports its catalogs from: every locale,
 * English included, is a file of its own that the application loads when a
 * page needs it. None is part of the client entry, which every page loads
 * first: the messages of every module of the application weigh hundreds of
 * kilobytes there, and a page shows a few dozen of them. The server
 * preloads the catalog of the page it renders, next to the entry.
 *
 * Each catalog is complete (see `writeLocaleMessages`), so a page needs one
 * file: a French page no longer loads English as well for its fallback.
 *
 * In development the layer watcher regenerates the catalogs while the app
 * runs, and this module accepts its own hot updates. The application keeps
 * the exports of the instance it imported first, so every instance shares one
 * state through `import.meta.hot.data` (the catalogs loaded so far and the
 * i18n instances fed from them), and each new one refreshes it from the
 * catalogs it imports. Accepting itself rather than its imports matters to
 * the server renderer: Vite stops invalidating importers at a module that
 * accepts the changed import, which would leave the next server render on the
 * old catalogs. An added or removed locale changes what the application was
 * set up with, so that update falls back to a full reload.
 * @internal
 */
export function localeModuleSource(supportedLocales: string[]): string {
  const loaders = supportedLocales.map(
    (locale) =>
      `  ${JSON.stringify(locale)}: () => import(${JSON.stringify(`./locales.generated/${locale}`)}),`,
  );
  const fallback = supportedLocales.includes(FALLBACK_LOCALE)
    ? FALLBACK_LOCALE
    : supportedLocales[0];
  return `type LocaleMessages = Record<string, unknown>;
type LocaleLoader = () => Promise<{ default: LocaleMessages }>;
interface LocaleMessagesTarget {
  setLocaleMessage(locale: string, messages: LocaleMessages): void;
}
interface LocaleState {
  messages: Record<string, LocaleMessages>;
  targets: Set<LocaleMessagesTarget>;
  version: number;
}

/** @internal */
export const supportedLocales = ${JSON.stringify(supportedLocales)};
const fallbackLocale: string | undefined = ${JSON.stringify(fallback)};
const localeLoaders: Record<string, LocaleLoader> = {
${loaders.join("\n")}
};
const shared: LocaleState | undefined = import.meta.hot?.data.state;
const state: LocaleState = shared ?? {
  messages: {},
  targets: new Set(),
  version: 0,
};
/** @internal */
export const localeMessages = state.messages;

async function readLocaleMessages(locale: string): Promise<LocaleMessages> {
  return (await localeLoaders[locale]()).default;
}

/**
 * The catalog that serves \`locale\`: its own when the application has one,
 * else the fallback locale's.
 * @internal
 */
export function catalogLocale(locale: string): string | undefined {
  const normalized = locale.slice(0, 2);
  return normalized in localeLoaders ? normalized : fallbackLocale;
}

/** @internal */
export async function loadLocaleMessages(locale: string): Promise<LocaleMessages> {
  const catalog = catalogLocale(locale);
  if (!catalog) return {};
  localeMessages[catalog] ??= await readLocaleMessages(catalog);
  return localeMessages[catalog];
}

/**
 * Development only: applies every regenerated catalog to \`target\`.
 *
 * @internal
 */
export function syncLocaleMessages(target: LocaleMessagesTarget): void {
  if (import.meta.hot) state.targets.add(target);
}

async function refreshLocaleMessages(): Promise<void> {
  const version = ++state.version;
  const locales = Object.keys(localeMessages).filter(
    (locale) => locale in localeLoaders,
  );
  const catalogs = await Promise.all(locales.map(readLocaleMessages));
  if (version !== state.version) return;
  locales.forEach((locale, index) => {
    localeMessages[locale] = catalogs[index];
    for (const target of state.targets)
      target.setLocaleMessage(locale, catalogs[index]);
  });
}

if (import.meta.hot) {
  import.meta.hot.data.state = state;
  if (shared) void refreshLocaleMessages();
  import.meta.hot.accept((next) => {
    if (next?.supportedLocales.join() !== supportedLocales.join())
      import.meta.hot?.invalidate("the list of locales changed");
  });
}
`;
}

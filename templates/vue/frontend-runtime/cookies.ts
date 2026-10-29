import { computed, type Ref, ref } from "vue";
import { type DmsCookieOptions } from "./types";
import { type DmsFrontendRuntime } from "./module-registration";
import { useDmsRuntime } from "./state";

const COOKIE_STATE_PREFIX = "dms-cookie:";
// A browser tab runs one application, so its cookie refs are shared by every
// caller; a server shares them within the request it renders instead.
const browserCookieRefs = new Map<string, Ref<unknown>>();

function readCookie(
  source: string | undefined,
  name: string,
): string | undefined {
  const match = source
    ?.split(/;\s*/)
    .find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

function parseCookieValue<T>(
  stored: string | undefined,
  options: DmsCookieOptions<T>,
): T {
  if (stored === undefined) return (options.default?.() ?? null) as T;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return stored as T;
  }
}

export function writeCookie<T>(
  name: string,
  next: T,
  options: DmsCookieOptions<T>,
) {
  const attributes = [
    `path=${options.path ?? "/"}`,
    options.maxAge === undefined ? "" : `max-age=${options.maxAge}`,
    options.sameSite ? `samesite=${options.sameSite}` : "",
    options.secure ? "secure" : "",
  ].filter(Boolean);
  // biome-ignore lint/suspicious/noDocumentCookie: reactive cookie refs require synchronous writes.
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(next ?? null))}; ${attributes.join("; ")}`;
}

function createCookieRef<T>(
  name: string,
  source: string | undefined,
  options: DmsCookieOptions<T>,
  isServer: boolean,
): Ref<T> {
  const value = ref(
    parseCookieValue(readCookie(source, name), options),
  ) as Ref<T>;
  return computed({
    get: () => value.value,
    set: (next) => {
      value.value = next;
      if (!isServer) writeCookie(name, next, options);
    },
  });
}

// The language a visitor picks, kept by the browser so that a reload renders
// in it. A signed-in user's own language still comes first.
export const LOCALE_COOKIE = "dms_locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The language this browser picked: read from `document.cookie`, or in a
 * server render from the request. Only one of `supportedLocales` counts.
 */
export function readDmsLocaleCookie(
  runtime: DmsFrontendRuntime,
  supportedLocales: string[],
): string | undefined {
  const source =
    typeof document === "undefined" ? runtime.requestCookies : document.cookie;
  try {
    const locale = parseCookieValue<unknown>(
      readCookie(source, LOCALE_COOKIE),
      {},
    );
    return typeof locale === "string" && supportedLocales.includes(locale)
      ? locale
      : undefined;
  } catch {
    // A value that is not URI-encoded: as if the browser had picked none.
    return undefined;
  }
}

/**
 * A cookie as a ref, shared by every caller of the same name — so a plugin and
 * a page reading one preference see each other's writes — and read on the
 * server from the request being rendered, so the server HTML matches the client.
 */
export function useDmsCookie<T = string | null>(
  name: string,
  options: DmsCookieOptions<T> = {},
): Ref<T> {
  if (typeof document !== "undefined") {
    if (!browserCookieRefs.has(name))
      browserCookieRefs.set(
        name,
        createCookieRef(name, document.cookie, options, false) as Ref<unknown>,
      );
    return browserCookieRefs.get(name) as Ref<T>;
  }
  const runtime = useDmsRuntime();
  const key = `${COOKIE_STATE_PREFIX}${name}`;
  if (!runtime.sharedState.has(key))
    runtime.sharedState.set(
      key,
      createCookieRef(
        name,
        runtime.requestCookies,
        options,
        true,
      ) as Ref<unknown>,
    );
  return runtime.sharedState.get(key) as Ref<T>;
}

import { computed, type Ref, ref } from "vue";
import { type DmsCookieOptions } from "./types";
import { type DmsFrontendRuntime } from "./module-registration";
import { useDmsRuntime } from "./state";

const COOKIE_STATE_PREFIX = "dms-cookie:";
/**
 * A browser tab runs one application, so its cookie refs are shared by every
 * caller; a server shares them within the request it renders instead.
 */
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
  if (stored === undefined)
    // SAFETY: The default factory returns the cookie's T, and the null it falls back to stands for a cookie with no default, which the caller's T admits.
    return (options.default?.() ?? null) as T;
  try {
    // SAFETY: The stored text was written as JSON by this cookie's setter from a T, so parsing it gives that T.
    return JSON.parse(stored) as T;
  } catch {
    // SAFETY: A stored value that is not JSON was written as a plain string, which is the T of a string cookie.
    return stored as T;
  }
}

/**
 * Writes the cookie as `document.cookie`, synchronously: reactive cookie refs
 * require it.
 */
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
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(next ?? null))}; ${attributes.join("; ")}`;
}

function createCookieRef<T>(
  name: string,
  source: string | undefined,
  options: DmsCookieOptions<T>,
  isServer: boolean,
): Ref<T> {
  // SAFETY: The ref is built from `parseCookieValue`, which returns the cookie's T, so its unwrapped type is that T.
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

/**
 * The language a visitor picks, kept by the browser so that a reload renders
 * in it. A signed-in user's own language still comes first.
 */
export const LOCALE_COOKIE = "dms_locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The language this browser picked: read from `document.cookie`, or in a
 * server render from the request. Only one of `supportedLocales` counts. A
 * value that is not URI-encoded counts as none: as if the browser had picked
 * none.
 */
export function readDmsLocaleCookie(
  runtime: DmsFrontendRuntime,
  supportedLocales: string[],
): string | undefined {
  const source =
    typeof document === "undefined" ? runtime.requestCookies : document.cookie;
  try {
    const locale = parseCookieValue(readCookie(source, LOCALE_COOKIE), {});
    return supportedLocales.find((supported) => supported === locale);
  } catch {
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
        createCookieRef(name, document.cookie, options, false),
      );
    // SAFETY: A browser cookie ref is cached under the cookie's name by createCookieRef with the T the caller passed for that name.
    return browserCookieRefs.get(name) as Ref<T>;
  }
  const runtime = useDmsRuntime();
  const key = `${COOKIE_STATE_PREFIX}${name}`;
  if (!runtime.sharedState.has(key))
    runtime.sharedState.set(
      key,
      createCookieRef(name, runtime.requestCookies, options, true),
    );
  // SAFETY: The ref was stored under this key by createCookieRef a few lines above, with the T the caller passed for that cookie.
  return runtime.sharedState.get(key) as Ref<T>;
}

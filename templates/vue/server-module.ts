/// <reference types="node" />
/**
 * What a frontend module's `dms.server.ts` declares: the routes it serves from
 * the frontend server. Imported as `#dms/server`.
 *
 * The entry runs in the frontend server's Node.js process, next to the
 * session secret: it is the module's own trusted code, as its backend half
 * is, not a sandbox. It may import `#dms/server`, Node.js built-ins, npm
 * dependencies and the module's own server files, never the application's
 * code (`.vue` files, `dms.frontend.ts`). Nothing it imports reaches the
 * browser bundle.
 */

/** The methods a route can answer. */
export type DmsServerMethod =
  | "GET"
  | "HEAD"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "OPTIONS";

/** The session the frontend server keeps in its sealed session cookie. */
export interface DmsSession {
  user?: Record<string, unknown> & { language?: string };
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  activeTenantId?: string;
  /** False when the session ends with the browser. */
  persistent?: boolean;
  /** Stamped by the frontend server on every write. */
  updatedAt?: number;
  [key: string]: unknown;
}

export interface DmsSealedCookieOptions {
  /** Seconds. Without one, the cookie ends with the browser session. */
  maxAge?: number;
  /** `/` by default. A flow cookie keeps to the paths of its flow. */
  path?: string;
}

export interface DmsBackendRequest {
  method?: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as `Authorization: Bearer <token>`. */
  token?: string;
  /**
   * Extra request headers. The client's address (`x-forwarded-for`) and the
   * headers the frontend server relays to every backend request (the
   * client's country, the user agent, the content language) are its own.
   */
  headers?: Record<string, string>;
}

/** What a session shows the browser: the `user` and `session` page props. */
export interface DmsPublicSession {
  user?: unknown;
  session?: Record<string, unknown>;
}

/** What a route handler receives. */
export interface DmsServerEvent {
  /**
   * The request, Web-standard. Its body stream stops at the route's body
   * limit (64 KiB by default) with a 413.
   */
  request: Request;
  url: URL;
  /** The values of the route's `:name` segments. */
  params: Readonly<Record<string, string>>;
  /** The body as JSON, `{}` when empty; a 400 when it is not JSON. */
  readJson<T = Record<string, unknown>>(): Promise<T>;
  session: {
    read(): DmsSession | undefined;
    /**
     * What the session shows a page (`user`, `session`), as the module that
     * owns sign-in renders it: the page props, and what
     * `useUserSession().fetch()` reads.
     */
    view(): DmsPublicSession;
    /**
     * Writes the session cookie, stamped with `updatedAt`; it ends with the
     * browser unless `persistent` is true or unset.
     */
    write(session: DmsSession): void;
    clear(): void;
    /** The session the rest of this request runs with (page props, retries). */
    useForRequest(session: DmsSession | undefined): void;
  };
  /**
   * Sealed (encrypted, authenticated) cookies, by logical name: the frontend
   * server scopes the name to its backend and sets `HttpOnly`, `SameSite=Lax`
   * and `Secure`. The session cookie is not reachable here.
   */
  cookies: {
    readSealed<T = unknown>(name: string): T | undefined;
    writeSealed(
      name: string,
      value: unknown,
      options?: DmsSealedCookieOptions,
    ): void;
    clear(name: string, options?: { path?: string }): void;
  };
  /**
   * Calls the backend, JSON in and out. A refusal throws an error carrying
   * the status and the backend's public `error.*` message, which the server
   * answers as is when the handler lets it through.
   */
  backend<T = unknown>(path: string, init?: DmsBackendRequest): Promise<T>;
  /**
   * The backend URL of an absolute path, for a call `backend` cannot make (a
   * raw response, no relayed header): always on the backend's origin,
   * whatever the path holds.
   */
  backendUrl(path: string): URL;
  /** The client's address, behind `DMS_TRUSTED_PROXY_HOPS` proxies. */
  clientIp(): string;
  /** This module, and only this one. */
  module: {
    id: string;
    options: Readonly<Record<string, unknown>>;
    privateOptions: Readonly<Record<string, unknown>>;
  };
  /** Renders an email template of the application (`dms.email.ts`). */
  renderEmail(
    template: string,
    props: Record<string, unknown>,
    options?: { locale?: string },
  ): Promise<string>;
  /** Deployment data from the manifest, read-only. */
  app: {
    /** Backend endpoints declared as session-opening (`authEstablishEndpoints`). */
    authEstablishEndpoints: readonly string[];
  };
}

/**
 * A route handler. A `Response` is sent as it is; any other value is sent as
 * JSON with a 200, `null` or nothing as an empty 204. Cookies written through
 * the event are added to the response either way.
 */
export type DmsServerHandler = (
  event: DmsServerEvent,
) => Response | unknown | Promise<Response | unknown>;

export interface DmsServerRouteOptions {
  /**
   * Whether a request with a state-changing method must carry the frontend's
   * own `Origin`. `true` by default; only a route authenticated otherwise (a
   * service token) turns it off.
   */
  sameOrigin?: boolean;
  /** Request body limit in bytes, 64 KiB by default. */
  bodyLimit?: number;
  /**
   * The path is under `/api/` or `/dms/`, the backend's namespace, outside an
   * underscore prefix (`/api/_<module>/`): the route shadows whatever the
   * backend serves there. Say so to silence the warning.
   */
  overridesBackend?: boolean;
}

/**
 * The session logic the frontend server runs outside any route, which the
 * module owning sign-in provides. Each part left out keeps the built-in one.
 */
export interface DmsServerAuth {
  /** Where a signed-out visit to a private page goes, with `?redirect=`. */
  signInPath?: string;
  /**
   * Pages a signed-out visit is never sent to sign in from when the backend
   * refuses it: `/x`, `/x/*` (one segment below) or `/x/**` (the page and
   * everything below). Left out, `<signInPath>/**` and `/onboarding`.
   */
  signInExempt?: readonly string[];
  /**
   * Renews a session the backend refused (a 401 to a signed-in page visit,
   * which is then retried once): writes it with `event.session.write` and
   * returns it, or clears it and returns `undefined`.
   */
  refreshSession?(
    event: DmsServerEvent,
    session: DmsSession,
  ): Promise<DmsSession | undefined>;
  /**
   * The page props `user` and `session` of a signed-in session. The server
   * adds `session.updatedAt` itself.
   */
  publicSession?(session: DmsSession): DmsPublicSession;
}

/**
 * How a page is rendered, and what its document and Inertia answers carry.
 * A rule changes rendering and caching, never who may see the page.
 */
export interface DmsRouteRule {
  /**
   * `false`: a document request gets the client-rendered shell instead of a
   * server render. Inertia visits are unchanged.
   */
  ssr?: false;
  /** Headers added to the page's answers (not `cache-control`: see `cache`). */
  headers?: Record<string, string>;
  /**
   * Public caching, for a page the backend serves to anyone, asked without
   * any cookie or content language; any other request keeps the private
   * default. `false` keeps the default under a broader rule.
   */
  cache?:
    | { public: true; maxAge: number; staleWhileRevalidate?: number }
    | false;
}

export interface DmsServer {
  /**
   * Serves `path` for `method` from the frontend server, before the backend
   * proxy. A path is literal segments and `:name` parameters
   * (`/auth/oauth/:provider/start`); a trailing slash is ignored.
   */
  registerRoute(
    method: DmsServerMethod | readonly DmsServerMethod[],
    path: string,
    handler: DmsServerHandler,
    options?: DmsServerRouteOptions,
  ): void;
  /**
   * Provides the session logic the server runs outside routes. The
   * highest-priority module that registers it provides it; another one is
   * reported and ignored.
   */
  registerAuth(auth: DmsServerAuth): void;
  /**
   * Route rules by page pattern: `/x`, `/x/*` (one segment below) or `/x/**`
   * (the page and everything below). The rules matching a page merge from the
   * least to the most specific pattern; for one pattern, the
   * highest-priority module's rule wins.
   */
  registerRouteRules(rules: Readonly<Record<string, DmsRouteRule>>): void;
}

export type DmsServerSetup = (server: DmsServer) => void;

/**
 * Declares what a frontend module serves from the frontend server, as the
 * default export of its `dms.server.ts`:
 *
 * ```ts
 * import { defineDmsServer } from "#dms/server";
 *
 * export default defineDmsServer((server) => {
 *   server.registerRoute("GET", "/api/_acme/ping", () => ({ ok: true }));
 * });
 * ```
 */
export function defineDmsServer(setup: DmsServerSetup): DmsServerSetup {
  return setup;
}

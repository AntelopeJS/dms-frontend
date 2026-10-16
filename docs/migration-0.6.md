# Migrating to 0.6.0

The release notes the Release workflow writes list the commits; this page
says what changes for a module and for the DMS. 0.6.0 is one breaking release
for the server-rendering work: the renderer no longer
serves the DMS's routes, proxies only the backend prefixes the modules
declare, and the async data layer reads again what it shows. It ships with
DMS 0.9.0 and a release of each module; nothing of 0.5 is kept for
compatibility.

## Breaking changes

- **No built-in routes.** The renderer no longer serves the session
  (`/api/_auth/session`), sign-in (`/auth/*`), OAuth, e-mail render
  (`/api/html/render`) and API tester (`/api/_dms/tester`) routes, nor reports
  them at startup: the DMS and the DMS API serve them from their
  `dms.server.ts`. Without a module that registers auth hooks, pages carry no
  `user` and `session`, and a refused session is not renewed.
- **An explicit backend proxy.** The server no longer proxies `/api/` and
  `/dms/` on its own, no longer sends every write to the backend, and no longer
  asks the backend first for a `GET` then falls back to the page on its `404`.
  Each path has one owner: the renderer's files, then the module routes, then
  the backend prefixes the modules declare (`registerBackendProxy` in
  `dms.server.ts`, `backendProxies` in the manifest, `DMS_BACKEND_PROXIES`),
  then the pages; a write to a page path is a `404`. A module route owns its
  path for every method (`405` for a method it does not declare; `HEAD` reaches
  `GET`).
- **`dms_*` sealed cookies** belong to the module that owns sign-in. Another
  module naming one gets an error, and its own sealed cookies are stored as
  `<module id>.<name>`: a cookie a module wrote under its bare name before is
  not read any more.
- **`ajs dms dev` listens on `127.0.0.1`** unless `HOST` says otherwise
  (`HOST=0.0.0.0` opens it to the network). `ajs dms start` keeps `0.0.0.0`.
- **Async data.** `data` is a shallow ref by default (`deep: true` to track
  inside it). `transform` receives a context, `(value, { key })`, and
  `useDmsFetch`'s `(value, { key, url })`. `UseFetchOptions` extends
  `UseAsyncDataOptions`. A call without a key is left to the browser on a
  server. Data loaded before is read again on each mount (stale while
  revalidate), and `error` stays until the next answer.
- **Removed aliases:** `getDmsComponent` (use `resolveDmsComponent`),
  `prefetchComponents` (use `preloadComponents`) and `useDmsLazyAsyncData`
  (use `useDmsAsyncData` with `lazy: true`).
- A route rule header value with a control character is ignored.
- The secrets the manifest publishes win over `DMS_HTML_RENDER_SECRET` and
  `DMS_OAUTH_RELAY_SECRET`, which only fill in a secret the manifest leaves
  out.
- The development server refuses the generated secrets
  (`generated-server-options.json`, `.manifest-cache.json`) and the modules'
  server code (`dms.server.*`, `server/`), whatever the query.

## Added

- `registerBackendProxy(pattern, { auth: "session" | "none" })`, the routing
  report at startup and `x-dms-route-owner` in development.
- `refreshDmsPageData()` and `refreshOnPageRefresh: false`;
  `setDmsAsyncDataScope()`; `refreshInterval`, which may be a ref or a getter
  (`0` or `null` stops the polling); `key` and `placeholder` on the result.
- `useDmsPagedData(key, handler, { nextCursor })`: a list read page by page
  under one key, with `loadMore()`, `pages`, `hasMore` and `loadingMore`; the
  server renders the first page, and a revalidation reads every loaded page.
- A call to `useDmsAsyncData`, `useDmsFetch` or `useDmsPagedData` outside a
  component and outside any effect scope runs in the application's scope: a
  plugin's polling keeps going past its first `await`.
- `useDmsFetch`'s `key` may be a ref or a getter.
- `dmsRequestKey(url, options)`, the key `useDmsFetch` gives a request.
- `{ parallel: true }` for independent middlewares.
- Icons rendered once per page, from a sprite.

## Fixed

- A middleware that throws during a server render shows the error page with
  its status, rather than a `500` client render (#126).
- A server-rendered error page no longer shows the backend's address.
- A browser holding the site layout of another session is sent this one's.
- The build fails when Nuxt UI reads Inertia's page in a form the per-request
  rewrite does not know.
- The CLI tests remove their temporary directories (#127).

## Migration for module authors

1. Raise the module's range to `"@antelopejs/dms-frontend": ">=0.6.0 <0.7.0"`.
2. Read the backend through `useDmsFetch` / `useDmsAsyncData` (in the DMS,
   `useApiData`), dialogs and drawers with `immediate: false` + `execute()`,
   polling with `refreshInterval` (a ref or a getter to stop it, also from a
   plugin), "load more" lists with `useDmsPagedData` (in the DMS,
   `useApiPagedData`); keep `$fetch` / `$authFetch` for writes. A test that
   needs a response's key computes it with `dmsRequestKey()`.
   Drop the `refresh()` calls made after a write when the page refresh covers
   them, and any reset of `status` to force a read on mount.
3. Give every server-rendered call a key; a keyless call now renders its
   default on the server.
4. Replace in-place mutations of `data` (`data.value.rows.push(…)`) with a new
   value, or pass `deep: true`.
5. `transform` now receives a second argument; a one-argument transform keeps
   working.
6. A backend route the browser calls outside `/api/**` and `/dms/**` needs a
   prefix: `backendProxies` in the manifest, or `registerBackendProxy` in the
   module's `dms.server.ts`.
7. A `dms.server.ts` that writes sealed cookies: rename any `dms_*` cookie,
   and expect the stored name to change (`<module id>.<name>`).
8. Use `resolveDmsComponent`, `preloadComponents` and `useDmsAsyncData(…, {
   lazy: true })` instead of the removed aliases.

## Migration for the DMS

1. Declare the backend prefixes in `dms.server.ts`:
   `server.registerBackendProxy("/api/**")` and
   `server.registerBackendProxy("/dms/**")`. Read page layouts through `/dms/`
   (the `<page>/pagelayout` paths are not proxied any more).
2. Keep serving the session, sign-in, OAuth and e-mail render routes and
   `registerAuth` from `dms.server.ts`: the renderer has no fallback. A route
   that should be answered for every method declares them (others are `405`).
3. Call `setDmsAsyncDataScope()` with a digest of the account and workspace
   on both sides before the page renders, and wire `refreshPageBlocks()` and
   the page's realtime events to `refreshDmsPageData()`.
4. Remove the `status = "idle"` reset of `Form.vue`: a remount reads again.
5. Run `ajs dms dev` with `HOST=0.0.0.0` to reach it from another machine.

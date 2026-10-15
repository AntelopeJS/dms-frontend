# Changelog

## v0.6.0 (unreleased)

One breaking release for the server-rendering work: the renderer no longer
serves the DMS's routes, proxies only the backend prefixes the modules
declare, and the async data layer reads again what it shows. It ships with
DMS 0.9.0 and a release of each module; nothing of 0.5 is kept for
compatibility.

### Breaking changes

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
- **Removed aliases:** `getDmsComponent` (use `resolveDmsComponent`) and
  `prefetchComponents` (use `preloadComponents`).
- A route rule header value with a control character is ignored.
- The development server refuses the generated secrets
  (`generated-server-options.json`, `.manifest-cache.json`) and the modules'
  server code (`dms.server.*`, `server/`), whatever the query.

### Added

- `registerBackendProxy(pattern, { auth: "session" | "none" })`, the routing
  report at startup and `x-dms-route-owner` in development.
- `refreshDmsPageData()` and `refreshOnPageRefresh: false`;
  `setDmsAsyncDataScope()`; `refreshInterval`; `key` and `placeholder` on the
  result.
- `{ parallel: true }` for independent middlewares.
- Icons rendered once per page, from a sprite.

### Fixed

- A middleware that throws during a server render shows the error page with
  its status, rather than a `500` client render (#126).
- A server-rendered error page no longer shows the backend's address.
- A browser holding the site layout of another session is sent this one's.
- The build fails when Nuxt UI reads Inertia's page in a form the per-request
  rewrite does not know.
- The CLI tests remove their temporary directories (#127).

### Migration for module authors

1. Raise the module's range to `"@antelopejs/dms-frontend": ">=0.6.0 <0.7.0"`.
2. Read the backend through `useDmsFetch` / `useDmsAsyncData` (in the DMS,
   `useApiData`), dialogs and drawers with `immediate: false` + `execute()`,
   polling with `refreshInterval`; keep `$fetch` / `$authFetch` for writes.
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
8. Use `resolveDmsComponent` and `preloadComponents` instead of the removed
   aliases.

### Migration for the DMS

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

## v0.5.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.5...v0.5.6)

### 🤖 CI

- Speed up pipeline and verify-source ([#112](https://github.com/AntelopeJS/dms-frontend/pull/112))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.4...v0.5.5)

### 🩹 Fixes

- **proxy:** Refuse request targets naming another host ([#111](https://github.com/AntelopeJS/dms-frontend/pull/111))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.3...v0.5.4)

### 🚀 Enhancements

- **proxy:** Let modules declare public endpoints and relay If-Match ([#108](https://github.com/AntelopeJS/dms-frontend/pull/108))

### 🩹 Fixes

- **auth:** Surface the backend OAuth error key on provider sign-in failures ([#109](https://github.com/AntelopeJS/dms-frontend/pull/109))
- **email:** Strip Vue hydration markers from rendered emails ([#107](https://github.com/AntelopeJS/dms-frontend/pull/107))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.2...v0.5.3)

### 🩹 Fixes

- **auth:** Scope session cookies to the backend instance ([#106](https://github.com/AntelopeJS/dms-frontend/pull/106))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.1...v0.5.2)

### 🩹 Fixes

- **vue:** Keep route objects stable and compare navigations with the shown URL ([#105](https://github.com/AntelopeJS/dms-frontend/pull/105))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.5.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.5.0...v0.5.1)

### 🩹 Fixes

- **auth:** Honour "keep my active session" and stop account validation from switching the session ([#104](https://github.com/AntelopeJS/dms-frontend/pull/104))

### ❤️ Contributors

- Maxime Westhoven ([@mwesto](http://github.com/mwesto))

## v0.5.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- **sdk:** ⚠️  Prefix registered components and drop private components ([#103](https://github.com/AntelopeJS/dms-frontend/pull/103))

#### ⚠️ Breaking Changes

- **sdk:** ⚠️  Prefix registered components and drop private components ([#103](https://github.com/AntelopeJS/dms-frontend/pull/103))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.4.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.12...v0.4.0)

### 🚀 Enhancements

- ⚠️  Module-declared auto-imports, private components, page loading state, session language and SSR icons ([#101](https://github.com/AntelopeJS/dms-frontend/pull/101))

### 🩹 Fixes

- **server:** Forward the client country header to the backend ([#102](https://github.com/AntelopeJS/dms-frontend/pull/102))

#### ⚠️ Breaking Changes

- ⚠️  Module-declared auto-imports, private components, page loading state, session language and SSR icons ([#101](https://github.com/AntelopeJS/dms-frontend/pull/101))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.12

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.11...v0.3.12)

### 🩹 Fixes

- **verify-source:** Find the DMS core layer in the project ([#100](https://github.com/AntelopeJS/dms-frontend/pull/100))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.11

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.10...v0.3.11)

### 🩹 Fixes

- **cli:** Wrap the dev banner and the clean list to the terminal width ([#99](https://github.com/AntelopeJS/dms-frontend/pull/99))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.10

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.9...v0.3.10)

### 🩹 Fixes

- **cli:** Honor --quiet everywhere and accept -q and --verbose=<channels> after the command ([#98](https://github.com/AntelopeJS/dms-frontend/pull/98))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.9

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.8...v0.3.9)

### 🚀 Enhancements

- **cli:** Frame pnpm install and the production build ([#87](https://github.com/AntelopeJS/dms-frontend/pull/87))
- **dev:** Ready banner, degraded-state warnings and a clean stop ([#88](https://github.com/AntelopeJS/dms-frontend/pull/88))
- **build:** Summary, working next step and no silent stale builds ([#89](https://github.com/AntelopeJS/dms-frontend/pull/89))
- **prepare:** Add --strict and report skipped vs failed on stderr ([#90](https://github.com/AntelopeJS/dms-frontend/pull/90))
- **cli:** Add ajs dms workspaces [--json] and confirm clean --all ([#91](https://github.com/AntelopeJS/dms-frontend/pull/91))

### 🔥 Performance

- **cli:** Lazy-load commands, unzipper and semver; quieter update notice ([#94](https://github.com/AntelopeJS/dms-frontend/pull/94))

### 🩹 Fixes

- **cli:** Exit 130 on Ctrl+C and stop the whole child process tree ([#82](https://github.com/AntelopeJS/dms-frontend/pull/82))
- **cli:** Write feedback to stderr ([#83](https://github.com/AntelopeJS/dms-frontend/pull/83))
- **cli:** Validate options before doing any work ([#84](https://github.com/AntelopeJS/dms-frontend/pull/84))
- **cli:** Explain unreachable and refused backends ([#85](https://github.com/AntelopeJS/dms-frontend/pull/85))
- **verify-source:** Report results without stack traces ([#92](https://github.com/AntelopeJS/dms-frontend/pull/92))
- **cli:** Polish the remaining rough edges from the before/after review ([#95](https://github.com/AntelopeJS/dms-frontend/pull/95))
- **release:** Build before running the tests ([#97](https://github.com/AntelopeJS/dms-frontend/pull/97))

### 💅 Refactors

- **cli:** Adopt @antelopejs/core/cli and drop figlet, boxen and chalk ([#86](https://github.com/AntelopeJS/dms-frontend/pull/86))
- **cli:** Rely on @antelopejs/core 1.13 output helpers ([#96](https://github.com/AntelopeJS/dms-frontend/pull/96))

### 📖 Documentation

- **cli:** Rewrite help text and the environment topic ([#93](https://github.com/AntelopeJS/dms-frontend/pull/93))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.8

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.7...v0.3.8)

### 🩹 Fixes

- **vue:** Read the request's own URL in useDmsRoute() on the server ([#79](https://github.com/AntelopeJS/dms-frontend/pull/79))
- **vue:** Keep the meta a page declared when it reads its route ([#81](https://github.com/AntelopeJS/dms-frontend/pull/81))
- **server:** Serve the frontend's own files before asking the backend ([#80](https://github.com/AntelopeJS/dms-frontend/pull/80))

### ❤️ Contributors

- Alessandro Aloisio

## v0.3.7

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.6...v0.3.7)

### 🩹 Fixes

- **server:** Log a hint when the frontend refuses oversized request headers ([#74](https://github.com/AntelopeJS/dms-frontend/pull/74))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.5...v0.3.6)

### 🩹 Fixes

- **dev:** Answer 500 with Vite's error for a module that fails to transform ([#69](https://github.com/AntelopeJS/dms-frontend/pull/69))
- **range:** Report a refused range cleanly in verify-source and name each layer by its path ([#70](https://github.com/AntelopeJS/dms-frontend/pull/70))
- **manifest:** Refuse a manifest the backend serves even when a cache exists ([#71](https://github.com/AntelopeJS/dms-frontend/pull/71))
- **dev:** Report the port the system picked when -p 0 asks for any port ([#72](https://github.com/AntelopeJS/dms-frontend/pull/72))

### 💅 Refactors

- Drop the unused runtime exports, an orphan doc comment and inline requires ([#73](https://github.com/AntelopeJS/dms-frontend/pull/73))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.4...v0.3.5)

### 🩹 Fixes

- **renderer:** Let an app.config.ts edit reach the server render in development ([#67](https://github.com/AntelopeJS/dms-frontend/pull/67))
- **vue:** Serve icons from the frontend server instead of the Iconify API ([#68](https://github.com/AntelopeJS/dms-frontend/pull/68))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.3...v0.3.4)

### 🩹 Fixes

- **vue:** Localise Nuxt UI built-in strings with the DMS locale ([#66](https://github.com/AntelopeJS/dms-frontend/pull/66))

### 🏡 Chore

- **lint:** Check @antelopejs/interface-* ranges ([#65](https://github.com/AntelopeJS/dms-frontend/pull/65))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.2...v0.3.3)

### 🚀 Enhancements

- **workspace:** Refuse a frontend module whose range excludes this release ([#59](https://github.com/AntelopeJS/dms-frontend/pull/59))

### 🩹 Fixes

- **dev:** Render an edited component on the server without a restart ([#55](https://github.com/AntelopeJS/dms-frontend/pull/55))
- **dev:** Refresh every file derived from the layers without a restart ([#56](https://github.com/AntelopeJS/dms-frontend/pull/56))

### ✅ Tests

- **email:** Treat a catalog read mid-rebuild as not rebuilt yet ([#58](https://github.com/AntelopeJS/dms-frontend/pull/58))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.3.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.1...v0.3.2)

### 🩹 Fixes

- **server:** Track render scopes through the public Vue API ([#54](https://github.com/AntelopeJS/dms-frontend/pull/54))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.3.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.3.0...v0.3.1)

### 🩹 Fixes

- **server:** Clean error pages, server-side access redirects and dev email bundle ([#41](https://github.com/AntelopeJS/dms-frontend/pull/41))
- **server:** Resilient dev server and network-error feedback ([#42](https://github.com/AntelopeJS/dms-frontend/pull/42))
- **server:** Stop the production server from keeping every render it serves ([#44](https://github.com/AntelopeJS/dms-frontend/pull/44))
- **dev:** Release the reserved port while a client is connected to it ([#48](https://github.com/AntelopeJS/dms-frontend/pull/48))
- **dev:** Apply translations changed in a layer without a restart ([#49](https://github.com/AntelopeJS/dms-frontend/pull/49))
- **server:** Pass the manifest's secrets to the frontend server ([#53](https://github.com/AntelopeJS/dms-frontend/pull/53))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>
- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.3.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.8...v0.3.0)

### 💅 Refactors

- **vue:** ⚠️  Remove the useColorMode shim ([#43](https://github.com/AntelopeJS/dms-frontend/pull/43))

#### ⚠️ Breaking Changes

- **vue:** ⚠️  Remove the useColorMode shim ([#43](https://github.com/AntelopeJS/dms-frontend/pull/43))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.8

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.7...v0.2.8)

### 🩹 Fixes

- **vue:** Resolve server-rendered async components before hydrating ([#32](https://github.com/AntelopeJS/dms-frontend/pull/32))
- **router:** Keep the page mounted when only the query or hash changes ([#37](https://github.com/AntelopeJS/dms-frontend/pull/37))
- **vue:** Share cookie refs and read them from the rendered request ([#36](https://github.com/AntelopeJS/dms-frontend/pull/36))
- **vue:** Match active links on path segments ([#35](https://github.com/AntelopeJS/dms-frontend/pull/35))
- **vue:** Resolve a single @vueuse/core aligned with Nuxt UI ([#31](https://github.com/AntelopeJS/dms-frontend/pull/31))

### 📖 Documentation

- **readme:** Import components rendered inside <svg> directly ([#38](https://github.com/AntelopeJS/dms-frontend/pull/38))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))

## v0.2.7

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.6...v0.2.7)

### 🩹 Fixes

- **ssr:** Define __VUE_PROD_DEVTOOLS__ for the external vue-i18n build ([#39](https://github.com/AntelopeJS/dms-frontend/pull/39))
- **server:** Announce when the frontend server is ready ([#33](https://github.com/AntelopeJS/dms-frontend/pull/33))

### 💅 Refactors

- **build:** Merge tsconfig.build.json into tsconfig.json ([#27](https://github.com/AntelopeJS/dms-frontend/pull/27))

### 🤖 CI

- **release:** Release next from a dedicated branch and restore requireCommits ([#28](https://github.com/AntelopeJS/dms-frontend/pull/28))
- **release:** Reference the shared release workflows through v1 ([#29](https://github.com/AntelopeJS/dms-frontend/pull/29))

### ❤️ Contributors

- Alessandro Aloisio ([@alessaloisio](http://github.com/alessaloisio))
- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.5...v0.2.6)

### 🩹 Fixes

- **workspace:** Keep dev-rewritten declaration files out of Tailwind's scan ([#26](https://github.com/AntelopeJS/dms-frontend/pull/26))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.4...v0.2.5)

### 🩹 Fixes

- **verify-source:** Remove the generated workspace on exit ([#25](https://github.com/AntelopeJS/dms-frontend/pull/25))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.3...v0.2.4)

### 🚀 Enhancements

- **layers:** Expose the layer alias convention as a public helper ([#24](https://github.com/AntelopeJS/dms-frontend/pull/24))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.2...v0.2.3)

### 🩹 Fixes

- **update-check:** Retry a failed lookup after an hour, not a day ([#22](https://github.com/AntelopeJS/dms-frontend/pull/22))
- **windows:** Keep generated specifiers and globs on POSIX separators ([#23](https://github.com/AntelopeJS/dms-frontend/pull/23))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.1...v0.2.2)

### 🩹 Fixes

- **ssr:** Serve styles in the document and stop cold pages reloading the app ([#21](https://github.com/AntelopeJS/dms-frontend/pull/21))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.2.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.2.0...v0.2.1)

### 🚀 Enhancements

- **cli:** Generate ephemeral dev session secrets ([#19](https://github.com/AntelopeJS/dms-frontend/pull/19))

### 🏡 Chore

- Remove obsolete demo ([#18](https://github.com/AntelopeJS/dms-frontend/pull/18))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## Unreleased

### 🚀 Enhancements

- Generate an ephemeral session secret for `ajs dms dev`; `build` and `start`
  now require an explicit secret. Dev sessions are invalidated on restart.

## v0.2.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.9...v0.2.0)

### 💅 Refactors

- ⚠️  Rename the frontend-module SDK alias to `#dms/frontend-module` ([#16](https://github.com/AntelopeJS/dms-frontend/pull/16))

### 🏡 Chore

- Align community files with the organization defaults ([#15](https://github.com/AntelopeJS/dms-frontend/pull/15))

#### ⚠️ Breaking Changes

- ⚠️  Rename the frontend-module SDK alias to `#dms/frontend-module` ([#16](https://github.com/AntelopeJS/dms-frontend/pull/16))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.9

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.8...v0.1.9)

### 📖 Documentation

- **cli:** Present the loader as `ajs dms <command>` ([#14](https://github.com/AntelopeJS/dms-frontend/pull/14))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.8

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.7...v0.1.8)

### 🚀 Enhancements

- Take /auth/establish endpoints from the frontend manifest ([#13](https://github.com/AntelopeJS/dms-frontend/pull/13))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.7

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.6...v0.1.7)

### 🩹 Fixes

- **cli:** Kill the spawned server with the CLI and explain CSRF 403s ([#12](https://github.com/AntelopeJS/dms-frontend/pull/12))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.6

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.5...v0.1.6)

### 🏡 Chore

- Require @antelopejs/core 1.7 ([#11](https://github.com/AntelopeJS/dms-frontend/pull/11))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.5

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.4...v0.1.5)

### 🏡 Chore

- Accept AntelopeJS core 2.x as the CLI peer ([#9](https://github.com/AntelopeJS/dms-frontend/pull/9))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.4

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.3...v0.1.4)

## v0.1.3

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.2...v0.1.3)

### 🚀 Enhancements

- **auth:** Open a session from a module backend endpoint ([#6](https://github.com/AntelopeJS/dms-frontend/pull/6))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.2

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.1...v0.1.2)

### 🚀 Enhancements

- **cli:** Load .env from the current directory ([#5](https://github.com/AntelopeJS/dms-frontend/pull/5))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.1

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.1.0...v0.1.1)

### 📖 Documentation

- Position the package as a frontend-agnostic loader ([#4](https://github.com/AntelopeJS/dms-frontend/pull/4))

### 🏡 Chore

- Require AntelopeJS core 1.6.0 as the CLI peer ([#3](https://github.com/AntelopeJS/dms-frontend/pull/3))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

## v0.1.0

[compare changes](https://github.com/AntelopeJS/dms-frontend/compare/v0.0.1...v0.1.0)

### 💅 Refactors

- ⚠️  Align env var names with the DMS templates ([#1](https://github.com/AntelopeJS/dms-frontend/pull/1))

### 🏡 Chore

- **release:** Skip the npm auth pre-flight for trusted publishing ([#2](https://github.com/AntelopeJS/dms-frontend/pull/2))

#### ⚠️ Breaking Changes

- ⚠️  Align env var names with the DMS templates ([#1](https://github.com/AntelopeJS/dms-frontend/pull/1))

### ❤️ Contributors

- Antony Rizzitelli <rizzitelli.antony@pm.me>

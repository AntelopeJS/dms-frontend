---
covers:
  - templates/vue/server/inertia.mjs
  - templates/vue/server/page-props.mjs
  - templates/vue/server/page-redirects.mjs
  - templates/vue/DmsDynamicPage.vue
  - templates/vue/app-runtime.ts
  - templates/vue/frontend-runtime/async-data-entry.ts
  - templates/vue/frontend-runtime/async-data.ts
  - templates/vue/frontend-runtime/components.ts
  - templates/vue/frontend-runtime/data-access.ts
  - templates/vue/frontend-runtime/dms-error.ts
  - templates/vue/frontend-runtime/errors.ts
  - templates/vue/frontend-runtime/fetch.ts
  - templates/vue/frontend-runtime/module-registration.ts
  - templates/vue/frontend-runtime/paged-data.ts
  - templates/vue/frontend-runtime/payload.ts
  - templates/vue/frontend-runtime/route.ts
  - templates/vue/frontend-runtime/sdk.ts
  - templates/vue/frontend-runtime/state.ts
  - templates/vue/frontend-runtime/types.ts
  - templates/vue/frontend-runtime/ui.ts
  - templates/vue/globals.d.ts
  - templates/vue/main.ts
  - templates/vue/message-subset.ts
  - templates/vue/sfc-global-types.mjs
  - templates/vue/ssr-renderer.ts
  - templates/vue/ui-app-config.ts
  - templates/vue/ui-inertia-page.mjs
  - templates/vue/ui-kbd.mjs
  - templates/vue/ui-request-state.mjs
docs:
  - docs/6.rendering/1.model.md
  - docs/6.rendering/2.navigation.md
  - docs/6.rendering/3.data-loading.md
---

# Rendering

How the frontend server answers a page: a document request is rendered on the server and carries the Inertia page object, the data payload and private caching headers; an `X-Inertia` visit answers the page object as JSON; the site layout travels once per account and workspace for five minutes; partial reloads pick props; a stale asset version answers 409; an unknown path renders the error page with its status; key hints are drawn for the keyboard platform of the request.

## Sub-features

- `a-first-load-is-rendered-on-the-server`: `/settings` with a session answers `text/html`, `Cache-Control: private, no-cache`, `Vary` naming `X-Inertia`, a page object (`component`, `url`, `props.path`, `user`, `session`, `page.route`, `shared`, empty `errors`), a `dms-payload` element and a server-rendered app root.
- `an-inertia-visit-answers-a-json-page-object`: the same path with `X-Inertia: true` answers `application/json`, `x-inertia: true`, `x-inertia-version` equal to the document's version, `Cache-Control: private, no-cache`, and the same prop names.
- `a-stale-asset-version-answers-409-with-the-location`: another `X-Inertia-Version` answers 409, empty, with `x-inertia-location` the requested URL.
- `the-site-layout-travels-once-per-account-and-workspace`: the first visit sends `shared` and declares `shared:<16>` for five minutes; a held key withholds it and declares it without expiry; another account's key, or this one beside another, sends it again.
- `partial-reloads-send-only-the-props-they-name`: `only`, a nested `only` path, `except`, `only=shared` with a held layout, and a partial reload for another component.
- `following-a-link-is-an-inertia-visit-without-the-layout`: in the browser a sidebar link is an `X-Inertia` request that names the held layout, loads no document and is answered without `shared`.
- `the-data-a-page-read-is-drawn-by-the-server-and-handed-over`: the Users table's first row is in the HTML, the payload is a devalue document of `data`, `errors` and `state`, and the browser reads no list on hydration.
- `an-unknown-page-renders-the-error-page-with-its-status`: 404 with HTML and a payload; a page that declares no icon gets one empty icon link, one that declares its own keeps only that.
- `key-hints-are-drawn-for-the-keyboard-the-server-was-told`: the `dms-keyboard-platform` cookie draws `⌘K` or `Ctrl K` in the server render.
- `the-payload-is-escaped-so-data-cannot-close-its-script`: a user named `a</script><b>x/y` reaches the payload as `a\u003C\/script>\u003Cb>x\/y`, with no raw angle bracket and no unescaped slash.
- `choosing-a-tab-changes-only-the-query-in-the-browser`: choosing a tab of the Filter tabs page changes the URL's query, keeps the document and sends the frontend server no request for the page.

## How to get to it (user POV)

- Any dashboard URL; following a sidebar link; the browser's address bar.

## Driving it with dms-control

```bash
dms-control journey "$RUN" rendering
```

Journeys read the session cookie from the signed-in tab and request the frontend server directly (`web.mjs`).

## Gotchas

- The Users table and every page layout need a backend that serves controller routes. The dms playground loads `@antelopejs/api ^1.5.0` from the registry, which answers those as 500 (AntelopeJS/dms#620); runs on a registry api fail `the-data-a-page-read-is-drawn-by-the-server-and-handed-over`.
- Production builds print no hydration warning, so a mismatch between the server and the browser is not observable.

## Not driven

- `isDmsHydrating()`, `DmsClientOnly` and client-only plugins (6.1): they decide what a component draws before and after hydration, and no playground page prints either state in a way a check can tell apart without a hydration warning.
- Server render with `ssr: false` (6.1 and 7): owned by the routing feature, which has the playground's `ssr: false` rule.
- The in-place re-render with `Content-Location` and the redirect after two renders (6.3): the playground has no page that adds a remembered query to its own URL.
- `useDmsAsyncData` semantics: joined runs, `lazy`, `server: false`, `immediate: false`, `dedupe`, `refreshInterval`, `transform`, `useDmsPagedData`, `refreshDmsData`: they are the module author's SDK; the playground uses them inside components without a stable, observable contract for each option. The payload format and the transfer are driven.
- The 50-entry cache of unshown data, stale-while-revalidate timing and a payload that leaves out a 5xx body: no playground page fails a read on demand.
- Keyboard hint hydration without mismatch (6.1): invisible in a production build.
- Prefetching on hover (6.2): `DmsLink` prefetch headers are not exposed by any playground link the journeys can tell from a click.
- `router.reload({ only: ["shared"] })` and the menu-changed reload (6.2): the headers behind it are driven (`partial-reloads-send-only-the-props-they-name`); the DMS's own trigger is the dms skill's.
- Hot reload (6.1): development only; the run serves a production build.
- `router.reload({ only })`, `data`, `headers` and `onStart` forcing a request on a query-only visit, and leaving an error page always going through the server (6.2 Navigations that stay in the browser): no playground page calls the router with those options. The query-only side is driven (`choosing-a-tab-changes-only-the-query-in-the-browser`); the banner links of the playground pages do send an Inertia request, so they are not used as the example.

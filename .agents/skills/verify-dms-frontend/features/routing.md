---
covers:
  - templates/vue/server-module.ts
  - templates/vue/server.mjs
  - templates/vue/server/content.mjs
  - templates/vue/server/homepage.mjs
  - templates/vue/server/html-tag.mjs
  - templates/vue/server/in-place-render.mjs
  - templates/vue/server/listen-host.mjs
  - templates/vue/server/module-event.mjs
  - templates/vue/server/module-route-types.mjs
  - templates/vue/server/module-routes.mjs
  - templates/vue/server/module-server.mjs
  - templates/vue/server/request-routing.mjs
  - templates/vue/server/route-rules.mjs
  - templates/vue/server/ssr-module.mjs
  - templates/vue/server/type-guards.mjs
docs:
  - docs/5.frontend-modules/5.server-routes.md
  - docs/5.frontend-modules/7.route-rules.md
---

# routing

One owner answers each path: the renderer's files, then the modules' `dms.server.ts` routes, then the backend proxies, then the pages. A module route owns its path for every method, takes parameters, a body limit, the Origin rule and `no-store` by default, and warns about every declaration it settles silently. Route rules set a page's caching, server rendering and headers.

## Sub-features

- `routing-routes`: the 405 and `Allow` header, `HEAD`, trailing slash, parameters (decoded, `%2F`), literal before parameter, priority and tie-breaking across modules, reserved paths, `204` for nothing, `Response` passthrough, `no-store`, `readJson`, `bodyLimit` (64 KiB, a route's own, chunked), `sameOrigin: false`, error mapping, `event.backend` and its headers, relayed redirects and cookies, `event.module`, `clientIp()`, sealed cookies by module, and 21 exact startup warnings.
- `routing-rules`: public `cache` under its five conditions, `ssr: false` (shell against server render), headers on documents and Inertia answers, merging from the least to the most specific pattern, priority between modules, and 17 rejected rules with their warnings.
- `routing-pages`: `/` to the homepage, page paths take only `GET` and `HEAD`, `<page>/pagelayout` is not a backend route, a signed-out visit goes to sign-in, a malformed path is `400`, a stale asset version is `409`.
- `routing-page-props`: the once-prop layout, partial reloads, and a build without the server-modules bundle.
- `routing-listen`: every interface by default, `HOST`, a taken port.
- `routing-owner`: `x-dms-route-owner` in `ajs dms dev` for all five owners, and none in `start`.

## How to get to it (user POV)

- Any URL of the dashboard, any call to a module's `/api/_<module>/` route, any page with a route rule.

## Driving it with dms-control

```bash
dms-control journey "$RUN" routing
```

## How the journeys observe routing

A second `ajs dms start` runs from a hard-linked copy of the run's workspace in which `dist/server-modules/server-modules.generated.js` exports the modules of `routing-fixture-routes.mjs` or `routing-fixture-rules.mjs` (the shape `ajs dms build` writes), next to or instead of the build's own. `routing-owner` starts `ajs dms dev` in the run's home.

## Docs swept

| Page | Where it is asserted |
| --- | --- |
| 5.server-routes: first response, forwarding, the handler, event members | `routing-routes` |
| Sealed cookies | `routing-routes` (names, attributes, isolation, errors) |
| Defaults every route gets, paths and precedence | `routing-routes` |
| Trust and imports, `serveModuleRoutes` | not driven, below |
| 7.route-rules: `cache`, `ssr`, `headers`, merging | `routing-rules` |
| 3.routing-and-proxy: Who answers a path, the startup report, `x-dms-route-owner` | `routing-owner`, `routing-pages`, `routing-routes`, `routing-page-props` |

## Not driven

| Behaviour | Why not |
| --- | --- |
| `serveModuleRoutes` and the Testing page | Test tooling of a module's own suite, not the frontend server; the satellites run the real server. |
| An edited handler answers on the next request under `ajs dms dev` | Needs a watched module source and Vite's reload; `tests/dev-modules.test.ts` covers the mirroring. |
| `renderEmail` | The e-mail templates belong to the `emails` feature. |
| The page re-render at the query it completes (`in-place-render.mjs`, `content-location`) | No page of the playground rewrites its own query while rendering. |
| The module that ships `dms.server.ts` and the supported range | A property of the module registry (`modules` feature). |
| A `dms.server.ts` that imports application code is refused | Checked by `verify-source`, owned by the `verify-source` feature. |
| A rule's `cache` on an answer that is not `200` | Only the 404 error page is reachable; it is asserted as private. |

## Gotchas

- Warnings of the server modules are asserted against the log of the satellite, line by line.
- `routing-rules` runs on an onboarded database: it compares a server-rendered `/auth` with the `/dms-preview` shell.
- A route rule pattern with a wildcard in the middle is accepted without a warning (AntelopeJS/dms-frontend#275, `proxy-pattern-forms`, same `compilePathPattern`).
- `routing-listen` needs a non-loopback IPv4 address on the machine.
- `routing-owner` takes about a minute: `ajs dms dev` generates and installs its workspace in the run's home.

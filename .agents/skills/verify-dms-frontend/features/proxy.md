---
covers:
  - templates/vue/network-error.ts
  - templates/vue/public-options.ts
  - templates/vue/server/backend-proxies.mjs
  - templates/vue/server/backend-request.mjs
  - templates/vue/server/backend-response.mjs
  - templates/vue/server/path-patterns.mjs
  - templates/vue/server/proxy-compression.mjs
  - templates/vue/server/proxy-headers.mjs
  - templates/vue/server/proxy-redirects.mjs
  - templates/vue/server/proxy-request.mjs
  - templates/vue/server/proxy-transfers.mjs
  - templates/vue/server/public-endpoints.mjs
  - templates/vue/server/public-options.mjs
  - templates/vue/server/request-failure.mjs
  - templates/vue/server/request-target.mjs
  - templates/vue/server/web-body.mjs
docs:
  - docs/7.deployment/3.routing-and-proxy.md
  - docs/7.deployment/4.public-endpoints.md
---

# proxy

The frontend server sends the paths that a backend prefix covers to the backend: it adds the session's token on the server, refuses a state-changing request without the frontend's own `Origin`, relays a documented set of headers, never follows a redirect, compresses eligible answers, streams bodies both ways and caps a body when a prefix says so. A public endpoint is the one exception to the Origin rule.

## Sub-features

- `proxy-relay`: the client headers that reach the backend, the ones that never do (`Cookie`, `Authorization`, `x-dms-bootstrap`), `X-Forwarded-*` under `DMS_TRUSTED_PROXY_HOPS`, `DMS_CLIENT_IP_HEADER` and `DMS_COUNTRY_HEADER`, and the session's token as the only credential.
- `proxy-access`: the Origin rule for `POST`, `PUT`, `PATCH` and `DELETE` against seven kinds of foreign Origin, safe methods, `auth: "none"`, and public endpoints from the manifest, from `DMS_PUBLIC_ENDPOINTS` and from a module (path, methods, headers, every malformed declaration dropped whole).
- `proxy-limits`: `maxBodyBytes` at the limit, one below and one above, declared and chunked, the 413 body, the 5-second drain, no cap by default, streaming in both directions, invalid limits, and the DMS's 500 MiB upload prefix.
- `proxy-redirects`: five redirect statuses relayed as they are, with the backend's cookies, never followed, and every `Location` rule.
- `proxy-answers`: Brotli and gzip chosen by `Accept-Encoding` qualities, the 1 KiB threshold, content types, `no-transform`, ranges, unknown and ignored codings, `Vary`, `ETag`, `HEAD`, hop-by-hop headers and streaming compression.
- `proxy-streams`: an event stream relayed as written, a client that leaves closes its backend request, a broken backend stream ends only that response.
- `proxy-declarations`: the most specific pattern wins, ignored declarations and their exact warnings, the startup report, normalized paths (`..`, `%2e%2e`, `\`), and request targets that are not origin-form.
- `proxy-offline`: the Connection lost toast of a navigation that never reaches the server.
- `proxy-redirect-icons` and `proxy-pattern-forms`: findings, see Gotchas.

## How to get to it (user POV)

- Every call the dashboard makes to `/api/**`, `/dms/**` or a module's prefix, and a provider's webhook to a public endpoint.

## Driving it with dms-control

```bash
dms-control journey "$RUN" proxy
dms-control journey "$RUN" proxy proxy-limits
```

## How the journeys observe the proxy

Most journeys start a second `ajs dms start` (`proxy-satellite.mjs`) on a free port from a hard-linked copy of the run's built workspace, against a node `http` backend of the test's own that records every request. `DMS_BACKEND_PROXIES`, `DMS_PUBLIC_ENDPOINTS`, `DMS_TRUSTED_PROXY_HOPS`, `DMS_CLIENT_IP_HEADER` and `DMS_COUNTRY_HEADER` are set per server, and the generated `generated-public-endpoints.json` is replaced to play a backend module's manifest. The backend signs in through the DMS's own `/auth/login` route (`proxy-signin.mjs`). Requests go through `proxy-http.mjs`, which sends a path exactly as written.

## Docs swept

| Page | Where it is asserted |
| --- | --- |
| 3.routing-and-proxy, Who answers a path | `routing` feature |
| Declaring a backend prefix, the three tabs | operator tab in `proxy-declarations` and `proxy-limits`; backend module tab (manifest file) in `proxy-access`; frontend module tab in the DMS's own prefixes (`proxy-declarations` report) |
| `auth: "session"` / `"none"`, `maxBodyBytes`, patterns, specificity, priority | `proxy-access`, `proxy-limits`, `proxy-declarations` |
| What the proxy sends | `proxy-relay` |
| Redirects | `proxy-redirects` |
| Large transfers | `proxy-limits` |
| Response compression | `proxy-answers` |
| Event streams | `proxy-streams` |
| 4.public-endpoints | `proxy-access` (the playground's webhook and a second server) |

## Not driven

| Behaviour | Why not |
| --- | --- |
| A request may take an hour, and the backend's answer may pause 5 minutes between two parts | Both limits are wall-clock timers of 3600 s and 300 s, set in Node's server options and undici; `tests/` covers the option values. |
| An event stream that sends nothing ends after 5 quiet minutes, and `EventSource` reconnects after its `retry` delay | Same 300 s timer, and the reconnect belongs to the browser. |
| A client that left while its request was being routed opens no backend request | The window is the time between the socket closing and the first `await`, which a client cannot hit on purpose. |
| `dev` and `prepare` read the manifest's `backendProxies` only for a request with the bootstrap credential | The playground declares no `backendProxies`, so the manifest carries nothing to read; the file `start` reads is driven. |
| A frontend module's declaration wins over the manifest's, with a warning | Driven through the operator entry, which takes the same branch of `resolveBackendProxies`; the playground has no manifest proxy to collide with. |
| The Cloudflare 100 MB cap, the HTTP/2 or HTTP/3 reverse proxy advice | Properties of a platform in front of the server. |
| The French text of the Connection lost toast and a module's `error.network.*` override | Only the English texts are asserted. |

## Gotchas

- Each satellite takes 3 to 5 seconds to start; a journey stops its servers in a `finally`.
- `proxy-redirect-icons` fails on purpose: a backend redirect to `/api/_dms/icons` becomes a frontend path although the renderer answers that path. Issue: AntelopeJS/dms-frontend#276.
- `proxy-pattern-forms` fails on purpose: a pattern with a wildcard in the middle (`/mid/*/leaf`) is accepted without a warning. Issue: AntelopeJS/dms-frontend#275.
- A warning for a malformed public endpoint is printed twice by the server (once when the modules resolve, once for the request matcher); the journey asserts that each entry is reported, not how often.
- A `HEAD` of an eligible answer carries the backend's `Vary` without `Accept-Encoding`, unlike the `GET`; the journey does not assert it.
- Node 24's `fetch` decodes `zstd`: use a coding it does not know (`x-custom`) to reach the proxy's passthrough.

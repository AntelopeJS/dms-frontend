---
name: formal-backend-exposure
description: Property-based check, with fast-check, of what the renderer's frontend server (templates/vue/server.mjs) lets through to the backend. Generated deployments (DMS_BACKEND_PROXIES, DMS_PUBLIC_ENDPOINTS) and hostile visits run against the real server, and the check compares what a recording backend receives with the contract in the user docs. That covers which paths reach the backend, with which method and path, with whose session, after which Origin check, and with which headers. Use when a change touches a file in its coverage record, or when a change to routing, backend proxies, public endpoints, the session or the forwarded headers needs proof that nothing new reaches the backend.
---

# Formal check: what reaches the backend

The frontend server stands between the browser and the backend. It decides which request reaches the backend, on which path, with the signed-in user's access token or without it, and after which Origin check. A mistake there opens a backend route on the dashboard's public origin, or lets another site act as the signed-in user (CSRF). Tests check the paths someone thought of. This check generates the deployments and the requests.

The promise comes from the user docs, `docs/7.deployment/3.routing-and-proxy.md`, `4.public-endpoints.md` and `5.security.md`. `contract.mjs` restates it apart from the code. There is no verifier for this JavaScript, so the check tests the real code with generated inputs, not a model of it. Each case is one deployment and one request. The check sets the deployment's `DMS_BACKEND_PROXIES` and `DMS_PUBLIC_ENDPOINTS`, then sends the request raw over HTTP to the real `handleRequestSafely`. The server runs in production mode in front of a backend that records every request and answers `{}`. The rules compare what that backend received with what the docs allow.

- `contract.mjs` is the docs' contract: which declarations are valid, which proxy covers a path and which one wins, the public endpoints, the renderer's own paths, and the frontend's own Origin.
- `inputs.mjs` generates cases: overlapping and malformed declarations, and visits with dot segments, `%2e%2e`, `\`, `//`, `%2F`, extended segments (`/apix`), queries, foreign targets, every method a browser sends, own and foreign Origins and Hosts, valid, forged and foreign session cookies, and headers the backend gives a meaning to.
- `drive.mjs` starts the two servers and sends one case. `rules.mjs` holds the rules. `findings.mjs` records what the current code breaks. `check.mjs` runs everything.

## Run it

From the repository root, with Node 24 and `pnpm install` done (fast-check is a devDependency, pinned by the lockfile):

```sh
node .agents/skills/formal-backend-exposure/check.mjs           # 200 cases per rule
node .agents/skills/formal-backend-exposure/check.mjs --full    # 2,000 cases per rule
node .agents/skills/formal-backend-exposure/check.mjs --seed 7  # another sample
```

| Configuration | Cases | Wall time |
| --- | --- | --- |
| CI (no flag) | 200 per rule and per finding | 5 to 9 s |
| Full (`--full`) | 2,000 per rule and per finding | 27 to 53 s |

The times are from a shared 16-core machine with a load average of 30 to 65. The check runs on one core. The seed defaults to `20261105`, and the same seed with the same fast-check version replays the same cases. The run stops if `templates/vue/generated-public-endpoints.json` or `templates/vue/dist/server-modules` exists, because either would add declarations the check does not generate.

- Exit 0 means every rule that held still holds, and each finding still breaks.
- Exit 1 means a rule changed. `BROKEN <Rule>` names a rule that held and now breaks, with the shrunk case under it. `HOLDS  <Rule>` names a finding that no longer breaks.
- Exit 2 means the harness could not run (a request got no answer, a stray file) or the arguments were wrong.

The lines that name a changed rule match `^(?:BROKEN|CHANGED|HOLDS) +(\w+)`, and `finding <Rule>` lines name a recorded finding. A rule that still holds prints in the lowercase `holds` line.

## When to run it

Run `--full` when a change touches a file in the coverage record below, this folder, or one of the three docs pages. A changed rule (exit 1) makes the Verdict FAIL. The recorded findings fail it only when the diff changes what the covered code does, which `dms-control formal` decides by comparing the covered files' JavaScript statements on the base and on HEAD (`verify-dms-frontend` verdict rule 5). The CI configuration catches every scratch break in the last section, so it is the one to run on every push.

## The rules

A proxied request is one the backend receives for the visit. A page read is the server's own `GET /dms/page?…` or `GET /dms/sitelayout` for a page visit.

| Rule | Plain sentence | Harm when it breaks | On main |
| --- | --- | --- | --- |
| `DeclaredPrefixesOnly` | A proxied request reaches the backend only when the docs give the visit to a backend proxy, on a path a valid declaration covers. | A backend route nobody declared answers on the dashboard's origin. | holds |
| `SamePathAsMatched` | The backend receives the visit once, with its method and the normalized path and query the server matched. | A `..`, `%2e%2e`, `\` or `%2F` reaches a route outside the declared prefix. | holds |
| `SessionOnlyWhereDeclared` | The backend gets an `Authorization` only as the visitor's own session. On a proxied request it also needs a path an `auth: "session"` proxy covers that no public endpoint matches for the method. | A public or `auth: "none"` route, which no Origin check guards, acts as the signed-in user. | holds |
| `NoCrossSiteSessionWrite` | A request other than GET, HEAD or OPTIONS never reaches the backend with the session unless the visitor sent the frontend's own Origin. | Another site changes data as the signed-in user. | holds |
| `NoVisitorCredentials` | The backend never receives the visitor's `Cookie`, nor an `Authorization` the visitor sent. | The sealed session cookie leaves the server, or a caller picks the token. | holds |
| `ForwardedByTheProxy` | With no trusted proxy, `X-Forwarded-For`, `-Proto` and `-Host` are the socket's address, `http` and the request's Host, whatever the visitor sent. | A client picks the address the backend rate-limits and logs. | holds |
| `ListedHeadersOnly` | Of the visitor's headers, the backend gets only the ones the docs list, plus a matched public endpoint's declared headers. | A header the backend gives a meaning to (`x-dms-*`, a method override, `x-real-ip`, `cf-ipcountry`) comes from any caller. | holds |
| `DeclaredPrefixesReach` | A visit a valid declaration covers, that the renderer does not answer and the Origin rule does not refuse, reaches the backend. | A module's backend route answers 404 or a page. | holds |
| `WinningProxyDecides` | When proxies cover a path, the one with more literal segments wins, then a single `*` over `**`. Its auth mode decides whether a cross-site write gets 403 and whether a signed-in visitor's session goes. | A request goes out under another declaration's auth mode than the one written for its path. | finding F2 |
| `PublicEndpointsWork` | A visit to a public endpoint's method and path, under a covering proxy, reaches the backend without the session and without an Origin, with the endpoint's declared headers. | A provider's webhook is refused, or loses its secret header. | finding F1 |

A case in a finding is left out of the rules that finding breaks: F1 out of `PublicEndpointsWork`, F2 out of `WinningProxyDecides` and `DeclaredPrefixesReach`. The check then confirms that each finding's rule still breaks on its own cases.

## Findings on main

Each counterexample below is a run of the real server, as `check.mjs` printed it. The check shrinks it, then drops each declaration and header it does not need. F2's three effects come from the default seed, `--seed 1` and `--seed 2`.

- **F1, a public endpoint under an `auth: "none"` proxy loses its declared headers (`PublicEndpointsWork`).** `proxyAccess` (public-endpoints.mjs:346-348) returns `{ anonymous: true, headers: [] }` for an `auth: "none"` proxy before it looks for a public endpoint. `backendHeaders` then relays none of the endpoint's headers. The docs say a request to a public endpoint "carries the module's declared headers on top of the usual ones". With `DMS_BACKEND_PROXIES=[{"path":"/api/**","auth":"none"}]` and `DMS_PUBLIC_ENDPOINTS=[{"path":"/api/hooks","methods":["PUT"],"headers":["x-hook-secret","x-acme-signature"]}]`, `PUT /api/hooks` with `x-hook-secret` reaches the backend without it. A webhook that authenticates by that header is refused on every delivery. Under an `auth: "session"` proxy the same endpoint gets its header.
- **F2, the server's proxy order disagrees with its documented order (`WinningProxyDecides`).** `compilePathPattern` (path-patterns.mjs:47) ranks a pattern `literals * 4 + segments * 2 + (deep ? 0 : 1)`, and `resolveBackendProxies` (backend-proxies.mjs:143-145) sorts by it. Its TSDoc (path-patterns.mjs:14-16) says "more literal segments first, then a single-segment `*` over `**`". Two extra `*` segments outweigh one literal, so for `/api/hooks/a/b` the server picks `/api/*/*/*` (rank 13) over `/api/hooks/**` (rank 12). It happens only when a pattern has at least two more segments than a covering pattern with more literals. The DMS's own `/api/**` and `/dms/**` never trigger it. Three effects:
  - `/media/a/**` declared `auth: "none"` and `/media/*/*/*` with the session: a signed-in `HEAD /media/a/b/_dms` goes out with the session.
  - `/api/b/**` declared `auth: "none"` and `/api/*/*/*/**` with the session: a webhook's `POST /api/b/_dms/a/hooks` with no Origin gets 403.
  - `/api/icons/**` with the session and `/api/*/*/*/**` declared `auth: "none"`: `POST /api/icons/a/b/_dms` with no Origin goes out with no session and no 403. No session leaves, so this is not CSRF.

Both findings are left to the owner: the code or the docs may change. Neither lets a session out without an Origin check. `SessionOnlyWhereDeclared` and `NoCrossSiteSessionWrite` hold on every case, findings included.

## Real bug or modeling error

The counterexample ran on the real server, so the request and what the backend received happened. The question is whether the rule reads the docs right and whether the case can occur. Replay it alone with a scratch file next to `check.mjs` (delete it afterwards), pasting the printed declarations and visit:

```js
import { startServers } from "./drive.mjs";
import { RULES, seenOf } from "./rules.mjs";
const servers = await startServers();
const current = { deployment: { proxies: [{ path: "/api/**", auth: "none" }], endpoints: [{ path: "/api/hooks", methods: ["PUT"], headers: ["x-hook-secret"] }] }, visit: { method: "PUT", target: "/api/hooks", host: "own", origin: "absent", session: "none", headers: ["x-hook-secret"] } };
const observation = await servers.visit(current);
console.log(observation.status, observation.received, RULES.map((rule) => `${rule.name}: ${rule.broken(seenOf(current, observation)) ?? "keeps"}`));
servers.close();
```

A modeling error sits in one of three places:

- `contract.mjs` reads the docs wrongly. Check the sentence the rule cites. Where the docs are silent, the contract follows the TSDoc of the covered function, and a disagreement is a finding about that TSDoc, not a reason to copy the code. The contract's own readings: a trailing slash names the same path; the icon endpoint is the paths under `/api/_dms/icons/`; public endpoint methods and header names are case-insensitive; two equally specific proxies leave the choice to declaration order, so the rules accept either.
- `inputs.mjs` makes a request no browser or caller sends. Node's HTTP client and parser pass every target verbatim, so odd targets are real. Only the seven methods `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` and `OPTIONS` are generated: `fetch` refuses `TRACE`, and the proxy answers 502.
- `drive.mjs` loses track of the server. The check sets the declarations in the environment for each case, and the server reads them on each request in a workspace without built server modules (`loadServerModules`, module-server.mjs:291-323). A change that caches them, or a built `templates/vue/dist`, makes `DeclaredPrefixesReach` break on cases that follow another deployment. That is a harness error: run one deployment per process.

Otherwise the break is real. Assert only what the visitor and the backend observe: the status, and the backend's method, path, query and headers.

## Changing the check

- For an intended change of behaviour, change the docs first, then `contract.mjs` to match them, then rerun both configurations.
- Never weaken or drop a rule to make the check pass. A fixed finding leaves `FINDINGS` in `findings.mjs` once a replay confirms the fix (the check prints `HOLDS`). A new finding goes into `FINDINGS`, with the rules it breaks and the cases it covers, and into this file with its counterexample.
- When you change `inputs.mjs`, rerun the scratch breaks below. The CI configuration must still catch each one with the rule it names.
- Keep each file under 20,000 bytes, and the CI configuration under 15 s.
- After you confirm that the check describes the code at a newer commit, move the sync commit forward. Do it only then.

## Coverage record

Paths are under `templates/vue/`.

| What the check drives | Code |
| --- | --- |
| Refusing a foreign target | `isOriginForm`, `refuseForeignTarget` (server/request-target.mjs:14-59), `handleRequestSafely` (server.mjs:514-524) |
| Who answers a path | `handleRequest` (server.mjs:428-450), `requestOwner`, `reachesBackend` (server/request-routing.mjs:39-68), `isRendererFilePath` (server/module-routes.mjs:50-54), `isIconRequest` (server/icons.mjs:201-203), `ICON_API_PATH` (icon-api.mjs:7) |
| Reading the declarations | `loadServerModules`, `serverModules` (server/module-server.mjs:291-323), `environmentBackendProxies` (server/public-endpoints.mjs:180-197), `allowedPublicEndpoints`, `compilePublicEndpoint` (server/public-endpoints.mjs:258-296) |
| Valid proxies and their order | `proxyRejection`, `resolveBackendProxies`, `matchBackendProxy` (server/backend-proxies.mjs:59-156), `compilePathPattern` (server/path-patterns.mjs:25-50) |
| Session, Origin and public endpoints | `proxyAccess`, `matchPublicEndpoint` (server/public-endpoints.mjs:320-367), `isSameOrigin` (server/auth/client-ip.mjs:144-155), `readSession` (server/auth/session.mjs:163-168) |
| What the backend receives | `proxy` (server/proxy-request.mjs:30-57), `backendHeaders` (server/backend-request.mjs:17-38), `relayedHeaders`, `CLIENT_HEADERS` (server/auth/backend.mjs:10-66), `forwardedHeaders` (server/auth/client-ip.mjs:97-107), `backendUrl` (server/request-target.mjs:31-38), `sendWithinLimit` (server/proxy-transfers.mjs:133), `PLAIN_ANSWER_HEADERS` (server/proxy-compression.mjs:11) |
| Page reads | `SITE_LAYOUT_PATH`, `pagePath`, `loadPageProps` (server/page-props.mjs:17, 112-121, 217-240) |

The sync commit is `e1f5ef6705f6012cbdc1e8ff8079a85447f9dee9` on AntelopeJS/dms-frontend `feat/verify-dms-frontend-skill`.

## Bounds and what is left out

Each configuration covers its sample only: 200 or 2,000 generated cases per rule at a seed, over an alphabet of segments chosen to make declarations overlap. Deployments have one to five proxies and up to two public endpoints, from `DMS_BACKEND_PROXIES` and `DMS_PUBLIC_ENDPOINTS`. A pass says no case in the sample broke a rule, not that none can.

The check leaves out:

- module routes (`dms.server.ts`), the manifest's declarations (`generated-public-endpoints.json`) and the development server: the workspace has no built server modules. The manifest and the environment feed the same resolution.
- `DMS_TRUSTED_PROXY_HOPS`, `DMS_CLIENT_IP_HEADER` and `DMS_COUNTRY_HEADER`: no trusted proxy is configured, so the Origin check reads the request's Host.
- the session renewal on a refused page visit (`writeRequestFailure`), sign-in and sign-out, and the cookies the server writes back.
- the backend's answers: redirects, compression, streams, body limits (`maxBodyBytes` is generated only valid at 1 MiB or invalid).
- what the backend does with the path it gets, such as decoding `%2F`.
- methods other than the seven a browser sends.

## Confirm the check can fail

Each break was made in the real product code of the worktree, one at a time, and reverted with `git checkout` after the run. The CI configuration caught each one with exit 1, with the rule in the first column among the `BROKEN` lines.

| Rule | Scratch change | First `BROKEN` line of the rule |
| --- | --- | --- |
| `DeclaredPrefixesOnly` | a deep pattern matches inside a segment: `(?:/.*)?` becomes `.*` (path-patterns.mjs:43) | `the backend received GET /apix, but the docs give the visit to the page` |
| `SamePathAsMatched` | `backendUrl` sends `decodeURIComponent(pathname)` (request-target.mjs:37) | `the backend received HEAD /media/a/b/x.y/_dms, the server matched HEAD /media/a%2Fb/x.y/_dms` |
| `SessionOnlyWhereDeclared` | `proxyAccess` loses its `auth: "none"` return (public-endpoints.mjs:347-348) | `the backend received GET /api/hooksx with the session, and no auth: "session" proxy covers it` |
| `NoCrossSiteSessionWrite` | `proxyAccess` refuses nothing (public-endpoints.mjs:362) | `the backend received PUT /api/icons/ with the session, and the visitor sent no Origin` |
| `NoVisitorCredentials` | `backendHeaders` relays `cookie` (backend-request.mjs:23-31) | `the backend received GET /dms/page?path=%2Fapi with Cookie "zqother=zqmark-cookie"` |
| `ForwardedByTheProxy` | `trustedHops` defaults to 1 (client-ip.mjs:25) | `the backend received GET /dms/page?path=%2F%252F%252Fevil.example%2Fa with x-forwarded-host "zqmark-x-forwarded-host"` |
| `ListedHeadersOnly` | `backendHeaders` relays `x-http-method-override` (backend-request.mjs:23-31) | `the backend received GET /dms/page?path=%2Fdms with the visitor's x-http-method-override` |
| `DeclaredPrefixesReach` | `/x/**` no longer covers `/x`: `(?:/.*)?` becomes `/.*` (path-patterns.mjs:43) | `the visit answered 404 and the backend received nothing, though /dms/** covers it` |
| `WinningProxyDecides` | `resolveBackendProxies` sorts least specific first (backend-proxies.mjs:143-145) | `/api/b/** (auth: "session") decides: the backend received GET /api/b/icons/a without the session` |
| `PublicEndpointsWork` | `proxyAccess` checks the Origin before the public endpoints (public-endpoints.mjs:349) | `the public endpoint /api/hooks/*/* answered 403, and the backend received 0 requests` |

With every change reverted, both configurations exit 0 with F1 and F2 as recorded.

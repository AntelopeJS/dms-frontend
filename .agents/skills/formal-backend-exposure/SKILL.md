---
name: formal-backend-exposure
description: Property-based check, with fast-check, of what the renderer's frontend server (templates/vue/server.mjs) lets through to the backend. Generated deployments (DMS_BACKEND_PROXIES, DMS_PUBLIC_ENDPOINTS) and hostile visits run against the real server, and the check compares what a recording backend receives with the contract in the user docs. That covers which paths reach the backend, with which method and path, with whose session, after which Origin check, and with which headers, the `x-dms-ui-*` ones a module's client code sets included. Use when a change touches a file in its coverage record, or when a change to routing, backend proxies, public endpoints, the session or the forwarded headers needs proof that nothing new reaches the backend.
---

# Formal check: what reaches the backend

The frontend server stands between the browser and the backend. It decides which request reaches the backend, on which path, with the signed-in user's access token or without it, and after which Origin check. A mistake there opens a backend route on the dashboard's public origin, or lets another site act as the signed-in user (CSRF). Tests check the paths someone thought of. This check generates the deployments and the requests.

The promise comes from the user docs, `docs/7.deployment/3.routing-and-proxy.md`, `4.public-endpoints.md` and `5.security.md`, and, for the session's 30 days, `docs/5.frontend-modules/6.sessions-and-sign-in.md` ("Session lifetime and revocation"). `contract.mjs` restates it apart from the code. There is no verifier for this JavaScript, so the check tests the real code with generated inputs, not a model of it. Each case is one deployment and one request. The check sets the deployment's `DMS_BACKEND_PROXIES` and `DMS_PUBLIC_ENDPOINTS`, then sends the request raw over HTTP to the real `handleRequestSafely`. The server runs in production mode in front of a backend that records every request and answers `{}`. The rules compare what that backend received with what the docs allow.

- `contract.mjs` is the docs' contract: which declarations are valid, which proxy covers a path and which one wins, the public endpoints, the renderer's own paths, and the frontend's own Origin.
- `inputs.mjs` generates cases: overlapping and malformed declarations, and visits with dot segments, `%2e%2e`, `\`, `//`, `%2F`, extended segments (`/apix`), queries, foreign targets, every method a browser sends, own and foreign Origins and Hosts, valid, expired (sealed 31 days ago), forged and foreign session cookies, a `Sec-Fetch-Site` on or off, and headers the backend gives a meaning to, `x-dms-ui-*` and the look-alike `x-dms-ui` among them.
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
| CI (no flag) | 200 per rule and per finding | 3 to 9 s |
| Full (`--full`) | 2,000 per rule and per finding | 22 to 53 s |

The times are from a shared 16-core machine with a load average of 8 to 65. The check runs on one core. The seed defaults to `20261105`, and the same seed with the same fast-check version replays the same cases. The run stops if `templates/vue/generated-public-endpoints.json` or `templates/vue/dist/server-modules` exists, because either would add declarations the check does not generate.

- Exit 0 means every rule that held still holds, and each finding still breaks.
- Exit 1 means a rule changed. `BROKEN <Rule>` names a rule that held and now breaks, with the shrunk case under it. `HOLDS  <Rule>` names a finding that no longer breaks.
- Exit 2 means the harness could not run (a request got no answer, a stray file) or the arguments were wrong.

The lines that name a changed rule match `^(?:BROKEN|CHANGED|HOLDS) +(\w+)`, and `finding <Rule>` lines name a recorded finding. A rule that still holds prints in the lowercase `holds` line.

## When to run it

Run `--full` when a change touches a file in the coverage record below, this folder, or one of the three docs pages. A changed rule (exit 1) blocks the change. The CI configuration catches every scratch break in the last section, so it is the one to run on every push.

## The rules

A proxied request is one the backend receives for the visit. A page read is the server's own `GET /dms/page?…` or `GET /dms/sitelayout` for a page visit.

| Rule | Plain sentence | Harm when it breaks | On main |
| --- | --- | --- | --- |
| `DeclaredPrefixesOnly` | A proxied request reaches the backend only when the docs give the visit to a backend proxy, on a path a valid declaration covers. | A backend route nobody declared answers on the dashboard's origin. | holds |
| `SamePathAsMatched` | The backend receives the visit once, with its method and the normalized path and query the server matched. | A `..`, `%2e%2e`, `\` or `%2F` reaches a route outside the declared prefix. | holds |
| `SessionOnlyWhereDeclared` | The backend gets an `Authorization` only as the visitor's own session, which the server opens for 30 days after its last write. On a proxied request it also needs a path an `auth: "session"` proxy covers that no public endpoint matches for the method. | A public or `auth: "none"` route, which no Origin check guards, acts as the signed-in user, or a session cookie copied weeks ago keeps working. | holds |
| `NoCrossSiteSessionWrite` | A request other than GET, HEAD or OPTIONS never reaches the backend with the session unless the visitor sent the frontend's own Origin. | Another site changes data as the signed-in user. | holds |
| `NoVisitorCredentials` | The backend never receives the visitor's `Cookie`, nor an `Authorization` the visitor sent. | The sealed session cookie leaves the server, or a caller picks the token. | holds |
| `ForwardedByTheProxy` | With no trusted proxy, `X-Forwarded-For`, `-Proto` and `-Host` are the socket's address, `http` and the request's Host, whatever the visitor sent. | A client picks the address the backend rate-limits and logs. | holds |
| `ListedHeadersOnly` | Of the visitor's headers, the backend gets only the ones the docs list, a matched public endpoint's declared headers, and the `x-dms-ui-*` headers as the visitor sent them, none of them when the browser marked the visit as sent from another origin or site. | A header the backend gives a meaning to (`x-dms-*` but `x-dms-ui-*`, a method override, `x-real-ip`, `cf-ipcountry`) comes from any caller, or a page on another origin sets a `x-dms-ui-*` marker. | holds |
| `UiHeadersRelayed` | Every backend request for a visit, a page read included, carries the visit's `x-dms-ui-*` headers as sent, unless the browser marked the visit as sent from another origin (an Origin that is not the frontend's) or site (a `Sec-Fetch-Site` other than `same-origin`). | A module's client code cannot mark its own requests, and a backend route that requires the marker refuses the dashboard's own UI. | holds |
| `DeclaredPrefixesReach` | A visit a valid declaration covers, that the renderer does not answer and the Origin rule does not refuse, reaches the backend. | A module's backend route answers 404 or a page. | holds |
| `WinningProxyDecides` | When proxies cover a path, the one with more literal segments wins, then a single `*` over `**`. Its auth mode decides whether a cross-site write gets 403 and whether a signed-in visitor's session goes. | A request goes out under another declaration's auth mode than the one written for its path. | holds |
| `PublicEndpointsWork` | A visit to a public endpoint's method and path, under a covering proxy, reaches the backend without the session and without an Origin, with the endpoint's declared headers. | A provider's webhook is refused, or loses its secret header. | holds |

A case in a finding is left out of the rules that finding breaks. The check then confirms that each finding's rule still breaks on its own cases. No finding is recorded today.

A fixed finding stays in `FIXED` (`findings.mjs`). Its cases are still sampled on their own, and its rule must hold on them. A random sample may not draw them, so the guard keeps the bug from coming back unseen. F1, a public endpoint under an `auth: "none"` proxy that lost its declared headers (AntelopeJS/dms-frontend#290), is one.

## Findings on main

None is open. A new finding is recorded with its counterexample, a run of the real server as `check.mjs` printed it, shrunk to the declarations and headers it needs.

F1 (AntelopeJS/dms-frontend#290), a public endpoint under an `auth: "none"` proxy that lost its declared headers, is fixed: `proxyAccess` now looks for a public endpoint before it returns for `auth: "none"`. `PublicEndpointsWork` holds on every case, and F1 stays in `FIXED`.

F2 (AntelopeJS/dms-frontend#291), a proxy order that let extra `*` segments outrank a literal, needed a `*` before the last segment. AntelopeJS/dms-frontend#275 refuses that form, so F2 can no longer occur, and `WinningProxyDecides` holds on every case.

## Real bug or modeling error

The counterexample ran on the real server, so the request and what the backend received happened. The question is whether the rule reads the docs right and whether the case can occur. Replay it alone with a scratch file next to `check.mjs` (delete it afterwards), pasting the printed declarations and visit:

```js
import { startServers } from "./drive.mjs";
import { RULES, seenOf } from "./rules.mjs";
const servers = await startServers();
const current = { deployment: { proxies: [{ path: "/api/**", auth: "none" }], endpoints: [{ path: "/api/hooks", methods: ["PUT"], headers: ["x-hook-secret"] }] }, visit: { method: "PUT", target: "/api/hooks", host: "own", origin: "absent", fetchSite: "absent", session: "none", headers: ["x-hook-secret"] } };
const observation = await servers.visit(current);
console.log(observation.status, observation.received, RULES.map((rule) => `${rule.name}: ${rule.broken(seenOf(current, observation)) ?? "keeps"}`));
servers.close();
```

A modeling error sits in one of three places:

- `contract.mjs` reads the docs wrongly. Check the sentence the rule cites. Where the docs are silent, the contract follows the TSDoc of the covered function, and a disagreement is a finding about that TSDoc, not a reason to copy the code. The contract's own readings: a trailing slash names the same path; the icon endpoint is `/api/_dms/icons` and the paths under it; public endpoint methods and header names are case-insensitive; two equally specific proxies leave the choice to declaration order, so the rules accept either.
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
| Refusing a foreign target | `isOriginForm` (server/request-target.mjs:5-20), `hasOriginFormTarget` (server/request-target.mjs:58-72), `handleRequestSafely` (server.mjs:527-547) |
| Who answers a path | `handleRequest` (server.mjs:441-500), `requestOwner`, `reachesBackend` (server/request-routing.mjs:20-75), `isRendererFilePath` (server/module-routes.mjs:44-55), `isIconRequest` (server/icons.mjs:195-207), `ICON_API_PATH` (icon-api.mjs:7) |
| Reading the declarations | `currentDeclarations`, `serverModules`, `loadServerModules` (server/module-server.mjs:243-341), `reconfirmSession` (server/module-server.mjs:343-369, no module here), `environmentBackendProxies` (server/public-endpoints.mjs:165-192), `allowedPublicEndpoints`, `compilePublicEndpoint` (server/public-endpoints.mjs:245-292) |
| Valid proxies and their order | `proxyRejection`, `resolveBackendProxies`, `matchBackendProxy` (server/backend-proxies.mjs:53-160), `compilePathPattern` (server/path-patterns.mjs:25-61) |
| Session, Origin and public endpoints | `proxyAccess`, `matchPublicEndpoint` (server/public-endpoints.mjs:309-360), `isSameOrigin` (server/auth/client-ip.mjs:140-155), `readSession` with its 30 days (server/auth/session.mjs:216-227) |
| What the backend receives | `proxy` (server/proxy-request.mjs:9-58), `backendHeaders` (server/backend-request.mjs:7-38), `relayedHeaders`, `CLIENT_HEADERS`, `isCrossOrigin`, `uiHeaders` (server/auth/backend.mjs:10-116), `forwardedHeaders` (server/auth/client-ip.mjs:83-107), `backendUrl` (server/request-target.mjs:22-39), `sendWithinLimit` (server/proxy-transfers.mjs:116-148), `PLAIN_ANSWER_HEADERS` (server/proxy-compression.mjs:11) |
| Page reads | `SITE_LAYOUT_PATH`, `pagePath`, `loadPageProps` (server/page-props.mjs:17, 102-123, 191-252) |

The sync commit is `f9085e6e3db95d43c5c52bc662a157a659e63a3f` on AntelopeJS/dms-frontend `next`.

## Bounds and what is left out

Each configuration covers its sample only: 200 or 2,000 generated cases per rule at a seed, over an alphabet of segments chosen to make declarations overlap. Deployments have one to five proxies and up to two public endpoints, from `DMS_BACKEND_PROXIES` and `DMS_PUBLIC_ENDPOINTS`. A pass says no case in the sample broke a rule, not that none can.

The check leaves out:

- module routes (`dms.server.ts`), the manifest's declarations (`generated-public-endpoints.json`) and the development server: the workspace has no built server modules. The manifest and the environment feed the same resolution.
- `DMS_TRUSTED_PROXY_HOPS`, `DMS_CLIENT_IP_HEADER` and `DMS_COUNTRY_HEADER`: no trusted proxy is configured, so the Origin check reads the request's Host.
- the session renewal on a refused page visit (`writeRequestFailure`), the 5-minute reconfirmation (`reconfirmSession`, which calls the sign-in module's `refreshSession` through `serverAuth.reconfirm` in `server/auth-hooks.mjs`) and the revocation it brings: no module declares sign-in, so the harness's `reconfirmSession` renews nothing. Also left out: sign-in and sign-out, and the cookies the server writes back.
- the `x-dms-ui-*` headers of a module route's `event.backend()` and of a server render's backend read (`serverReads`, `server/in-place-render.mjs`): no module route or server render runs here. `backendHeaders` builds the headers of the proxy and of the page reads, which the check covers.
- the backend's answers: redirects, compression, streams, body limits (`maxBodyBytes` is generated only valid at 1 MiB or invalid).
- what the backend does with the path it gets, such as decoding `%2F`.
- methods other than the seven a browser sends.

## Confirm the check can fail

Each break was made in the real product code of the worktree, one at a time, and reverted with `git checkout` after the run. The CI configuration caught each one with exit 1, with the rule in the first column among the `BROKEN` lines.

| Rule | Scratch change | First `BROKEN` line of the rule |
| --- | --- | --- |
| `DeclaredPrefixesOnly` | a deep pattern matches inside a segment: `(?:/.*)?` becomes `.*` (path-patterns.mjs:14) | `the backend received PATCH /api/hooks/x.yx, but the docs give the visit to the not-found` |
| `SamePathAsMatched` | `backendUrl` sends `decodeURIComponent(pathname)` (request-target.mjs:36) | `the backend received HEAD /media/a/b/x.y/_dms, the server matched HEAD /media/a%2Fb/x.y/_dms` |
| `SessionOnlyWhereDeclared` | `proxyAccess` loses its `auth: "none"` exception (public-endpoints.mjs:349) | `the backend received GET /a/_dmsx/_dms with the session, and no auth: "session" proxy covers it` |
| `SessionOnlyWhereDeclared` | `readSession` opens a session whatever its age: it returns `sealed` (session.mjs:226) | `the backend received GET /dms/page?path=%2Fdmsx with Authorization "Bearer session-access-token", which is not the visitor's session` |
| `NoCrossSiteSessionWrite` | `proxyAccess` refuses nothing: `isRefused` is `false` (public-endpoints.mjs:358) | `the backend received PATCH /api with the session, and the visitor sent no Origin` |
| `NoVisitorCredentials` | `backendHeaders` relays `cookie` (backend-request.mjs:28) | `the backend received GET /dms/page?path=%2Fapi with Cookie "zqother=zqmark-cookie"` |
| `ForwardedByTheProxy` | `trustedHops` defaults to 1 (client-ip.mjs:26) | `the backend received GET /dms/page?path=%2Fapi%2Fa%2Ficons with x-forwarded-host "zqmark-x-forwarded-host", expected "127.0.0.1:<port>"` |
| `ListedHeadersOnly` | `backendHeaders` relays `x-http-method-override` (backend-request.mjs:28) | `the backend received GET /dms/page?path=%2Fdmsx with the visitor's x-http-method-override` |
| `ListedHeadersOnly` | `uiHeaders` no longer drops the headers of a cross-origin visit: its first line is removed (backend.mjs:54) | `the backend received GET /dms/page?path=%2Fapi with x-dms-ui-other, though the browser marked the visit as sent from another origin` |
| `ListedHeadersOnly` | `isCrossOrigin` ignores `Sec-Fetch-Site`: `(site !== undefined && site !== "same-origin")` becomes `false` (backend.mjs:42) | `the backend received GET /dms/page?path=%2Fapi%2Fa%2Ficons with x-dms-ui-other, though the browser marked the visit as sent from another origin` |
| `ListedHeadersOnly` | `isCrossOrigin` ignores the Origin: its first operand becomes `false` (backend.mjs:41) | `the backend received GET /dms/page?path=%2Fapi%2F_dms%2Fx.y%2Fa%2F_dms with x-dms-ui-other, though the browser marked the visit as sent from another origin` |
| `ListedHeadersOnly` | `uiHeaders` matches the prefix `x-dms-ui` without its dash (backend.mjs:57) | `the backend received GET /dms/page?path=%2Fdmsx with the visitor's x-dms-ui` |
| `UiHeadersRelayed` | `uiHeaders` returns no header: its first line becomes `return {};` (backend.mjs:54) | `the backend received GET /dms/page?path=%2Fdmsx without the visitor's x-dms-ui-assistant` |
| `DeclaredPrefixesReach` | `/x/**` no longer covers `/x`: `(?:/.*)?` becomes `/.*` (path-patterns.mjs:14) | `the visit answered 404 and the backend received nothing, though /dms/** covers it` |
| `WinningProxyDecides` | `resolveBackendProxies` sorts least specific first (backend-proxies.mjs:148) | `/media/b/** (auth: "none") decides: the visit is not refused, and it answered 403` |
| `PublicEndpointsWork` | `proxyAccess` checks the Origin before the public endpoints (public-endpoints.mjs:349) | `the public endpoint /api/hooks/*/* answered 403, and the backend received 0 requests` |

Reverting the fix of #290 (`git show 4a00496:templates/vue/server/public-endpoints.mjs`) is caught too: `BROKEN PublicEndpointsWork: the backend received PUT /api/a without the declared x-acme-signature`.

With every change reverted, both configurations exit 0 with no finding recorded.

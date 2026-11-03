---
covers:
  - templates/vue/frontend-runtime/cookies.ts
  - templates/vue/server/auth-hooks.mjs
  - templates/vue/server/auth/backend.mjs
  - templates/vue/server/auth/client-ip.mjs
  - templates/vue/server/auth/establish-endpoints.mjs
  - templates/vue/server/auth/session.mjs
docs:
  - docs/5.frontend-modules/6.sessions-and-sign-in.md
  - docs/7.deployment/5.security.md
---

# sessions

The session is a sealed, `HttpOnly`, `SameSite=Lax` cookie, scoped to the backend, that holds the tokens on the server. The module that owns sign-in registers hooks that renew a refused session once and retry the visit, build the `user` and `session` page props and send a signed-out visit to sign-in. `POST /auth/establish` opens a session from a declared backend endpoint.

## Sub-features

- `sessions-cookie`: the cookies `POST /auth/login` sets (names, lifetime with and without `keep_login`, `Secure` under `start`, `DMS_COOKIE_SECURE`), the view the browser may see, tampered and foreign cookies, renewal and `updatedAt`, sign-out, the same-origin rule, `localhost` read as `127.0.0.1`, and what a browser holds.
- `sessions-hooks`: renewal once and retry, one shared renewal for five concurrent visits, a refused renewal signs the browser out, signed-out redirects with `?redirect=`, exemptions by pattern, only the highest-priority provider, and a server without auth hooks.
- `sessions-establish`: the declared endpoint, 11 ways around the allow-list, manifest and environment endpoints, 2FA and tenant outcomes, the payload, and a backend refusal.
- `sessions-language`: `dms_locale` read from the request in four forms, one `lang` attribute, and the footer's language switcher setting the cookie for a year.
- `sessions-security`: no secret in any answer or built file, the bootstrap credential only in the ready report, a session needs the same `DMS_SESSION_SECRET`, and survives a restart that keeps it.
- `sessions-language-order`: a signed-in user's saved language decides the page whatever the `dms_locale` cookie says, for French and for English.

## How to get to it (user POV)

- The sign-in form, the footer's language switcher, any navigation of a signed-in dashboard, a module flow that ends with a session.

## Driving it with dms-control

```bash
dms-control journey "$RUN" sessions
```

## How the journeys observe sessions

`sessions-cookie` and `sessions-establish` call the run's frontend over HTTP with the administrator's credentials and read every `Set-Cookie` line. The hooks need a backend that refuses tokens, so `sessions-hooks`, `sessions-establish` and `sessions-security` start a second `ajs dms start` whose fake backend implements the DMS's sign-in routes (`proxy-signin.mjs`), with the fixture modules `sessions-fixture-*.mjs` in its server-modules bundle.

## Docs swept

| Page | Where it is asserted |
| --- | --- |
| 6.sessions-and-sign-in, Auth hooks | `sessions-hooks` |
| Interface language | `sessions-language` (cookie, form, lang attribute), `static-files-document` (SSR messages, catalog preload) |
| Opening a session from a module flow | `sessions-establish` |
| 5.security, Credentials | `sessions-security`; the development credential rows are below |
| Sessions and cookies | `sessions-cookie`, `routing-routes` (module cookies) |
| Same-origin checks | `sessions-cookie`, `proxy-access`, `routing-routes` |
| Behind a reverse proxy | `proxy-relay` |
| The development server | `static-files-dev` |
| Trusting module code | `sessions-hooks` (a route reads the token the browser never gets) |

## Not driven

| Behaviour | Why not |
| --- | --- |
| A page restored from history or the prefetch cache with an older `session.updatedAt` keeps the session and language | Needs two sessions of one account and browser back/forward cache timing; a client rule of the Inertia plugin. |
| `useDmsUserSession().fetch()` changes the language; `te()`, `tm()`, `getLocaleMessage()` on a page that holds only the rendered messages | Composable semantics inside the Vue app; the `dms-frontend-vue` tests own them. |
| The CLI merges the locale files into one catalog per language | A build step of the `build` feature. |
| A deployment scaled out to several processes needs sticky routing | An infrastructure rule; the server gives no cross-process guarantee to observe. |
| A discovered development credential goes only to the backend that published it; `--bootstrap-secret` is visible to other processes | Needs `.antelope/dev.json` written by `ajs project dev`; the run starts its backend with `project start`. |
| The OAuth relay secret, and a conflict between two modules that publish different values | The playground configures no relay secret and has one publishing module. The render secret and the precedence against the variable are driven (`build/dev-secret-precedence`, issue draft `dms-frontend-secret-precedence-docs-contradict`). |
| `DMS_CLIENT_IP_HEADER` on AntelopeJS Cloud | A platform property; the variable itself is driven in `proxy-relay`. |

## Gotchas

- The session cookie is named `dms_session_<first 12 hex of sha256 of the backend URL>`; the journeys compute it.
- `sessions-hooks` makes a token stale by changing what its fake backend accepts, then signs in again for each scenario because a renewal is shared by refresh token for 15 seconds.
- `event.session.view()` inside the route that writes the session shows the request's session, not the one just written.
- The language switcher is a combobox named `Language`; its options are lower case (`français`).

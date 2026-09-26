# @antelopejs/dms-frontend

<div align="center">
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge&labelColor=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://antelopejs.com"><img src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

Frontend-agnostic loader for AntelopeJS DMS. The backend serves a frontend
manifest and the matching frontend-module archives; the `ajs dms` CLI
materializes them into a generated workspace for one renderer, builds it, and
runs its Node frontend server. The `vue` renderer — Vue 3, Vite, Inertia, and
SSR — is the one shipped today. The package itself installs a single executable,
`ajs-dms`; `ajs dms` is the core CLI delegating to it, and is the name every
project, script and document uses.

## Renderers

A renderer is the target framework a generated workspace is built for. The
loader's contract with a renderer has three parts:

- **Manifest negotiation.** `prepare`, `dev`, and `build` request the versioned
  `/dms/frontend` manifest with `renderer=vue&rendererVersion=3`
  (`src/manifest.ts`) and reject every module whose `renderer` does not match.
  The backend side is renderer-keyed too: `AddFrontendModule` takes a
  `renderer: { name, version }`, and each manifest module carries it back
  (`ManifestModule.renderer` in `src/workspace.ts`).
- **Workspace templates.** Every file of the generated workspace comes from
  `templates/<renderer>/` — `templates/vue/` today. `TEMPLATE_FILES` in
  `src/config.ts` lists what is copied verbatim, and `src/materialize.ts`
  resolves the template root, copies it, materializes the frontend modules
  under `frontend-modules/`, and writes `generated-frontend-modules.json` in
  manifest-priority order.
- **Generated server.** `templates/vue/server.mjs` and `templates/vue/server/`
  become the Node server that `ajs dms start` runs from the built workspace:
  Inertia visits, backend proxying, sessions, and email rendering.

`vue` (version `3`) is the only renderer this package ships, and the loader
rejects a manifest that declares any other. Renderers for other frameworks —
React, Svelte, Solid — are a direction, not a promise: nothing in the package
implements them yet. Adding one means a new `templates/<renderer>/` tree, plus
making the template root (`src/materialize.ts`) and the manifest query
(`src/manifest.ts`) renderer-aware instead of hardcoding `vue`. There is no
`--renderer` flag and no renderer registry; the single-renderer assumption is
deliberate until a second renderer exists. Whatever a renderer names its module
entry is its own convention: `dms.frontend.ts` and the
`#dms/frontend-module` alias belong to the Vue renderer, not to the
loader.

## Application ownership

The generated Inertia application owns page resolution, SSR, hydration, and the
root Vue tree. Every frontend module explicitly owns its native
`dms.frontend.ts` entry. That entry registers reusable pages, layouts,
components, plugins, and middleware through the frontend SDK; the loader does
not infer application ownership from other framework configuration.

## Install

The loader is an official AntelopeJS CLI plugin: install it next to
`@antelopejs/core` and run it as `ajs dms <command>`. That is the only supported
way to invoke it — in a shell, in a package script, in CI and in a container
alike.

```bash
# in a project (the usual case: both are already project dependencies)
pnpm add @antelopejs/core @antelopejs/dms-frontend

# or globally
pnpm add -g @antelopejs/core @antelopejs/dms-frontend
```

`npm install -g` works too; this repository and every generated workspace use
pnpm. Inside a package script, `ajs` resolves from `node_modules/.bin`, and the
`dms` command it delegates to resolves the project-local plugin, so a script
never depends on a global install.

## Commands

```bash
ajs dms prepare -b http://localhost:5010
ajs dms dev -b http://localhost:5010 -p 3001
ajs dms build -b https://dms.example.com
ajs dms start -b https://dms.example.com -p 3001
ajs dms clean -b https://dms.example.com
ajs dms clean --all
```

`--help`, `--version` and `clean` run from any directory. `prepare` also runs
anywhere: with no backend in reach it warns and exits 0, so a frontend module's
`postinstall` hook never fails an install, and the generated types are refreshed
later from a development environment. `dev`, `build` and `start` need a backend
URL, either through `-b` or through the enclosing antelope project's
`.antelope/dev.json`, and say so on exit 1 when they have neither;
`verify-source` needs `--layer` instead.

The CLI checks npm for a newer release at most once a day and prints a one-line
notice on stderr. A lookup that comes back empty — offline, throttled, or simply
raced by a command that blocked the event loop past the deadline — is retried
after an hour instead of counting as the day's attempt. The throttle stamp lives
at `~/.antelopejs/dms-frontend/update-check.json`. Set
`NO_UPDATE_NOTIFIER=1`, pass `--no-update-check`, or run under `CI` to turn the
check off.

Manifest negotiation and module materialization are the renderer contract described in [Renderers](#renderers).

The generated Vue application uses `@inertiajs/vue3`, `@nuxt/ui/vite` with `{ router: "inertia" }`, and `@nuxt/ui/vue-plugin`. The Node server resolves each Inertia visit through `/dms/page?path=…`, including fresh shared data so account, tenant, and permission changes update navigation state. It proxies backend routes and manages authentication through server-side sessions. `DMS_BOOTSTRAP_SECRET` is used only by the CLI's server-to-server frontend manifest and module archive requests and is never sent by, or exposed to, browser traffic.

Vue modules register through `dms.frontend.ts` and import the SDK from the `#dms/frontend-module` alias, which the loader resolves to the generated `frontend-module.ts`: `defineDmsPlugin`, `useDmsRouter`, the page and session types, and everything else a module needs from the host. Email templates register separately through `dms.email.ts`.

An email entry exports `serverEmailTemplates` and may export a plain `appConfig` object, such as shared branding defaults. Email rendering merges these configurations in manifest-priority order and provides them to `useDmsAppConfig` per render. Public runtime options come from the module manifest; `DMS_CLIENT_BASE_URL` overrides `public.dms.clientBaseUrl`. Email entries must not import the browser frontend module.

Email builds ship complete merged translation catalogs as JSON under `dist/server/locales/`, separate from executable JavaScript. Deploy the entire `dist/server` directory. Each render loads only its requested language and the English fallback; arbitrary translation keys and module overrides remain available. Unknown languages fall back to English, while missing or corrupt files for a supported language fail rendering rather than silently dropping translations. The source harness keeps the 256 KiB JavaScript ceiling and reports locale-data bytes separately.

## Frontend modules

A materialized module opts into the Vue adapter with a root `dms.frontend.ts`:

```ts
import MyBlock from "./components/MyBlock.vue";
import MyPage from "./pages/MyPage.vue";
import type { DmsFrontendModule } from "#dms/frontend-module";

const frontendModule: DmsFrontendModule = {
  setup(sdk) {
    sdk.registerComponent("MyBlock", MyBlock);
    sdk.registerPage("default", MyPage);
  },
};

export default frontendModule;
```

The SDK also exposes `use` for Vue plugins. Entries execute by descending manifest priority, then stable module id. Modules without `dms.frontend.ts` are skipped by the generated loader. Registered page keys match a route's `fullSlug`, request path, or `default`; unregistered pages and components use the generic card renderer.

### Redirecting typed access refusals

A backend can refuse a whole surface with a typed 403 whose body is a machine-readable code, such as a tenant access gate blocking a suspended workspace. A module that owns such a code registers where a refused page visit goes instead of the error page:

```ts
sdk.registerAccessRedirect(
  "saas.errors.workspace.access_blocked",
  "/workspace-suspended",
);
```

The server answers the refused visit, document or Inertia, with a redirect to that path before anything renders, so a reload lands there directly. The body may be the bare code or JSON (`"code"` or `{ "message": "code" }`). A destination refused in turn keeps the error page instead of looping. The first registration of a code wins, in manifest-priority order.

### Components rendered inside `<svg>`

Modules usually register their components lazily, with `defineAsyncComponent`, and the page is rendered under a `<Suspense>`. Vue mounts an async component that resolves under a `<Suspense>` with the `<Suspense>`'s element namespace rather than the namespace of the place it is rendered: a component resolved by name (`resolveComponent` or a template tag) whose root is an SVG element (`<path>`, `<g>`, …) is created as an HTML element inside the `<svg>`, and the browser draws nothing ([vuejs/core#15639](https://github.com/vuejs/core/issues/15639)). Import such components directly instead, for example the node and edge types passed to Vue Flow:

```ts
import { markRaw } from "vue";
import RelationEdge from "./RelationEdge.vue";

const edgeTypes = markRaw({ relation: RelationEdge });
```

### Layer aliases outside the workspace

Every layer a module ships under `layers/<name>/` answers to `#<name>` inside
the generated workspace. That convention is exported, so a module's own tooling
can reuse it instead of restating it — a unit test runs the module's Vue
sources outside the workspace, where nothing otherwise supplies `#dms-core` or
`#dms-ui`:

```ts
// vitest.config.ts, in a DMS frontend module
import { frontendLayerAliases } from "@antelopejs/dms-frontend/common";

export default defineConfig({
  resolve: {
    alias: frontendLayerAliases(
      resolve(__dirname, ".antelope/cache/@antelopejs/dms/frontend-vue"),
    ),
  },
});
```

`frontendLayerAliases` reads a module root on disk and needs no backend,
manifest or materialized workspace. `frontendLayerTypePaths` returns the same
layers in tsconfig `paths` shape, and `resolveFrontendLayers` is the primitive
behind both. Pass several module roots in increasing precedence to overlay
them: when two modules expose a layer of the same name, the last one wins,
which is the order the loader itself materializes them in.

## Discovery, caching, and security

In development, `ajs dms` discovers the backend from the nearest live `.antelope/dev.json`. It reads the local bootstrap credential from `.antelope/dms-dev.json` only when that discovered backend matches the destination URL. For production and CI, set `DMS_API_BASE_URL` and `DMS_BOOTSTRAP_SECRET` in the environment, or in the project's `.env`, rather than passing credentials on the command line.

Each canonical backend URL gets an owner-only workspace under `~/.antelopejs/dms-frontend` (see [Workspaces](#workspaces) for how the key is derived). Manifest caches, private module configuration, and extracted archives retain restrictive permissions. `--offline` reuses the last successful manifest and archive; an authorization failure never falls back to privileged cached data.

## Configuration

Every command loads `.env.local` then `.env` from the **current working
directory** before it parses its options, so a project can keep its
configuration in a file instead of exporting variables by hand:

```bash
# .env
DMS_API_BASE_URL=http://localhost:5010
DMS_CLIENT_BASE_URL=http://localhost:3001
DMS_BOOTSTRAP_SECRET=replace_with_a_strong_random_value
DMS_SESSION_SECRET=replace_with_at_least_32_characters
```

Precedence is environment, then `.env.local`, then `.env`: a variable already
present in the environment is never overwritten, so `DMS_API_BASE_URL=… ajs dms
build` and a CI job's injected secrets always win over a file left in the
checkout. A variable exported as an empty string counts as set. Only the
current directory is read — never a parent directory, and never the generated
workspace under `~/.antelopejs/dms-frontend`, which is this tool's own output
and is handed its environment explicitly by the command that spawns it. The
values loaded here reach the workspace build started by `build`, the dev server
started by `dev`, and the production server started by `start`, because those
child processes inherit the environment. A missing file is not an error; an
unreadable one is reported and skipped.

`ajs dms dev` generates a fresh ephemeral 32-byte secret when
`DMS_SESSION_SECRET` is absent; all sessions are invalidated when that dev
server restarts. An explicit value is preserved, but empty or shorter than 32
characters is rejected. `build` and `start` require a configured secret and
never generate one, which is required for production so sessions survive
restarts. The generated server also validates the value as a safety net.
Generate one with `openssl rand -hex 32`.

### Opening a session from a module flow

`/auth/login`, `/auth/signup` and `/auth/verify-2fa` are not the only ways a
visitor becomes authenticated: a module can own a flow that ends in an
authenticated user — a self-service registration completing after payment, an
invitation being redeemed — and needs the session cookie opened at the end of
it. `POST /auth/establish` is the generic form of those three routes.

The browser names a backend endpoint and the payload to send it:

```ts
await $fetch("/auth/establish", {
  method: "POST",
  body: {
    endpoint: "/api/saas/register/finalize",
    payload: { /* whatever that backend route expects */ },
  },
});
```

The frontend server calls that endpoint itself over its own server-to-server
channel to `DMS_API_BASE_URL`, exactly as it calls `/api/auth/login`, and
writes the session from the token pair the backend answers with. The browser
never sends a token and never receives one: it gets back the same
`{ user, account }` body the login route returns, and the two-factor and
tenant-assignment outcomes are handled identically.

Because the route turns a backend endpoint into a login, it only calls the
endpoints that were declared for it.

Backend modules declare their own. A module registering its frontend names the
routes that finish its flow, the DMS aggregates them into the frontend manifest
it serves with the bootstrap secret, and `dev`/`build` write them into the
workspace as it is materialized:

```ts
// in the backend module
await AddFrontendModule({
  name: "@antelopejs/dms-saas-frontend-vue",
  sourcePath: path.join(__dirname, "../frontend-vue"),
  renderer: { name: "vue", version: "3" },
  authEstablishEndpoints: ["/api/saas/register/finalize"],
});
```

A standard deployment therefore needs no configuration at all. The environment
variable stays as an override, for a backend route no module declares — or one
declared by a DMS too old to carry the field:

```bash
# .env
DMS_AUTH_ESTABLISH_ENDPOINTS=/api/invites/redeem
```

The effective allow-list is the union of the two. Every entry, from either
source, is matched verbatim against absolute `/api/…` paths — no prefixes, no
query strings, no traversal — so no backend route that happens to mint a token
pair can be turned into a login by a request from the browser. An undeclared
endpoint is answered `403` and never called. The route is `POST`-only and
same-origin, like every other auth action.

### Workspaces

Each canonical backend URL gets its own owner-only workspace under
`~/.antelopejs/dms-frontend/<sha256>/`; `build`, `start`, `clean -b` and
`dev -b` all key on that URL, so one backend means one workspace shared by
every command.

`dev` without `-b` is the deliberate exception. It discovers the backend from
the enclosing antelope project's `.antelope/dev.json` and keys its workspace on
the **project directory** instead, because a development backend can land on a
different port between runs and re-keying on the URL would discard
`node_modules`, the manifest cache and the client-side appId scope every time it
does. The consequence is that `ajs dms dev` followed by `ajs dms build -b <url>`
against the same backend creates two workspaces of their own — several hundred
megabytes each. Pass `-b` to `dev` to share a single one. `clean --all` lists
both and names the project a workspace is keyed on; `clean -b <url>` only
reaches the URL-keyed one.

A `DMS_API_BASE_URL` line in `.env` counts as an explicit backend, so a project
that configures one gets the single shared workspace and gives up autodiscovery
— including its tolerance for the backend moving to another port. Leave the
variable out of `.env` to keep autodiscovery for `dev`.

## Rendering model

The Node server renders full-page requests through the Vite SSR bundle and sends
the matching Inertia page object to the browser for hydration. Subsequent
`X-Inertia` visits receive page objects and render client-side. Client-only
plugins and `DmsClientOnly` defer browser-only work while the same generated
frontend-module registry drives server and client entries.

## Options

| Option | Environment | Purpose |
| --- | --- | --- |
| `-b, --backend-url` | `DMS_API_BASE_URL` | DMS backend URL |
| `-p, --port` | `PORT` | Frontend port, default `3001` |
| `-f, --force` | | Reinstall workspace dependencies |
| `--offline` | `DMS_OFFLINE` | Reuse cached manifest and archives |
| `--bootstrap-secret` | `DMS_BOOTSTRAP_SECRET` | Backend bootstrap credential |
| | `DMS_COOKIE_SECURE` | Secure cookies (`true` by default; `ajs dms dev` defaults to `false`) |
| | `DMS_TRUSTED_PROXY_HOPS` | Number of trusted, rightmost reverse-proxy hops (default `0`) |
| | `DMS_SESSION_SECRET` | Session cookie encryption key, 32 characters or more (required for login) |
| | `DMS_AUTH_ESTABLISH_ENDPOINTS` | Extra backend endpoints `/auth/establish` may open a session from, on top of those the backend's modules declare (comma-separated, empty by default) |
| | `DMS_CLIENT_BASE_URL` | Public frontend URL used in generated links and emails |

All of these can be set in the project's `.env` instead of the environment; see [Configuration](#configuration).

Use pnpm for all repository and workspace operations.

## Verify local frontend modules

Use the packaged source verifier to validate an unpublished DMS frontend package against this exact adapter version. Additional modules and local package bindings are repeatable. All supplied frontend packages are copied into the generated workspace and bound with `workspace:*`.

```bash
ajs dms verify-source \
  --layer /path/to/dms/frontend-vue \
  --module /path/to/module/frontend-vue \
  --local-package @antelopejs/dms=/path/to/dms
```

The verifier prints its generated workspace path, builds client, SSR, and email bundles, runs `vue-tsc`, renders eight DMS email templates, and checks that the email bundle excludes browser-only modules. It leaves the generated workspace in the temporary directory for inspection. It does not start a backend or publish packages. Repository development can invoke the same runner with `DMS_LAYER_SOURCE` through `pnpm test:real-source`.

Refresh rotation is single-flight within one frontend process. Horizontally scaled deployments must use sticky routing so a browser reaches the same process, or replace this process-local behavior with an external session adapter. It does not provide a distributed rotation guarantee.

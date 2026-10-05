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
  under `frontend-modules/`, and writes the files derived from them
  (`src/derived-outputs.ts`), `generated-frontend-modules.json` first, in
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

The plugin prints through the output module of `@antelopejs/core`
(`@antelopejs/core/cli`), so it needs `@antelopejs/core` 1.13.2 or later.
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
ajs dms workspaces
ajs dms workspaces --json
ajs dms clean -b https://dms.example.com
ajs dms clean --all
ajs dms help environment
```

`ajs dms <command> --help` shows what a command does, its options and a few
examples. `ajs dms help environment` lists every variable the CLI and the
generated server read, from the environment or the project's `.env`.

`--help`, `--version`, `workspaces` and `clean` run from any directory. `build` and `start`
need a backend URL through `-b` or `DMS_API_BASE_URL`, and exit 2 without one.
`dev` also discovers it from the enclosing antelope project's
`.antelope/dev.json`, and exits 1 when there is none to discover.
`verify-source` needs no backend: it runs in the project that installs `@antelopejs/dms`.

`prepare` runs anywhere: when it cannot prepare the workspace it warns on
stderr and exits 0, so a frontend module's `postinstall` hook never fails an
install. The warning says whether prepare was skipped or failed. Skipped means
no backend is in reach (no URL, an unreachable backend, `--offline` without a
cached manifest), as in CI: the generated types are refreshed later from a
development environment. Failed means something a later run will not fix: a
refused credential, an incompatible manifest or renderer range, an invalid URL.
A step that needs the types, such as a CI type-check, passes `--strict` (or
sets `DMS_PREPARE_STRICT=1`): prepare then exits 1 in every one of these cases,
and 2 when the backend URL is missing or invalid. On success, it says how many
modules it found and how long it took.

`build` ends with where it wrote the production frontend (the `dist`
directory of the workspace), how long it took, and the `ajs dms start` command
to run next, with the same backend URL and `DMS_SESSION_SECRET`. Its output is
deployed, so it never builds silently from the cache: when the backend cannot
be reached or fails, `build` exits 1, says whether a cached manifest exists and
how old it is, and builds from it only when asked with `--offline`. `dev` and
`prepare` still fall back to the cache, with a warning.

The commands follow the output contract of `ajs`: what the CLI itself prints
on stdout is only the help and the version, and everything else (progress,
warnings, errors) goes to stderr. The dependency install and each step of the
production build run as one progress line each: their output is kept and its
last lines are shown when they fail, with paths into the generated workspace
pointing at the frontend-module sources instead. The server `dev` and `start`
run keeps its own output. A command exits 0 on success, 1 on a failure, 2 on a
usage error (an unknown command or option, a missing or invalid argument, a
missing configuration value) and 130 when stopped with Ctrl+C. `--no-color` or
`NO_COLOR=1` turns colors off, and terminals that cannot draw Unicode, such as
`TERM=dumb`, get ASCII symbols. `--verbose` or `ANTELOPEJS_VERBOSE` streams
the full `pnpm` and Vite output, each line behind the name of the step, and adds
the stack trace of the underlying error to a failure; `--verbose=<channels>`
turns all of it on too, whatever the channels. `-q`, `--quiet` or
`ANTELOPEJS_QUIET=1` prints only results, warnings and errors: no command
header, progress, summary or update notice, and of the block a ready `dev` or
`start` server prints, only its Local URL. `ajs --no-color dms …`,
`ajs --verbose dms …`, `ajs --verbose=<channels> dms …` and `ajs -q dms …` set
those variables for the plugin; the same flags are also accepted after the
command, as in `ajs dms build -q`.

The CLI checks npm for a newer release at most once a day and prints a one-line
notice on stderr, only to a terminal: as the last line of a command that
succeeded, or under the ready block of `dev` and `start`. Help, `--version`,
`--json`, failed commands, pipes and `TERM=dumb` never show it. The lookup starts
with the command and never delays its exit; a lookup that comes back empty —
offline or throttled — is retried after an hour instead of counting as the day's
attempt. The throttle stamp lives at
`~/.antelopejs/dms-frontend/update-check.json`. Set `NO_UPDATE_NOTIFIER=1`, pass
`--no-update-check`, or run under `CI` to turn the check off.

Manifest negotiation and module materialization are the renderer contract described in [Renderers](#renderers).

The generated Vue application uses `@inertiajs/vue3`, `@nuxt/ui/vite` with `{ router: "inertia" }`, and `@nuxt/ui/vue-plugin`. The Node server resolves each Inertia visit through `/dms/page?path=…`, including fresh shared data so account, tenant, and permission changes update navigation state. It proxies backend routes and manages authentication through server-side sessions. `DMS_BOOTSTRAP_SECRET` is used only by the CLI's server-to-server frontend manifest and module archive requests and is never sent by, or exposed to, browser traffic.

Vue modules register through `dms.frontend.ts` and import the SDK from the `#dms/frontend-module` alias, which the loader resolves to the generated `frontend-module.ts`: `defineDmsPlugin`, `useDmsRouter`, the page and session types, and everything else a module needs from the host. Email templates register separately through `dms.email.ts`.

An email entry exports `serverEmailTemplates` and may export a plain `appConfig` object, such as shared branding defaults. Email rendering merges these configurations in manifest-priority order and provides them to `useDmsAppConfig` per render. Public runtime options come from the module manifest; `DMS_CLIENT_BASE_URL` overrides `public.dms.clientBaseUrl`. Email entries must not import the browser frontend module.

Email builds ship complete merged translation catalogs as JSON under `dist/server/locales/`, separate from executable JavaScript. Deploy the entire `dist/server` directory. Each render loads only its requested language and the English fallback; arbitrary translation keys and module overrides remain available. Unknown languages fall back to English, while missing or corrupt files for a supported language fail rendering rather than silently dropping translations. The source harness keeps the 256 KiB JavaScript ceiling and reports locale-data bytes separately.

`ajs-dms dev` builds the email bundle too, once the dev server is ready, and rebuilds it whenever an email template changes. The build runs in a separate low-priority process, so page reloads and HMR never wait on it; a render requested while a build is running waits for that build to finish.

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

Within one setup, the first module to register a name keeps it. `ajs-dms dev` sets every module up again each time a change to a layer reaches the server renderer, into empty registries, so the next server render uses the edited component without a restart. A `setup` may therefore run more than once in a process: it should only register, and keep no state of its own between runs.

### Private components

A component registers as public by default: it joins the application's global components and resolves by name anywhere. A component that only exists to render the module's own backend pages registers as private instead:

```ts
sdk.registerComponent("BillingTotals", BillingTotals, { private: true });
```

A private component is not registered with `app.component`, so no template or other module reaches it by name. `resolveDmsComponent(name, owner)` returns it only when `owner` is the registering module, and then ahead of a public component of the same name; without an owner, only public components resolve. The generic page renderer passes the page's owner, so a backend page tree naming the component renders it, and the page preloader and the server render's hydration handover cover it too.

The owner is the page payload's `module` field: the name of the frontend module that owns the page's component tree, as the backend added it (the module's `name` in the frontend manifest, which the generated loader hands each module's setup). A backend that does not send `module` reaches no private component, whatever the tree names.

### Auto-imports (`dms.frontend.build.ts`)

Nothing a module ships is auto-imported unless the module declares it, in an optional `dms.frontend.build.ts` next to its `dms.frontend.ts`:

```ts
import { defineDmsFrontendBuild } from "#dms/frontend-build";

export default defineDmsFrontendBuild((build) => {
  build.registerAutoImports([
    "layers/*/app/composables",
    "layers/*/app/utils",
    "layers/*/app/types",
  ]);
});
```

Each entry is a directory relative to the module root, glob patterns allowed; every export of the files under it becomes available to the whole application without an import, in scripts and templates. A module without the file has nothing auto-imported. `app/build/` holds a module's private code and is never auto-imported: it is left out of what a broader entry covers, and an entry naming it, or a directory outside the module, is ignored with a warning when Vite starts.

The file runs in Node.js when Vite starts, under `ajs dms dev` and `ajs dms build`, not in the application: it may import `#dms/frontend-build` and Node.js built-ins, never the application's code. Vite restarts when one changes.

Up to 0.3, every module's `app/composables`, `app/types`, `app/utils`, `app/build/composables` and `app/build/types` were auto-imported. A module that relies on auto-imports declares its public directories in `dms.frontend.build.ts`, and imports its `app/build/` code by path.

### Page loading state

After a client navigation, the page renders under a `<Suspense>` until its chunk and any async `setup` resolve. `useDmsPageLoading()` (auto-imported) is `true` meanwhile, so a layout can show its own placeholder instead of an empty page body:

```vue
<script setup lang="ts">
const pageLoading = useDmsPageLoading();
</script>

<template>
  <slot />
  <PageSkeleton v-if="pageLoading" />
</template>
```

It stays `false` on the server and during hydration, which render the page resolved, for a page that does not suspend, and once a pending page is left.

### Interface language

The interface language follows the session (`useUserSession().user.language`), not the props of the page on screen: the first render takes it from the session the page arrived with, and it changes when the session's language does, after `useUserSession().fetch()` or a visit with a newer session. A page Inertia restores from history or serves from its prefetch cache carries the session it was fetched with: the frontend server stamps every session it writes (`session.updatedAt`), and a page carrying an older stamp of the same account updates neither the session nor the language. A session without a language, such as a signed-out one, keeps the language on screen; `$i18n.setLocale()` still switches it at any time.

### Declaring the loader releases a module supports

A frontend module names the `@antelopejs/dms-frontend` releases it runs on in its own `package.json`, the way a package names the Node.js versions it supports:

```json
{
  "name": "@acme/dms-billing-frontend-vue",
  "engines": {
    "@antelopejs/dms-frontend": ">=0.3.2 <0.4.0"
  }
}
```

`prepare`, `dev`, `build` and `verify-source` read it before they generate anything, whether the manifest was just fetched or replayed from the cache, and stop when this release falls outside a module's range: `dev`, `build` and `verify-source` exit 1, and `prepare` warns and exits 0, as it does for any setup it cannot complete, unless `--strict` is given. The message names each such module, its range and this release, rather than letting the build, the type-check or a render fail later on an API the release no longer has, or does not have yet. A prerelease is checked as the release it leads to: `0.4.0-next.1` is outside `<0.4.0`. A module that declares no range still loads, and a warning names it once. `start` checks nothing: it runs what `build` produced.

Cap the range below the next breaking release, which is the next minor release while this package is 0.x, and widen it once the module has been checked against that release. A range left open to `<1.0.0` admits the very release that removes something the module calls.

The range is an engine rather than a peer dependency: the generated workspace installs every module as a workspace package, and pnpm installs a workspace package's peer dependencies, optional ones included, so a peer on the loader would pull a copy of it into every workspace. Package managers ignore an engine they do not know, and so does a loader released before this check.

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

Each canonical backend URL gets an owner-only workspace under `~/.antelopejs/dms-frontend` (see [Workspaces](#workspaces) for how the key is derived). Manifest caches, private module configuration, and extracted archives retain restrictive permissions. `--offline` reuses the last successful manifest and archive; `dev` and `prepare` also fall back to them when the backend cannot be reached or fails, and `build` only with `--offline`. An authorization failure never falls back to privileged cached data.

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
megabytes each. Pass `-b` to `dev` to share a single one. `workspaces` lists
both, with the project a workspace is keyed on, its size and its last use;
`clean -b <url>` only reaches the URL-keyed one. `clean` takes its target from
`-b` or `--all` only: it never reads `DMS_API_BASE_URL` from the environment or
`.env`, so running it without either is an error rather than a deletion.

`workspaces` prints an aligned table on a terminal. Piped, it prints one
tab-separated line per workspace, without a header: id, backend URL, key type
(`url` or `project`), project directory, size in bytes, last use (ISO 8601) and
workspace directory. `--json` prints one JSON document with the same fields;
everything else the command says goes to stderr.

`clean --all` lists what it removes and asks before removing it. Without a
terminal to ask on (a pipe, CI), it exits 2 unless `--yes` is given. Both forms
of `clean` say how much space they freed.

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

Under `ajs dms dev`, an edit to a module's `i18n/locales/*.json` regenerates the
merged catalogs the application imports: the next server render uses them, and
the open page applies them in place, without a reload. Adding or removing a
locale reloads the page instead.

The other files the workspace derives from every module follow their sources
the same way. A file added to, changed in or removed from a module's `public/`
is served, or no longer served, at once. Adding or removing an
`app/config/shortcuts-registry.ts` or a `dms.frontend.ts` regenerates the
aggregated shortcuts or the module loader, and the page reloads. Adding,
changing or removing a `dms.frontend.build.ts` restarts Vite. A layer
directory added to or removed from `layers/` is the exception: Vite reads the
`#<layer>` aliases and the auto-imported directories at startup only, so the
dev server says it needs a restart.

### Icons

The browser never asks a third party for an icon, so a Content-Security-Policy
needs no exception for the Iconify API. Icons reach the page two ways:

- **Bundled.** Nuxt UI's client bundle holds every icon its scanner finds in
  the workspace's Vue, Markdown and YAML files, the TypeScript of each layer's
  `app/` directory — `app.config.ts` and its `ui.icons` mappings included — and
  Nuxt UI's own defaults.
- **Served.** Any other icon, such as a page icon a backend module declares,
  is fetched from the frontend server itself: `main.ts` points `@iconify/vue`
  at `GET /api/_dms/icons/<prefix>.json?icons=<name>,…`, which answers in the
  Iconify API format from the collections installed in the workspace
  (`@iconify-json/<prefix>`, or `@iconify/json`). The workspace ships
  `@iconify-json/lucide` and `@iconify-json/ph`; a module using another
  collection depends on its `@iconify-json/*` package. An unknown collection
  answers `404`, and a name outside Iconify's naming rule `400`. `ajs dms dev`
  and `ajs dms start` run the same server, so both serve the route.

The server render draws every icon, bundled or not: the frontend server loads
each installed `@iconify-json/*` collection once and hands it to the renderer,
and an icon is drawn in its first render as soon as its data is loaded, instead
of after the component mounts. The data of each icon a render drew travels in
the page, so the browser draws the same icons as it hydrates; an icon no
installed collection holds stays empty on the server and is fetched in the
browser as before.

## Options

| Option | Environment | Purpose |
| --- | --- | --- |
| `-b, --backend-url` | `DMS_API_BASE_URL` (except `clean`) | DMS backend URL, `http://` or `https://` |
| `-p, --port` | `PORT` | Frontend port from 1 to 65535, default `3001`; `dev` moves to the next free port, `start` stops when it is in use |
| `-f, --force` | | Reinstall workspace dependencies; `build` also extracts the layers archive from scratch |
| `--offline` | `DMS_OFFLINE` | Reuse cached manifest and archives; the only way `build` uses them |
| `--strict` | `DMS_PREPARE_STRICT` | Make `prepare` fail instead of warning; see [Commands](#commands) |
| `--bootstrap-secret` | `DMS_BOOTSTRAP_SECRET` | Backend bootstrap credential |
| | `HOST` | Address the frontend server binds to (default `0.0.0.0`) |
| | `DMS_COOKIE_SECURE` | Secure cookies (`true` by default; `ajs dms dev` defaults to `false`) |
| | `DMS_TRUSTED_PROXY_HOPS` | Number of trusted, rightmost reverse-proxy hops (default `0`) |
| | `DMS_SESSION_SECRET` | Session cookie encryption key, 32 characters or more (required for login) |
| | `DMS_HTML_RENDER_SECRET` | Secret that verifies the backend's signed HTML/email render requests; without it, e-mail renders are refused. Defaults to the `htmlRender.serviceSecret` the backend publishes in the frontend manifest |
| | `DMS_OAUTH_RELAY_SECRET` | Secret the server presents to the backend's OAuth endpoints; without it, the backend refuses OAuth sign-in. Defaults to the `oauth.relaySecret` the backend publishes in the frontend manifest |
| | `DMS_AUTH_ESTABLISH_ENDPOINTS` | Extra backend endpoints `/auth/establish` may open a session from, on top of those the backend's modules declare (comma-separated, empty by default) |
| | `DMS_CLIENT_BASE_URL` | Public frontend URL used in generated links and emails |

All of these can be set in the project's `.env` instead of the environment; see [Configuration](#configuration).

`ajs dms dev` takes the two manifest secrets from the manifest it fetches, and `ajs dms start` from the manifest cached by `ajs dms build`. An explicitly set variable always wins over the manifest value. Before the server starts, both commands warn about each secret that is not set and what stops working without it; once the server is ready, they list where the others come from (the environment, the manifest or the build-time manifest), never their values. When several modules publish the same secret, the first one in manifest-priority order wins, and a module publishing a different value is named in a warning.

Use pnpm for all repository and workspace operations.

## Verify local frontend modules

Use the packaged source verifier to validate unpublished DMS frontend modules against this exact adapter version. Run it from the project:

```bash
ajs dms verify-source
```

The modules are verified on top of the DMS core layer, the `frontend-vue` directory of `@antelopejs/dms`. The verifier finds the `@antelopejs/dms` the project installs the way Node does, from the current directory, and names it before it starts: `Verifying against @antelopejs/dms 0.5.5 (installed in this project)`. When the project does not install it, the verifier stops with the command that adds it as a development dependency (`pnpm add -D @antelopejs/dms`, or the equivalent for the project's package manager).

Without `--module`, the verifier takes the current directory when it is a frontend module (it contains `dms.frontend.ts`), and its `frontend-vue` directory otherwise. `--module` names other ones and is repeatable, as is `--local-package`, which binds a local build of a package into the generated workspace. All supplied frontend packages are copied into the generated workspace and bound with `workspace:*`.

```bash
ajs dms verify-source --module ./admin-vue --module ./shop-vue
```

`--layer` is for the DMS core layer's own development: it verifies an unpublished core layer instead of the installed one, here against a local build of `@antelopejs/dms`:

```bash
ajs dms verify-source \
  --layer /path/to/dms/frontend-vue \
  --local-package @antelopejs/dms=/path/to/dms
```

The checks look for what the core layer ships: its lazily loaded chart and rich-text libraries, the pages every DMS serves and its e-mail templates. A `--layer` that holds no core layer, such as a project's own `frontend-vue`, is refused before anything is installed, with exit code 2 and the command that verifies the same folder with `--module` instead.

A supplied package whose declared range excludes this adapter version is refused before anything is installed (see [Declaring the loader releases a module supports](#declaring-the-loader-releases-a-module-supports)). The verifier generates a temporary workspace, installs it, builds client, SSR, and email bundles, checks what the client bundle loads, runs `vue-tsc`, renders eight DMS email templates, and checks that the email bundle excludes browser-only modules. Each check is one line that ends in ✔ or ✖, and the run ends with `Verified <n> modules` and its duration, or with the first failure: a type or Vite error points at the file in the package you passed (`./frontend-vue/app/components/Callout.vue:17:7`), not at its copy in the workspace, and the command exits 1. `--verbose` streams the pnpm, Vite and `vue-tsc` output. The workspace is removed when the run ends. It does not start a backend or publish packages. Repository development can invoke the same runner through `pnpm test:real-source`, with `DMS_LAYER_SOURCE` set to a core layer root and `DMS_MODULE_SOURCES` to a JSON array of module roots.

Refresh rotation is single-flight within one frontend process. Horizontally scaled deployments must use sticky routing so a browser reaches the same process, or replace this process-local behavior with an external session adapter. It does not provide a distributed rotation guarantee.

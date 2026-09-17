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
SSR — is the one shipped today.

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
`#dms-inertia/frontend-module` alias belong to the Vue renderer, not to the
loader.

## Application ownership

The generated Inertia application owns page resolution, SSR, hydration, and the
root Vue tree. Every frontend module explicitly owns its native
`dms.frontend.ts` entry. That entry registers reusable pages, layouts,
components, plugins, and middleware through the frontend SDK; the loader does
not infer application ownership from other framework configuration.

## Install

The loader is an AntelopeJS CLI plugin: install it next to `@antelopejs/core`
and `ajs` delegates its `dms` command to the `ajs-dms` executable.

```bash
pnpm add -g @antelopejs/core @antelopejs/dms-frontend
```

`npm install -g` works too; this repository and every generated workspace use
pnpm.

## Commands

```bash
ajs dms prepare -b http://localhost:5010
ajs dms dev -b http://localhost:5010 -p 3001
ajs dms build -b https://dms.example.com
ajs dms start -b https://dms.example.com -p 3001
ajs dms clean -b https://dms.example.com
ajs dms clean --all
```

`ajs dms <command>` and `ajs-dms <command>` are the same program; the delegation
only saves you from remembering a second executable name. Package scripts should
call `ajs-dms` directly so they do not depend on the CLI being installed.
`--help`, `--version` and `clean` run from any directory. `prepare` also runs
anywhere: with no backend in reach it warns and exits 0, so a frontend module's
`postinstall` hook never fails an install, and the generated types are refreshed
later from a development environment. `dev`, `build` and `start` need a backend
URL, either through `-b` or through the enclosing antelope project's
`.antelope/dev.json`, and say so on exit 1 when they have neither;
`verify-source` needs `--layer` instead.

The CLI checks npm for a newer release at most once a day — a failed lookup
counts as the day's attempt — and prints a one-line notice on stderr. The
throttle stamp lives at `~/.antelopejs/dms-frontend/update-check.json`. Set
`NO_UPDATE_NOTIFIER=1`, pass `--no-update-check`, or run under `CI` to turn the
check off.

Manifest negotiation and module materialization are the renderer contract described in [Renderers](#renderers).

The generated Vue application uses `@inertiajs/vue3`, `@nuxt/ui/vite` with `{ router: "inertia" }`, and `@nuxt/ui/vue-plugin`. The Node server resolves each Inertia visit through `/dms/page?path=…`, including fresh shared data so account, tenant, and permission changes update navigation state. It proxies backend routes and manages authentication through server-side sessions. `DMS_BOOTSTRAP_SECRET` is used only by the CLI's server-to-server frontend manifest and module archive requests and is never sent by, or exposed to, browser traffic.

Vue modules use `dms.frontend.ts` and the `#dms-inertia/frontend-module` SDK alias, which replaces the former `#cms-inertia` alias and is the import path every DMS frontend module now uses. Email templates register separately through `dms.email.ts`.

An email entry exports `serverEmailTemplates` and may export a plain `appConfig` object, such as shared branding defaults. Email rendering merges these configurations in manifest-priority order and provides them to `useDmsAppConfig` per render. Public runtime options come from the module manifest; `DMS_CLIENT_BASE_URL` overrides `public.dms.clientBaseUrl`. Email entries must not import the browser frontend module.

Email builds ship complete merged translation catalogs as JSON under `dist/server/locales/`, separate from executable JavaScript. Deploy the entire `dist/server` directory. Each render loads only its requested language and the English fallback; arbitrary translation keys and module overrides remain available. Unknown languages fall back to English, while missing or corrupt files for a supported language fail rendering rather than silently dropping translations. The source harness keeps the 256 KiB JavaScript ceiling and reports locale-data bytes separately.

## Frontend modules

A materialized module opts into the Vue adapter with a root `dms.frontend.ts`:

```ts
import MyBlock from "./components/MyBlock.vue";
import MyPage from "./pages/MyPage.vue";
import type { DmsFrontendModule } from "../../frontend-module";

const frontendModule: DmsFrontendModule = {
  setup(sdk) {
    sdk.registerComponent("MyBlock", MyBlock);
    sdk.registerPage("default", MyPage);
  },
};

export default frontendModule;
```

The SDK also exposes `use` for Vue plugins. Entries execute by descending manifest priority, then stable module id. Modules without `dms.frontend.ts` are skipped by the generated loader. Registered page keys match a route's `fullSlug`, request path, or `default`; unregistered pages and components use the generic card renderer.

## Discovery, caching, and security

In development, `ajs dms` discovers the backend from the nearest live `.antelope/dev.json`. It reads the local bootstrap credential from `.antelope/dms-dev.json` only when that discovered backend matches the destination URL. For production and CI, set `DMS_API_BASE_URL` and `DMS_BOOTSTRAP_SECRET` in the environment rather than passing credentials on the command line.

Each canonical backend URL gets an owner-only workspace under `~/.antelopejs/dms-frontend`. Manifest caches, private module configuration, and extracted archives retain restrictive permissions. `--offline` reuses the last successful manifest and archive; an authorization failure never falls back to privileged cached data.

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

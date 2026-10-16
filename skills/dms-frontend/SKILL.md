---
name: dms-frontend
description: Runs, builds, deploys and extends the AntelopeJS DMS frontend with @antelopejs/dms-frontend (the ajs dms CLI, the Vue renderer, the frontend-module SDK). Use when running ajs dms dev, build, start, prepare, workspaces, clean or verify-source; configuring DMS_* environment variables, the session or bootstrap secret; writing a frontend module's dms.frontend.ts, dms.server.ts (server routes, auth hooks, route rules, backend proxies) or dms.frontend.build.ts; declaring engines["@antelopejs/dms-frontend"]; deploying the frontend server behind a reverse proxy; or debugging a refused range, a missing secret, a 404 from the proxy or a stale workspace.
icon: i-lucide-app-window
category: tooling
tags: [frontend, cli, renderer, vue, inertia, ssr, deployment, dms-module]
---

# dms-frontend

`@antelopejs/dms-frontend` is the DMS frontend: the `ajs dms` CLI, the Vue renderer it generates, and the SDK frontend modules register through. The full guide is at <https://dms.antelopejs.com/docs/frontend>; this skill holds what the `--help` output does not say. For starting and stopping the backend and frontend of a project, use the **dms-dev** skill; for the dashboard pages and blocks, **dms-pages**.

## Look things up first

- `ajs dms <command> --help` gives every option, its variable and examples.
- `ajs dms help environment` lists every variable the CLI and the server read.
- `ajs dms workspaces` shows which workspaces exist, keyed on what, and how big.

## Rules that bite

- **One workspace per backend URL**, under `~/.antelopejs/dms-frontend/<sha256>/`. `dev` without `-b` keys its own on the project directory instead, so `dev` then `build -b` builds a second workspace. `start` serves the workspace `build` made for the same URL, user and home directory.
- **Secrets.** `build` and `start` need the same `DMS_SESSION_SECRET` (32+ characters); `dev` generates one only when it is unset. `build` takes `DMS_BOOTSTRAP_SECRET` explicitly, never from `.antelope/dms-dev.json`. A build without it still succeeds, but loses the modules' private options, the manifest's backend proxies and the e-mail and OAuth secrets: `start` then warns that e-mail renders and OAuth sign-in will be refused.
- **`.env`** is read from the current directory only (shell, then `.env.local`, then `.env`). A `DMS_API_BASE_URL` in `.env` turns off backend discovery for `dev`. `clean` never reads it.
- **`prepare` never fails** without `--strict`: it warns and exits 0. Use `--strict` where the types are required.
- **Exit codes:** 0 success, 1 failure, 2 usage error, 130 Ctrl+C.

## Writing a frontend module

- The entry is `dms.frontend.ts`, default-exporting `{ componentPrefix?, setup(sdk) }`. `setup` only registers: under `dev` it runs again on every layer change.
- Set a `componentPrefix`; the backend names a component by its full name (`CustomComponent("AcmeBanner")`). Replace another module's component with `registerComponent(fullName, c, { prefix: false })`.
- Nothing is auto-imported unless `dms.frontend.build.ts` declares it; `app/build/` never is.
- Server routes, auth hooks, route rules and backend proxies go in `dms.server.ts` (`defineDmsServer` from `#dms/server`). It is trusted Node.js code: import what it uses, never `.vue` files or `dms.frontend.ts`.
- The browser reaches the backend only through declared prefixes (`registerBackendProxy`, `backendProxies`, `DMS_BACKEND_PROXIES`). An undeclared backend route answers `404`; in development, the `x-dms-route-owner` header names who answered.
- Declare `engines["@antelopejs/dms-frontend"]`, capped below the next minor (`">=0.6.0 <0.7.0"`); a range that excludes the installed loader stops `dev`, `build` and `verify-source`.
- Give every server-rendered `useDmsAsyncData` / `useDmsFetch` call a key, and replace `data` instead of mutating it (shallow by default).
- Check a module with `ajs dms verify-source` from the project: no backend needed.

## Where the details are

| Task | Page |
| --- | --- |
| Compatibility with DMS releases | `/docs/frontend/introduction#compatibility` |
| One command in depth | `/docs/frontend/cli/<command>` |
| Variables and secrets | `/docs/frontend/configuration` |
| Module files and SDK | `/docs/frontend/frontend-modules/anatomy`, then `server-routes`, `sessions-and-sign-in`, `route-rules`, `emails` |
| SSR, navigation, data, icons | `/docs/frontend/rendering/model`, `navigation`, `data-loading`, `icons` |
| Production, proxy, security | `/docs/frontend/deployment/production`, `routing-and-proxy`, `public-endpoints`, `security` |
| Upgrading a module to 0.6 | `/docs/frontend/upgrading/migrating-to-0-6` |
| An error message | `/docs/frontend/troubleshooting` |

The same pages ship in this package's repository under `docs/`.

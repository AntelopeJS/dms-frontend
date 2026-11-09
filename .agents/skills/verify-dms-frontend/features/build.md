---
covers:
  - src/asset-roots.ts
  - src/commands/build-action.ts
  - src/commands/build.ts
  - src/commands/dev-action.ts
  - src/commands/dev.ts
  - src/commands/start-action.ts
  - src/commands/start.ts
  - src/derived-outputs.ts
  - src/entry-weight.ts
  - src/internal/vite-manifest.ts
  - src/server-process.ts
  - src/vite-output.ts
  - templates/vue/package.json
  - templates/vue/pnpm-workspace.yaml
  - templates/vue/tsconfig.json
  - templates/vue/vite.config.ts
  - templates/vue/vite.server.config.ts
docs:
  - docs/3.cli/2.dev.md
  - docs/3.cli/3.build.md
  - docs/3.cli/4.start.md
  - docs/7.deployment/1.production.md
---

# build

The production path of the CLI: `build` into a workspace, `start` serving it against a backend, and `dev` serving the project with a backend on the same machine.

## Sub-features

- `build-output`: the steps in order, the warnings, the client entry report computed independently from the recorded weight, the summary and next step; the bundles, the pre-compressed `.br` and `.gz` copies (present from 1 KiB, identical when decompressed), no secret in `generated-server-options.json`, files readable by others, a workspace the caller names created with the default permissions; `start --workspace` and `DMS_WORKSPACE_DIR` serve it and write nothing into it; a second build installs nothing; `DMS_ENTRY_WEIGHT_WARNING` between two module sizes warns only about the larger; `--force` runs the install again and repairs a removed link; `0` turns the warnings off.
- `build-arguments`: `DMS_ENTRY_WEIGHT_WARNING` that is no size (`abc`, `-1`, `NaN`, `12KB`) fails before any work; a missing project.
- `build-failure`: a component that does not compile stops the build with exit 1 and names the file in the module, with line and column; `--verbose` streams the step.
- `build-interrupt`: SIGINT during a build exits 130 and says how long it ran.
- `start-ready`: the ready block (header, duration, Local, Backend, Workspace, Secrets, hint), the Routing summary, SIGINT exits 130 with the stop line, the ready report to `POST /dms/frontend/ready` (secret header, module names and versions, own version).
- `start-ready-report-retries`: the report repeats after 2 s then 4 s while the backend answers 503, ends on 401 and 404, and reaches a backend that starts later.
- `start-addresses-and-ports`: 0.0.0.0 by default (every LAN address accepts), `HOST=127.0.0.1` shuts the LAN out, a busy port stops the server even when the other process listens on loopback only, `PORT`, `-p` over `PORT`, `PORT` from `./.env`, nothing written into the workspace.
- `start-secrets-and-environment`: warnings for the two secrets it runs without (singular and plural hint), the `Secrets` line, the `NODE_ENV` warning for development and a value from `./.env`, none for production or an empty value.
- `start-quiet`: `-q` and `ANTELOPEJS_QUIET=1` print only the Local url. Fails today: finding below.
- `dev-arguments`: no backend and no project, session secrets of 5, 0 and 31 characters, a bad port and url fail before any work.
- `dev-server`: ready block, loopback only, `x-dms-route-owner` for backend proxies, renderer assets and pages, the `clientUrl` the backend is given, the workspace keyed on the url, the ready report, the warning for a project module the backend does not register, SIGINT exits 130.
- `dev-ports-and-host`: a busy port moves to the next free one and the warning names both, `HOST=0.0.0.0` opens the LAN.
- `dev-port-zero`: `-p 0` is not reported as a busy port.
- `dev-cookie-secure`: the session cookie `POST /auth/login` sets on `ajs dms dev` has no `Secure` with `DMS_COOKIE_SECURE` unset or `false`, and has it with `true`.
- `dev-backend-down`: the cached manifest stands in with a warning, `--offline` and `DMS_OFFLINE` use it without asking, a 401 and a url that never served a manifest fail.
- `dev-discovery`: `.antelope/dev.json` of the enclosing project (found from a subfolder), the workspace keyed on the project and kept when the backend changes port, `DMS_API_BASE_URL` in `./.env` ends discovery, a stale, malformed or api-less registry fails with its message, the first file found decides.
- `dev-public-files`: a file added to a module's `public/` is served at once, and not any more once removed.
- `build-entry-weight-default`: with no threshold set, a module adding about 70 KB of Brotli to the client entry is warned about with its size and the 50 KB threshold, and one adding about 25 KB is not.
- `build-locale-error`: a message vue-i18n cannot compile stops the build with exit 1 and names the file and the count; `--verbose` adds the key and the message to write instead.
- `build-locale-error-names-the-key`: finding AntelopeJS/dms-frontend#281: the default output lacks the key line the page shows. Fails today.
- `build-access-redirect`: a page visit the backend refuses with a typed 403 goes to the path a module registered for its code (document, Inertia, plain-text and JSON bodies, first registration wins); a refused destination, another origin, an unregistered code and a request that is no page visit show the error page.
- `dev-secret-precedence`: with `DMS_HTML_RENDER_SECRET` set and the manifest publishing another value, `dev` takes the variable (the docs disagree: AntelopeJS/dms-frontend#282).

## How to get to it (user POV)

- `ajs dms build`, then `ajs dms start -b <backend>`; `ajs dms dev` inside a project started with `ajs project dev`.

## Driving it with dms-control

```bash
dms-control journey "$RUN" build
```

The journeys build into a workspace of their own and start `start` and `dev` against a backend written in the journey; the run's own dashboard is not used.

## Not driven

| Behaviour | Why |
|---|---|
| What a `dev` edit reloads, except `public/` (Vite HMR of `.vue` files, locale catalogs, `app.config.ts`, `dms.frontend.ts`, `dms.frontend.build.ts`, `dms.server.ts`, e-mail templates, layer directories) | Each row is a reload observed in a browser or through the Vite socket. The file mirroring behind them is covered by unit tests in `tests/`; no journey edits those files while a dev server runs. |
| `dev` restarting when the backend's module set changes | The backend would have to change its modules under a running dev server; the fake backend cannot make `settling` and a module-store change visible the way the real one does. |
| The `x-dms-route-owner` value `module:<id>` | Needs a module that declares server routes in the project; the fixture module has none. The feature `routing` drives module routes. |
| The terminal form of the Vite warnings (`→ Run with --verbose to list them`) and of the progress lines | The journeys capture pipes. The terminal rendering is covered by `script` only for `workspaces`, not for a build. |
| `ANTELOPEJS_LAUNCH_ENV` as `-e` (4.configuration) | The fixture project has one environment, so a run cannot tell the variable from the option; `-e` itself is driven in `build-arguments`. |
| `DMS_API_PUBLIC_BASE_URL` in `envOverrides` (7.deployment/1.production, 3.cli/4.start) | It is a variable of the DMS demo template's `envOverrides`, not of this package; the mechanism, `start` evaluating the project again with its own environment, is driven in `start-secrets-and-environment`. |
| A module's private options warnings (`<module>: private option x is not set`), `DMS_PRIVATE_OPTIONS`, the module-set drift warning | Needs a module that publishes private options in a build; the playground has none. |
| `ajs project build -e production` then `ajs dms build` in a container image, read-only file systems, the TLS reverse proxy, scaling and caching headers of `docs/7.deployment/1.production.md` | Deployment practice, not CLI behaviour; the headers are the static-files and proxy features'. `start` writing nothing is driven. |
| Another user reading the build | Needs a second operating system user; the permission bits are asserted instead. |

## Gotchas

- Known finding, kept as a failing journey: `start-quiet` (AntelopeJS/dms-frontend#278: the Routing block survives `-q`).
- The build installs from the registry: a package published minutes ago can make the install fail with a 404 until the registry catches up.
- A build step's Vite warnings are listed in full when piped; the page's `Run with --verbose` hint is the terminal form.
- Files copied from `public/` keep the mode of their source in the workspace; the check on readable files leaves them out.
- The fixture project for the failing build and the `public/` journey lives inside the run's checkout (`root/packages/dms/build-fixtures`) so the core module resolves.

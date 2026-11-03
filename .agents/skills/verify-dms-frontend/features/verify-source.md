---
covers:
  - src/commands/verify-source-action.ts
  - src/commands/verify-source.ts
  - src/typecheck-output.ts
  - src/verify-source-build.ts
  - src/verify-source-client-bundle.ts
  - src/verify-source-result.ts
  - src/verify-source-runner.ts
  - src/verify-source-sources.ts
  - templates/vue/server/module-testing.mjs
  - templates/vue/typecheck-loader.mjs
docs:
  - docs/3.cli/8.verify-source.md
  - docs/5.frontend-modules/10.testing.md
---

# verify-source

`ajs dms verify-source`: builds and type-checks unpublished frontend modules on top of the DMS core layer of the `@antelopejs/dms` the project installs, in a temporary workspace, with no backend.

## Sub-features

- `verify-source-usage`: refusals before anything is installed, each in under a second: `--layer` / `-l` on a module that is not the core layer (exit 2 and the `-m` command), no `@antelopejs/dms` from the working directory (exit 2 and the command that adds it), a missing path, a folder without `package.json`, no module in the project, a module whose `engines` excludes this release (exit 1; the selected module shown as `./frontend-vue` from a project, `.` from the module, `./frontend-vue` with `-m`), `--local-package` without `name=path`; the temporary directory stays empty.
- `verify-source-pass`: a module that builds and type-checks: the header counts two modules, the core layer's version, every step once (materialize, install, type declarations, server modules, e-mail bundle, client bundle, SSR bundle, type check), then the client bundle check, the e-mail contracts (8 templates, JS under 256 KB), the server module check, and `Verified 2 modules`; exit 0, the temporary workspace removed.
- `verify-source-failures`: a type error exits 1 and names `./frontend-vue/app/components/Callout.vue:2:7  TS2322` with the code frame and the fix, not the workspace copy; `--verbose` streams more; a template that does not compile fails the client and SSR bundles and names the component; a `dms.server.ts` that imports `dms.frontend.ts` fails; the temporary workspace is removed after each failure.
- `verify-source-local-package`: `-m` twice verifies three modules; a dependency the registry does not know fails the run unless `--local-package name=path` binds a local build.
- `verify-source-email-limit`: a module whose e-mail template adds about 90 KB keeps the bundle near 215 KB and passes; one adding about 140 KB fails naming a size above 256 KB and the limit.

## How to get to it (user POV)

- In a module's CI, next to its unit tests: `ajs dms verify-source`.

## Driving it with dms-control

```bash
dms-control journey "$RUN" verify-source
```

The journeys write small modules inside the run's checkout (`root/packages/dms/verify-source-fixtures`) so Node finds the `@antelopejs/dms` the run installed, and give each run a `TMPDIR` of its own.

## Not driven

| Behaviour | Why |
|---|---|
| `--layer` verifying an unpublished core layer with `--local-package @antelopejs/dms=<path>` | Needs a second, unpublished DMS checkout built next to the run's. Only the refusal of a `--layer` that is not a core layer is driven. |
| The e-mail check that the bundle holds no browser-only module, and its 256 KB limit failing | Needs a module whose e-mail template imports a browser-only module; the limit passing (under 256 KB) is asserted. |
| `pnpm test:real-source` with `DMS_LAYER_SOURCE` and `DMS_MODULE_SOURCES` (docs/3.cli/8.verify-source.md note, docs/5.frontend-modules/10.testing.md) | It is a test command of the repository, not a CLI path. |
| `frontendLayerAliases`, `frontendLayerTypePaths`, `resolveFrontendLayers` and `serveModuleRoutes` of the testing page | Library exports used from a module's own test suite; covered by `tests/layer-aliases.test.ts` and `tests/server-modules*.test.ts`, with no journey. |
| That the run does not compress the client assets | The workspace is removed when the run ends, so there is nothing left to look at. |

## Gotchas

- A `-m` folder that has a `package.json` but no `dms.frontend.ts` is verified without complaint, although the hint of the path errors says the folder contains `dms.frontend.ts`.
- Node's own compile cache can appear in `TMPDIR`; the checks ignore `node-compile-cache`.
- A run takes 30 to 50 seconds; the four journeys run eleven of them.

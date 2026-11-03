---
covers:
  - templates/vue/public-options.ts
  - templates/vue/server/public-options.mjs
  - src/app-configs.ts
  - src/dev-modules.ts
  - src/discovery.ts
  - src/internal/locale-catalogs.ts
  - src/internal/manifest-decoder.ts
  - src/internal/own-release.ts
  - src/layer-aliases.ts
  - src/layer-watch.ts
  - src/layers.ts
  - src/locale-files.ts
  - src/manifest-secrets.ts
  - src/manifest.ts
  - src/module-set.ts
  - src/private-values.ts
  - src/project-modules-child.ts
  - src/project-modules.ts
  - src/renderer-range.ts
  - templates/vue/app-config-stub.mjs
  - templates/vue/frontend-build-loader.ts
  - templates/vue/frontend-build.ts
  - templates/vue/frontend-module.ts
  - templates/vue/layer-app-config.ts
docs:
  - docs/5.frontend-modules/1.anatomy.md
  - docs/5.frontend-modules/2.app-config.md
  - docs/5.frontend-modules/3.components.md
  - docs/5.frontend-modules/4.auto-imports.md
  - docs/5.frontend-modules/8.supported-releases.md
---

# Modules

A frontend module is a package that registers pages, components, plugins, server routes and an app config. The loader reads each module in place and writes its public options into every page by module id.

## Sub-features

- `the-modules-public-options-reach-every-page-and-no-secret-does`: `dms-public-options` is keyed by module id and holds the manifest's public values (the dashboard's origin as `clientBaseUrl` and as `baseURL`, the homepage, the token lifetime, no OAuth provider, the playground module's own option), and none of the run's six secrets appears in a rendered page or the client entry.

## How to get to it (user POV)

- Every page: `View source`, `script#dms-public-options`.

## Driving it with dms-control

```bash
dms-control journey "$RUN" modules
```

## Gotchas

- Anatomy, supported releases, components, auto-imports and the app config merge are about authoring a module. The run serves two modules (the DMS frontend and the playground's), so only what they publish is observable.

## Not driven

- A module whose `engines` range excludes the running release, `declares an unreadable range`, a prerelease check and the warning for a module with no range (8.supported-releases): they need a second project with a module of that range; the CLI is driven by `cli`, `build` and `verify-source`, which use no such module.
- The merge order of app configs (5.2): modules merge by manifest priority and layers by name, but no value of the merge is printed in a page the journeys reach.
- Dev-time app config updates in place (5.2): development only.
- Component and plugin registration, `{ clientOnly: true }` plugins, auto-import resolution and the `#dms/*` aliases (5.1, 5.3, 5.4): the DMS's own frontend module uses them, which the whole run exercises, but no check can tell one registration from another through the dashboard.
- The `dms.email.ts` and `dms.frontend.build.ts` entries (5.1): the e-mail entry is driven by `emails`; the build entry runs in the build `build` drives.
- Installation (2): `pnpm add` and `ajs dms prepare` on a fresh project; the run uses the playground already installed.
- Introduction (1): the CLI list is driven by `cli`; the two-process development flow is development only.

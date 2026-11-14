<a href="https://github.com/AntelopeJS/dms"><img data-illustration src="./.github/readme/strip.svg" width="100%" alt="DMS FRONTEND: part of AntelopeJS DMS, the open-source back office. A glowing button reads Star AntelopeJS DMS."></a>

<div align="center">

# `@antelopejs/dms-frontend`

<a href="https://www.npmjs.com/package/@antelopejs/dms-frontend"><img alt="npm" src="https://img.shields.io/npm/v/@antelopejs/dms-frontend?style=for-the-badge&labelColor=000000&color=000000" data-illustration></a> <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/@antelopejs/dms-frontend?style=for-the-badge&labelColor=000000&color=000000" data-illustration></a> <a href="https://discord.gg/g4pFt6eXqu"><img alt="Discord" src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" data-illustration></a> <a href="https://dms.antelopejs.com/docs/frontend"><img alt="Documentation" src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" data-illustration></a> <a href="https://github.com/AntelopeJS/dms"><img data-illustration alt="Star AntelopeJS DMS" src="https://img.shields.io/github/stars/AntelopeJS/dms?label=Star%20AntelopeJS%20DMS&style=for-the-badge&labelColor=000000&color=000000&logo=github"></a>

**The frontend of the AntelopeJS DMS: the `ajs dms` CLI, the Vue renderer and the frontend-module SDK.**

[Documentation](https://dms.antelopejs.com/docs/frontend) · [All modules](https://github.com/AntelopeJS/dms#modules)

</div>

![The browser talks to the frontend server, which renders pages, answers module routes and proxies declared backend prefixes to the DMS backend, while the development and prepare commands fetch the manifest and write a workspace](./docs/images/architecture.svg "illustration")

## What it does

- Reads the frontend modules of an AntelopeJS project, materializes them into a generated workspace, builds it, and runs the frontend server.
- Renders the dashboard with Vue, Vite, Inertia and server-side rendering.
- Keeps the backend token on the server. The browser only holds a sealed, `HttpOnly` session cookie, and the server adds the session's token to each request it proxies to a declared backend prefix.
- Lets a module extend the dashboard with pages, components and plugins (`dms.frontend.ts`), server routes (`dms.server.ts`) and build-time declarations (`dms.frontend.build.ts`).
- Serves development with hot reload, and production with pre-compressed assets.

## Install

Add the package next to `@antelopejs/core`. The core `ajs` command runs it as `ajs dms`.

```bash
pnpm add -D @antelopejs/core @antelopejs/dms-frontend
```

## Quick start

In a DMS project started with `ajs project dev -w`, serve the dashboard with hot reload:

```bash
pnpm exec ajs dms dev
```

For production, build from the project root, without the backend. Then start the frontend server with `DMS_SESSION_SECRET` and the backend's secrets set:

```bash
pnpm exec ajs dms build
pnpm exec ajs dms start -b https://api.example.com -p 3001
```

`ajs dms --help` lists every command, and `ajs dms help environment` lists every environment variable.

## Compatibility

<!-- antelopejs-docs-compat:start -->

| Package            | Supported | Tested with |
| ------------------ | --------- | ----------- |
| `@antelopejs/core` | `~1.23.0` | `1.23.0`    |

<!-- antelopejs-docs-compat:end -->

Each DMS release declares the renderer releases it runs on in `engines["@antelopejs/dms-frontend"]` of its frontend module's `package.json`. The `ajs dms` CLI refuses to build a module whose range excludes the installed renderer. To find the renderer releases that match a DMS release, read that `engines` range in the installed DMS frontend module, as the [Compatibility](https://dms.antelopejs.com/docs/frontend/introduction#compatibility) section of the introduction explains. The renderer needs the `@antelopejs/core` range in the table above, and the `engines` field of its `package.json` sets the Node.js versions it runs on.

## Documentation

- [Introduction](https://dms.antelopejs.com/docs/frontend/introduction) and [Installation](https://dms.antelopejs.com/docs/frontend/installation)
- [CLI reference](https://dms.antelopejs.com/docs/frontend/cli/overview)
- [Configuration and environment variables](https://dms.antelopejs.com/docs/frontend/configuration)
- [Writing a frontend module](https://dms.antelopejs.com/docs/frontend/frontend-modules/anatomy)
- [Rendering model](https://dms.antelopejs.com/docs/frontend/rendering/model)
- [Deploying to production](https://dms.antelopejs.com/docs/frontend/deployment/production)
- [Troubleshooting](https://dms.antelopejs.com/docs/frontend/troubleshooting)

The guide's sources live in [`docs/`](./docs). The package also ships the `dms-frontend` skill for coding agents in [`skills/`](./skills), declared under `antelopeJs.skills`.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

```bash
pnpm install
pnpm build
pnpm lint          # oxlint, interface ranges, the docs reference check and the source checks
pnpm typecheck
pnpm test
```

`pnpm docs:reference` regenerates the environment-variable table of `docs/4.configuration.md` from the list `ajs dms help environment` prints. `pnpm lint` fails when the table is stale.

## Part of AntelopeJS DMS

This package is the frontend of [AntelopeJS DMS](https://github.com/AntelopeJS/dms), the open-source back office. It renders the dashboard that every module adds its pages to, behind the same sign-in and roles.

<!-- antelopejs-dms-modules:start -->

| Module                                                           | What it adds                                                                             |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| [`dms-builder`](https://github.com/AntelopeJS/dms-builder)       | Edit pages, tables and data sources by clicking, as TypeScript that compiles             |
| [`dms-ai`](https://github.com/AntelopeJS/dms-ai)                 | An assistant chat in the dashboard, on your own Claude Code or Codex                     |
| [`dms-database`](https://github.com/AntelopeJS/dms-database)     | Schemas, relation diagrams, a data browser and a query console                           |
| [`dms-api`](https://github.com/AntelopeJS/dms-api)               | API health, request logs, per-route statistics and a request tester                      |
| [`dms-automation`](https://github.com/AntelopeJS/dms-automation) | Node-graph automations on schedules, webhooks and DMS events, with a trace for every run |
| [`dms-mailing`](https://github.com/AntelopeJS/dms-mailing)       | E-mail templates in a block editor, versions, a send log and delivery metrics            |
| [`dms-lang`](https://github.com/AntelopeJS/dms-lang)             | Translation coverage, a translation matrix and a translation queue                       |
| [`dms-media`](https://github.com/AntelopeJS/dms-media)           | A media library with folders, per-folder permissions, image sizes and light editing      |
| [`dms-saas`](https://github.com/AntelopeJS/dms-saas)             | Self-service sign-up, plans that gate features, and Stripe billing                       |
| [`dms-marketing`](https://github.com/AntelopeJS/dms-marketing)   | Traffic, conversion funnels with A/B splits and click heatmaps, without cookies          |
| [`dms-frontend`](https://github.com/AntelopeJS/dms-frontend)     | The `ajs dms` CLI, the Vue renderer and the SDK every frontend module builds on          |

<!-- antelopejs-dms-modules:end -->

## License

[Apache-2.0](./LICENSE)

## Requirements

<!-- antelopejs-docs-node:start -->

This package requires Node.js `>=20.19.0`.
<!-- antelopejs-docs-node:end -->

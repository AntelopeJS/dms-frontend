# @antelopejs/dms-frontend

<div align="center">
<a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge&labelColor=000000"></a>
<a href="https://discord.gg/sjK28QHrA7"><img src="https://img.shields.io/badge/Discord-18181B?logo=discord&style=for-the-badge&color=000000" alt="Discord"></a>
<a href="https://dms.antelopejs.com/docs/frontend"><img src="https://img.shields.io/badge/Docs-18181B?style=for-the-badge&color=000000" alt="Documentation"></a>
</div>

The frontend of the AntelopeJS DMS. The backend serves a frontend manifest and
the matching frontend modules; the `ajs dms` CLI materializes them into a
generated workspace, builds it, and runs its Node frontend server. The `vue`
renderer (Vue 3, Vite, Inertia and server-side rendering) is the one shipped
today, and frontend modules extend it through `dms.frontend.ts`,
`dms.server.ts` and `dms.frontend.build.ts`.

**Documentation: [dms.antelopejs.com/docs/frontend](https://dms.antelopejs.com/docs/frontend)**

## Install

```bash
pnpm add -D @antelopejs/core @antelopejs/dms-frontend
```

The package installs the `ajs-dms` executable, which the core `ajs` command
runs as `ajs dms`. It needs Node.js 20.12 or later and `@antelopejs/core`
1.13.2 or later.

## Use

```bash
ajs dms dev                                   # inside a project started with ajs project dev
ajs dms build -b https://dms.example.com      # with DMS_SESSION_SECRET and DMS_BOOTSTRAP_SECRET set
ajs dms start -b https://dms.example.com -p 3001
ajs dms --help
ajs dms help environment
```

## Guides

- [Introduction and compatibility](https://dms.antelopejs.com/docs/frontend/introduction)
- [Installation](https://dms.antelopejs.com/docs/frontend/installation)
- [CLI reference](https://dms.antelopejs.com/docs/frontend/cli/overview)
- [Configuration and environment variables](https://dms.antelopejs.com/docs/frontend/configuration)
- [Writing a frontend module](https://dms.antelopejs.com/docs/frontend/frontend-modules/anatomy)
- [Rendering model](https://dms.antelopejs.com/docs/frontend/rendering/model)
- [Deploying to production](https://dms.antelopejs.com/docs/frontend/deployment/production)
- [Migrating to 0.6.0](https://dms.antelopejs.com/docs/frontend/upgrading/migrating-to-0-6)
- [Troubleshooting](https://dms.antelopejs.com/docs/frontend/troubleshooting)

The sources of these pages live in [`docs/`](./docs). The package also ships a
`dms-frontend` skill for coding agents, under [`skills/`](./skills).

## Development

```bash
pnpm install
pnpm build
pnpm lint          # oxlint, oxfmt, interface ranges and the docs reference check
pnpm typecheck
pnpm test
```

`pnpm docs:reference` regenerates the environment-variable table of
`docs/4.configuration.md` from the list `ajs dms help environment` prints;
`pnpm lint` fails when the table is stale.

## License

[Apache-2.0](./LICENSE)

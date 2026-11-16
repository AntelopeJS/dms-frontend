# dms-frontend

## Layout

| Path        | What it is                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `src`       | The `ajs-dms` CLI and the loader, compiled to `dist`                                           |
| `templates` | The Vue renderer, shipped as source and compiled in the consumer's project, not here           |
| `skills`    | The agent skill shipped in the package (`antelopeJs.skills`)                                   |
| `docs`      | The user docs. `pnpm docs:reference` writes the environment table in `docs/4.configuration.md` |
| `tests`     | The `node:test` suite                                                                          |
| `e2e`       | The verify skill's journeys, run as a Playwright suite by `pnpm e2e`                           |

oxlint skips `templates/**/*.{ts,tsx,vue}` and knip skips `templates/**`: they resolve against the consumer's dependencies. Their `.mjs` files stay linted.

## Versioning

- `@antelopejs/core` is a peer dependency (`~1.24.0`).
- `@vueuse/core` stays pinned at `14.4.0`: `templates/vue/patches/@vueuse__core@14.4.0.patch` is applied to that exact version.
- `@nuxt/ui` stays pinned at `4.10.0` in `templates/vue/package.json`: `templates/vue/pnpm-workspace.yaml` applies `patches/@nuxt__ui@4.10.0.patch` to that exact version.
- `pnpm lint` runs `docs:reference:check`, which fails when the environment table in `docs/4.configuration.md` differs from `ajs dms help environment`.

## Tests

`pnpm test` runs every `tests/*.test.{ts,mts}` file except the CLI suites (`tests/cli.test.ts`, `tests/cli-*.test.{ts,mts}`), with no build.

The CLI and output tests compare Unicode symbols, so `pnpm test`, `pnpm test:cli` and `pnpm run checks` fail under `TERM=dumb`. Prefix them with `TERM=xterm-256color` in a shell that sets `TERM=dumb`.

`pnpm run checks` does not cover:

- The CLI suites. CI runs them in its `cli` job. Run `pnpm test:cli`: it builds `dist`, then runs them with `DMS_PREBUILT=1`. `cli-startup`, `cli-signals` and `cli-framed-output` always spawn `dist/index.js`, so build before you run one of them on its own; `cli-sandbox` falls back to the sources without `DMS_PREBUILT`.
- `pnpm test:real-source`. `tsconfig.json` covers only `src`, so this is the only check that type-checks the templates (vue-tsc) and builds them against a real DMS layer. Run it when a change touches `templates/` or `verify-source`: `DMS_LAYER_SOURCE=<dms checkout>/packages/dms/frontend-vue DMS_MODULE_SOURCES='["<module root>"]' pnpm test:real-source`, adding `DMS_LOCAL_PACKAGES='{"@antelopejs/dms":"<dms checkout>/packages/dms"}'` for an unpublished `@antelopejs/dms`.
- The journeys. CI runs the `@smoke` set in its `e2e` job on a pull request into `main`, a push to `next` and a manual run, and every journey each night. Run `DMS_PLAYGROUND=<dms checkout>/packages/dms/playground pnpm e2e --grep @smoke` against a dms checkout that is installed and built.
- Dead files and exports. `pnpm knip` checks dependencies only; `pnpm knip:all` also reports unused files and exports, which need a human to confirm.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

CI runs `pnpm run checks` in full on every pull request and reports what failed. The commit hook formats and lints the staged files. Locally, run only the fast check for what you touched:

- `pnpm run typecheck` after you change types or signatures.
- `pnpm exec oxlint <files>` and `pnpm exec oxfmt <files>` on the files you changed.
- One test file, not the suite. In a module that tests with `ajs module test`: `pnpm run build`, then `pnpm exec ajs module test . -f dist/<path>.test.js`.

Prove a change works with the verification skill in [`.agents/skills/verify-dms-frontend/SKILL.md`](.agents/skills/verify-dms-frontend/SKILL.md) before you call it done.

### Comments

Say it in code: a constraint in a type, a lint rule or a test, a public item's contract in TSDoc. Other comments are lint directives naming their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, and license or tool directives. A reason states what the code does now.

### Tests

Each test names the wrong implementation it fails on, or is deleted. Drive behaviour through the public interface. An invariant over many files is a lint rule.

### Review

No tool checks these:

- A type guard checks the nested elements and values it claims.
- A no-upward import rule rejects same-tier peers; probe it with an import.
- A finding only an evasion or a patched internal can trigger goes under Attention and never blocks.

### Suppressions

`guardrails.suppressions.json` caps lint directives, `@ts-expect-error`, `SAFETY:` comments and rules a lint config turns off. Over a cap, fix the code or remove another suppression of that kind; only the operator raises a number. After removing suppressions, run `pnpm run suppressions:update` and commit the file.

<!-- antelopejs-guardrails:end -->

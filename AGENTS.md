# dms-frontend

## Layout

| Path        | What it is                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `src`       | The `ajs-dms` CLI and the loader, compiled to `dist`                                           |
| `templates` | The Vue renderer, shipped as source and compiled in the consumer's project, not here           |
| `skills`    | The agent skill shipped in the package (`antelopeJs.skills`)                                   |
| `docs`      | The user docs. `pnpm docs:reference` writes the environment table in `docs/4.configuration.md` |
| `tests`     | The `node:test` suite                                                                          |

oxlint skips `templates/**/*.{ts,tsx,vue}` and knip skips `templates/**`: they resolve against the consumer's dependencies. Their `.mjs` files stay linted.

## Versioning

- `@antelopejs/core` is a peer dependency (`>=1.16.0 <2`).
- `@vueuse/core` stays pinned at `14.4.0`: `templates/vue/patches/@vueuse__core@14.4.0.patch` is applied to that exact version.
- `@nuxt/ui` stays pinned at `4.10.0` in `templates/vue/package.json`: `templates/vue/pnpm-workspace.yaml` applies `patches/@nuxt__ui@4.10.0.patch` to that exact version.
- `pnpm lint` runs `docs:reference:check`, which fails when the environment table in `docs/4.configuration.md` differs from `ajs dms help environment`.

## Tests

`pnpm test` builds `dist`, then runs `tests/*.test.ts` and `tests/*.test.mts` with `DMS_PREBUILT=1`. The CLI tests spawn `dist/index.js`, so build before you run one of them on its own.

The CLI and output tests compare Unicode symbols, so `pnpm test`, and with it `pnpm run checks`, fails under `TERM=dumb`. Run `TERM=xterm-256color pnpm run checks` in a shell that sets `TERM=dumb`.

`pnpm run checks` does not cover:

- `pnpm test:real-source`. `tsconfig.json` covers only `src`, so this is the only check that type-checks the templates (vue-tsc) and builds them against a real DMS layer. Run it when a change touches `templates/` or `verify-source`: `DMS_LAYER_SOURCE=<dms checkout>/packages/dms/frontend-vue DMS_MODULE_SOURCES='["<module root>"]' pnpm test:real-source`, adding `DMS_LOCAL_PACKAGES='{"@antelopejs/dms":"<dms checkout>/packages/dms"}'` for an unpublished `@antelopejs/dms`.
- Dead files and exports. `pnpm knip` checks dependencies only; `pnpm knip:all` also reports unused files and exports, which need a human to confirm.

<!-- antelopejs-guardrails:start -->
<!-- Managed by @antelopejs/tooling-configs. `antelopejs-sync` rewrites everything between these markers; write repository-specific guidance outside them. -->

## Guardrails

Finish every change with `pnpm run checks`. It runs typecheck, lint, format, knip, tests, size, ratchet, and sync, and prints only what failed. The change is done when it prints no failure.

The tools enforce most rules, listed in the table at the end. The sections below hold the rules no tool checks.

### Comments

Say it in code. A constraint belongs in a type, a lint rule, or a test. A public item's contract belongs in TSDoc (`/** */`) on that item. The only other comments are lint directives that name their rules, `@ts-expect-error <reason>`, `SAFETY: <reason>` above a type assertion, `/*!` license headers, and bundler or formatter directives.

### Tests

Hold every test you write or keep to this checklist:

- Name the wrong implementation this test fails on. A test with no answer is deleted, not kept.
- No test reads the file it tests. Drive the behaviour through the public interface.
- An invariant over many files is a lint rule, not a test.

### Debt

`guardrails.ratchet.json` records the lint findings and oversize files this repository already had. Its numbers only go down. After you remove debt, run `pnpm run ratchet:update` and commit the lowered file. A rule listed there is off for `oxlint`. The ratchet counts it instead, and the pre-commit hook rejects it on every line you add.

### What enforces what

| Rule                                                                           | Enforced by                               |
| ------------------------------------------------------------------------------ | ----------------------------------------- |
| Formatting                                                                     | oxfmt                                     |
| Lint findings are errors; no rule warns                                        | oxlint preset                             |
| Comments are TSDoc, directives, or `SAFETY:` only                              | `antelopejs/no-comments`                  |
| Every test asserts                                                             | `antelopejs/require-assertion`            |
| Tests read no files outside fixtures, helpers, locales                         | `antelopejs/no-fs-read-in-tests`          |
| No assertion that restates a constant                                          | `antelopejs/no-constant-value-assertion`  |
| No test whose only check is "is a function"                                    | `antelopejs/no-typeof-function-only-test` |
| Params ≤ 5, function ≤ 120 lines, file ≤ 500 lines, depth ≤ 4, complexity ≤ 20 | `eslint/max-*`, `eslint/complexity`       |
| Files ≤ 20,000 bytes, tests included                                           | `antelopejs-check-size` (pre-commit)      |
| Existing debt only shrinks                                                     | `antelopejs-ratchet`                      |
| Types check                                                                    | `tsc` (pre-push)                          |
| No dead files, exports, or dependencies                                        | knip                                      |
| Managed files match the pack                                                   | `antelopejs-sync --check`                 |
| A test names the wrong implementation it catches                               | review; no tool                           |

<!-- antelopejs-guardrails:end -->

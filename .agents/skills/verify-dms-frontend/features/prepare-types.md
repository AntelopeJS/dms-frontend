---
covers:
  - src/commands/prepare-types-action.ts
  - src/commands/prepare-types.ts
  - src/prepare-types-*.ts
  - templates/vue/vue-components.mjs
  - templates/vue/workspace-writes.mjs
  - src/internal/json.ts
docs:
  - docs/3.cli/9.prepare-types.md
---

# prepare-types

`ajs dms prepare-types --out <dir>`: writes a `tsconfig.json` and the auto-import and `.vue` declarations of frontend modules to a directory that stays, every path pointing at the module sources, so a module's `tsconfig.json` extends it for type-aware lint. It starts no backend and builds no bundle.

## Sub-features

- `prepare-types-on-a-real-layout`: a project whose module holds three components (one exporting a `Row` type that `app/rows.ts` imports from `./components/Table.vue`), depends on `sortablejs` with only `@types/sortablejs` for its types, and has an install of its own holding `vue`. The run exits 0, writes a `<component>.vue.d.ts` for each component under `vue-declarations/`, and adds no file to the project outside `--out` (no `node_modules/.vue-global-types` in the module, #348). The project, its copy of `@antelopejs/dms` included, is then renamed, and `tsc -p .dms-types --noEmit` with the TypeScript the output installed exits 0 (#350, #351, #362).
- `prepare-types-through-a-symlink`: `--out` is a symlink to a directory three levels deeper; the run exits 0 and every component has its declaration in the real directory (#352).

## How to get to it (user POV)

- In a module's repository, before a type-aware lint: `ajs dms prepare-types --out .dms-types`, then `"extends": "./.dms-types/tsconfig.json"` in the module's `tsconfig.json`.

## Driving it with dms-control

```bash
dms-control journey "$RUN" prepare-types
```

The journeys write their projects in the run's scratch folder, each with its own copy of the `@antelopejs/dms` this checkout installs, so the project moves together with every module source, as the docs require. Each run installs the modules' dependencies from the registry.

## Not driven

| Behaviour | Why |
|---|---|
| A `.ts` file on another drive than the sources, whose declaration `vue-tsc` must not write beside it (#348) | Needs a second drive; `tests/prepare-types-declarations.test.ts` covers it on Windows CI. |
| `--out` refusals (not empty and not written by the command, a `node_modules` segment, another drive, a module source) | Usage errors covered by `tests/prepare-types-output.test.ts`. |
| `-l` and `--local-package` for an unpublished core layer | Needs a second, unpublished DMS checkout built next to the run's. |

## Gotchas

- A run installs about 450 packages and runs `vue-tsc` over the core layer: 10 to 20 seconds with a warm store.
- A project whose core layer lies outside it, such as one inside a dms checkout, does not type-check once moved: its declarations mirror paths from the deepest folder holding every source, which is then above the project.

import { cpSync, existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { observe, runCli, scratch } from "./cli-run.mjs";
import { writeProject } from "./verify-source-fixtures.mjs";
import { cliOnly } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const TIMEOUT_MS = 600_000;
const OUT = ".dms-types";
const COMPONENTS = ["app/components/Callout.vue", "app/components/Table.vue", "app/components/nested/Badge.vue"];

const TABLE = `<script lang="ts">
export interface Row {
  id: number;
  label: string;
}
</script>

<script setup lang="ts">
defineProps<{ rows: Row[] }>();
</script>

<template>
  <ul><li v-for="row in rows" :key="row.id">{{ row.label }}</li></ul>
</template>
`;

const BADGE = `<script setup lang="ts">
defineProps<{ count: number }>();
</script>

<template>
  <span>{{ count }}</span>
</template>
`;

const ROWS = `import type { Row } from "./components/Table.vue";
import Sortable from "sortablejs";

export const first: Row = { id: 1, label: "first" };
export const sorting: Sortable.Options = { animation: 150 };
`;

/**
 * A project whose module holds three components, one of which exports a type that a `.ts` file imports, depends on a
 * package that ships no types and its `@types` package, and has an install of its own that holds `vue`. The project
 * holds its own copy of the `@antelopejs/dms` this checkout installs, so it moves together with every module source.
 *
 * @param {Context} ctx The journey
 * @param {string} name A folder name
 * @returns {{ project: string, module: string }} The project and its module root
 */
function realProject(ctx, name) {
  const fixture = writeProject(scratch(ctx, name), {
    dependencies: { sortablejs: "1.15.7", "@types/sortablejs": "1.15.9" },
    files: { "app/components/Table.vue": TABLE, "app/components/nested/Badge.vue": BADGE, "app/rows.ts": ROWS },
  });
  cpSync(realpathSync(join(ctx.state.renderer ?? "", "node_modules", "@antelopejs", "dms")), join(fixture.project, "node_modules", "@antelopejs", "dms"), { recursive: true });
  mkdirSync(join(fixture.module, "node_modules"), { recursive: true });
  symlinkSync(realpathSync(join(ctx.state.renderer ?? "", "node_modules", "vue")), join(fixture.module, "node_modules", "vue"), "dir");
  return fixture;
}

/**
 * @param {string} dir A directory
 * @param {string} [skip] A top-level entry left out
 * @returns {string[]} Every path under it, symlinks not followed
 */
function tree(dir, skip) {
  const paths = readdirSync(dir, { recursive: true }).map(String);
  return (skip ? paths.filter((path) => path !== skip && !path.startsWith(`${skip}/`)) : paths).sort();
}

/**
 * @param {string} out A directory `prepare-types` wrote
 * @returns {string[]} The components of {@link COMPONENTS} with no `<component>.vue.d.ts` under `vue-declarations/`
 */
function undeclared(out) {
  const declarations = join(out, "vue-declarations");
  const declared = existsSync(declarations) ? tree(declarations) : [];
  return COMPONENTS.filter((component) => !declared.some((path) => path.endsWith(`${component}.d.ts`)));
}

/**
 * @param {Context} ctx The journey
 * @param {string} cwd Where to run
 * @param {string} out The `--out` argument
 * @returns {Promise<import("./cli-run.mjs").CliResult>} The run
 */
function prepareTypes(ctx, cwd, out) {
  return runCli(ctx, ["prepare-types", "--out", out], { cwd, home: ctx.state.home, timeoutMs: TIMEOUT_MS });
}

/**
 * @param {Context} ctx The journey
 * @param {string} project A project folder
 * @returns {Promise<import("./cli-run.mjs").CliResult>} `tsc -p .dms-types` in it, with the TypeScript the output installed
 */
function typeCheck(ctx, project) {
  const tsc = join(project, OUT, "node_modules", "typescript", "bin", "tsc");
  return runCli(ctx, ["-p", OUT, "--noEmit"], { cwd: project, home: ctx.state.home, script: tsc, timeoutMs: TIMEOUT_MS });
}

export const journeys = [
  {
    id: "prepare-types-on-a-real-layout",
    title: "prepare-types declares every component of a module with its own install and an @types-only dependency, writes nothing outside --out, and the project still type-checks once moved",
    entryPoint: "ajs dms prepare-types --out .dms-types from a project folder holding frontend-vue, then tsc -p .dms-types after a move",
    ...cliOnly,
    async run(/** @type {Context} */ ctx) {
      const fixture = realProject(ctx, "prepare-types");
      const before = tree(fixture.project, OUT);
      const run = await prepareTypes(ctx, fixture.project, OUT);
      observe(
        ctx,
        "a run",
        { code: run.code, stderr: run.stderr },
        [
          ctx.equal("exit 0", run.code, 0),
          ctx.equal("a declaration for every component", undeclared(join(fixture.project, OUT)), []),
          ctx.equal("no file written outside --out", tree(fixture.project, OUT), before),
        ],
        { critical: true },
      );
      const tsconfig = join(fixture.project, OUT, "tsconfig.json");
      let missing = 0;
      const reader = setInterval(() => {
        if (!existsSync(tsconfig)) missing += 1;
      }, 10);
      const rerun = await prepareTypes(ctx, fixture.project, OUT).finally(() => clearInterval(reader));
      observe(ctx, "a second run beside a reader", { code: rerun.code, stderr: rerun.stderr }, [
        ctx.equal("exit 0", rerun.code, 0),
        ctx.equal("the reader never finds --out without its tsconfig.json", missing, 0),
        ctx.equal("no file written outside --out", tree(fixture.project, OUT), before),
      ]);
      const moved = `${fixture.project}-moved`;
      rmSync(moved, { recursive: true, force: true });
      renameSync(fixture.project, moved);
      const check = await typeCheck(ctx, moved);
      observe(ctx, "the moved project", { code: check.code, stdout: check.stdout, stderr: check.stderr }, [ctx.equal("tsc -p .dms-types exits 0 after the move", [check.code, check.stdout.split("\n").slice(0, 20)], [0, [""]])]);
    },
  },
  {
    id: "prepare-types-through-a-symlink",
    title: "prepare-types declares every component when --out is a symlink whose real directory sits at another depth",
    entryPoint: "ajs dms prepare-types --out <symlink to a deeper directory>",
    ...cliOnly,
    async run(/** @type {Context} */ ctx) {
      const fixture = realProject(ctx, "prepare-types-link");
      const real = join(scratch(ctx, "prepare-types-link-out"), "one", "two", "out");
      mkdirSync(real, { recursive: true });
      symlinkSync(real, join(fixture.project, OUT), "dir");
      const run = await prepareTypes(ctx, fixture.project, OUT);
      observe(ctx, "a run through the symlink", { code: run.code, stderr: run.stderr }, [
        ctx.equal("exit 0", run.code, 0),
        ctx.equal("a declaration for every component, in the real directory", undeclared(real), []),
      ]);
    },
  },
];

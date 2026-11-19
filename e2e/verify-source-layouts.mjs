import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cliEnvironment, observe, runCli, scratch } from "./cli-run.mjs";
import { projectFolder, writeProject } from "./verify-source-fixtures.mjs";
import { leftovers } from "./verify-source-run.mjs";
import { noBrowser } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const TIMEOUT_MS = 600_000;
const TARBALL_VERSION = "tarball-2.0.0";

const VERSION_COMPONENT = `<script setup lang="ts">
import { version } from "fx-lib";

const pinned: "${TARBALL_VERSION}" = version;
</script>

<template>
  <span>{{ pinned }}</span>
</template>
`;

/**
 * @param {Context} ctx The journey
 * @param {string} cwd Where to run
 * @param {string[]} args The command and its arguments
 * @returns {{ code: number | null, output: string }} How it ended
 */
function tool(ctx, cwd, args) {
  const [program, ...rest] = args;
  const result = spawnSync(program, rest, { cwd, env: cliEnvironment(ctx, ctx.state.home), encoding: "utf8", timeout: 300_000 });
  return { code: result.status, output: `${result.stdout}${result.stderr}`.slice(-2000) };
}

/**
 * A pnpm workspace root whose `pnpm.overrides` pins `fx-lib`, which no registry has, to a tarball beside it, installed
 * with pnpm, with `frontend-vue` as its member. The module holds a symlink back to the root and a `..b` folder with a
 * `node_modules`, and the root is reached through a symlink.
 *
 * @param {Context} ctx The journey
 * @returns {{ link: string, install: { code: number | null, output: string }, pack: { code: number | null, output: string } }} The symlinked project and how its setup ended
 */
function linkedWorkspace(ctx) {
  const root = projectFolder(ctx, "linked-root");
  const link = join(dirname(root), "linked-link");
  rmSync(root, { recursive: true, force: true });
  rmSync(link, { force: true });
  const library = join(root, "vendor-src", "fx-lib");
  mkdirSync(library, { recursive: true });
  writeFileSync(join(library, "package.json"), JSON.stringify({ name: "fx-lib", version: "2.0.0", type: "module", main: "index.js", types: "index.d.ts" }));
  writeFileSync(join(library, "index.js"), `export const version = "${TARBALL_VERSION}";\n`);
  writeFileSync(join(library, "index.d.ts"), `export declare const version: "${TARBALL_VERSION}";\n`);
  mkdirSync(join(root, "vendor"), { recursive: true });
  const pack = tool(ctx, library, ["npm", "pack", "--pack-destination", join(root, "vendor")]);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "linked-root", private: true, pnpm: { overrides: { "fx-lib": "file:./vendor/fx-lib-2.0.0.tgz" } } }));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - frontend-vue\n");
  const fixture = writeProject(root, {
    dependencies: { "fx-lib": "1.0.0" },
    files: { "app/components/Version.vue": VERSION_COMPONENT, "..b/node_modules/junk/package.json": '{ "name": "junk" }' },
  });
  symlinkSync("..", join(fixture.module, "loop"), "dir");
  const install = tool(ctx, root, ["pnpm", "install", "--ignore-scripts", "--no-frozen-lockfile"]);
  symlinkSync(root, link, "dir");
  return { link, install, pack };
}

export const journeys = [
  {
    id: "verify-source-on-a-linked-workspace-layout",
    title: "verify-source passes on a module reached through a symlink, holding a symlink to its root and a ..b folder, whose workspace root pins a dependency to a tarball with pnpm overrides",
    entryPoint: "ajs dms verify-source from a symlink to a pnpm workspace root holding frontend-vue",
    ...noBrowser,
    async run(/** @type {Context} */ ctx) {
      const layout = linkedWorkspace(ctx);
      observe(ctx, "the workspace is installed", layout, [ctx.equal("npm pack and pnpm install exit 0", [layout.pack.code, layout.install.code], [0, 0])], { critical: true });
      const tmp = scratch(ctx, "tmp");
      const run = await runCli(ctx, ["verify-source"], { cwd: layout.link, home: ctx.state.home, env: { TMPDIR: tmp }, timeoutMs: TIMEOUT_MS });
      const lines = run.stderr.split("\n").filter(Boolean);
      observe(ctx, "a run through the symlink", { code: run.code, stderr: run.stderr }, [
        ctx.equal("exit 0", run.code, 0),
        ctx.holds("the last line says both modules verified", /^Verified 2 modules\b/.test(lines.at(-1) ?? ""), lines.at(-1) ?? ""),
        ctx.equal("no ✖ line: the copy met no ENAMETOOLONG or ELOOP, and the type check read the tarball's version", run.stderr.includes("✖"), false),
        ctx.equal("the temporary workspace is removed", leftovers(tmp), []),
      ]);
    },
  },
];

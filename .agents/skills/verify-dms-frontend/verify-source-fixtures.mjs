/**
 * Small frontend modules and a project folder to verify them from. The project folder lies inside
 * the run's checkout, so Node finds the `@antelopejs/dms` the run installed from it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ENGINES = ">=0.10.0 <0.11.0";

const CALLOUT = `<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <aside>{{ title }}</aside>
</template>
`;

/**
 * @param {string} file A file path
 * @param {string} text Its content
 */
function put(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

/**
 * Writes a frontend module that builds and type-checks.
 *
 * @param {string} dir The module root
 * @param {{ name?: string, engines?: string | null, component?: string, dependencies?: Record<string, string>, entry?: string, files?: Record<string, string> }} [options] Variations
 * @returns {string} The module root
 */
export function writeModule(dir, options = {}) {
  const engines = options.engines === undefined ? ENGINES : options.engines;
  put(
    join(dir, "package.json"),
    JSON.stringify({ name: options.name ?? "fx-frontend-vue", version: "1.0.0", private: true, type: "module", dependencies: options.dependencies, engines: engines ? { "@antelopejs/dms-frontend": engines } : undefined }),
  );
  put(
    join(dir, "dms.frontend.ts"),
    options.entry ??
      `import type { DmsFrontendModule } from "#dms/frontend-module";

const fixture: DmsFrontendModule = {
  setup(sdk) {
    sdk.registerComponent("Callout", () => import("./app/components/Callout.vue"));
  },
};

export default fixture;
`,
  );
  put(join(dir, "app", "components", "Callout.vue"), options.component ?? CALLOUT);
  for (const [relative, text] of Object.entries(options.files ?? {})) put(join(dir, relative), text);
  return dir;
}

/**
 * A project folder holding `frontend-vue`.
 *
 * @param {string} dir The project folder, inside the run's checkout
 * @param {Parameters<typeof writeModule>[1]} [options] Variations of the module
 * @returns {{ project: string, module: string }} The project and its module root
 */
export function writeProject(dir, options) {
  mkdirSync(dir, { recursive: true });
  return { project: dir, module: writeModule(join(dir, "frontend-vue"), options) };
}

/**
 * @param {{ state: { runPlayground: string } }} ctx The journey
 * @param {string} name A folder name
 * @returns {string} A project folder inside the run's checkout, where `@antelopejs/dms` resolves
 */
export function projectFolder(ctx, name) {
  return join(ctx.state.runPlayground, "..", "verify-source-fixtures", name);
}

export const TYPE_ERROR_COMPONENT = `<script setup lang="ts">
const count: number = "not a number";
defineProps<{ title: string }>();
</script>

<template>
  <aside>{{ title }} {{ count }}</aside>
</template>
`;

export const SYNTAX_ERROR_COMPONENT = `<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <aside>{{ title }
</template>
`;

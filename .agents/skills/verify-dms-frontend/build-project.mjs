/**
 * A small AntelopeJS project for `ajs dms build --project`: the DMS core module and one frontend
 * module of the journey's own, inside the run's checkout so the core module resolves.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPONENT = `<script setup lang="ts">
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
 * @param {{ state: { runPlayground: string } }} ctx The journey
 * @param {string} name A folder name
 * @returns {string} A project folder two levels below the DMS package, so `path: "../.."` is that package
 */
export function buildProjectFolder(ctx, name) {
  return join(ctx.state.runPlayground, "..", "build-fixtures", name);
}

/**
 * Writes the project: `antelope.config.ts`, the module `fx` and its frontend.
 *
 * @param {string} dir The project folder
 * @param {{ component?: string, environmentOnly?: boolean, locales?: Record<string, string>, entry?: string, files?: Record<string, string> }} [options] Variations
 * @returns {{ project: string, component: string }} The project and the component file
 */
export function writeBuildProject(dir, options = {}) {
  put(
    join(dir, "antelope.config.ts"),
    `export default {
  name: "fx",
  modules: {
    dms: { source: { type: "local", path: "../.." } },
    fx: { source: { type: "local", path: "./fx" } },
  },
  environments: {
    docs: { modules: {} },
  },
};
`,
  );
  put(join(dir, "package.json"), JSON.stringify({ name: "fx-project", version: "1.0.0", private: true }));
  put(join(dir, "fx", "package.json"), JSON.stringify({ name: "fx", version: "1.0.0", dmsFrontend: "frontend-module.cjs" }));
  put(
    join(dir, "fx", "frontend-module.cjs"),
    `const path = require("node:path");
exports.frontendModule = () => ({
  name: "fx-frontend",
  sourcePath: path.join(__dirname, "frontend-vue"),
  renderer: { name: "vue", version: "3" },
  priority: 100,
  options: {},
});
`,
  );
  put(join(dir, "fx", "frontend-vue", "package.json"), JSON.stringify({ name: "fx-frontend-vue", version: "1.0.0", type: "module", engines: { "@antelopejs/dms-frontend": ">=0.10.0 <0.11.0" } }));
  put(
    join(dir, "fx", "frontend-vue", "dms.frontend.ts"),
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
  const component = join(dir, "fx", "frontend-vue", "app", "components", "Callout.vue");
  put(component, options.component ?? COMPONENT);
  for (const [name, text] of Object.entries(options.files ?? {})) put(join(dir, "fx", "frontend-vue", name), text);
  for (const [name, text] of Object.entries(options.locales ?? {})) put(join(dir, "fx", "frontend-vue", "i18n", "locales", name), text);
  return { project: dir, component };
}

export const BROKEN_COMPONENT = `<script setup lang="ts">
defineProps<{ title: string }>();
</script>

<template>
  <aside>{{ title }
</template>
`;

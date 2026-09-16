import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  // The suite runs from tests/, which the defaults do not cover.
  entry: ["tests/**/*.test.ts"],
  project: ["tests/**/*.ts"],
  // Templates are compiled inside the consumer's project, against its
  // dependency graph -- vite, the Vue plugins, the generated modules. Analysing
  // them here would only report a graph this package does not own.
  ignore: ["templates/**"],
  ignoreDependencies: [
    // Imported by the shipped templates, resolved in the consumer's project.
    "@unhead/vue",
    "@vitejs/plugin-vue",
    "@vue/server-renderer",
    "defu",
    "ofetch",
    "unplugin-auto-import",
    "vue-i18n",
    // Ambient to the figlet import; nothing references the @types package.
    "@types/figlet",
  ],
});

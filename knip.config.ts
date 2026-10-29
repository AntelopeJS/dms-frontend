import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

/** The test files the suite runs from tests/, which knip's defaults do not cover. */
const TEST_SUITE_ENTRIES = ["tests/**/*.test.ts"];

/** Every file of the suite under tests/, helpers and fixtures included. */
const TEST_SUITE_FILES = ["tests/**/*.ts"];

/**
 * Templates are compiled inside the consumer's project, against its
 * dependency graph (vite, the Vue plugins, the generated modules). Analysing
 * them here would only report a graph this package does not own.
 */
const CONSUMER_COMPILED_TEMPLATES = ["templates/**"];

/** Imported by the shipped templates, resolved in the consumer's project. */
const SHIPPED_TEMPLATE_DEPENDENCIES = [
  "@unhead/vue",
  "@vitejs/plugin-vue",
  "@vue/server-renderer",
  "defu",
  "ofetch",
  "unplugin-auto-import",
  "vue-i18n",
];

export default antelopeKnipConfig({
  entry: TEST_SUITE_ENTRIES,
  project: TEST_SUITE_FILES,
  ignore: CONSUMER_COMPILED_TEMPLATES,
  ignoreDependencies: SHIPPED_TEMPLATE_DEPENDENCIES,
});

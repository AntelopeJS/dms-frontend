import { antelopeKnipConfig } from "@antelopejs/tooling-configs/knip";

export default antelopeKnipConfig({
  entry: ["tests/**/*.test.ts"],
  project: ["tests/**/*.ts"],
  ignore: ["templates/**"],
  ignoreDependencies: [
    "@unhead/vue",
    "@vitejs/plugin-vue",
    "@vue/server-renderer",
    "defu",
    "ofetch",
    "unplugin-auto-import",
    "vue-i18n",
  ],
});

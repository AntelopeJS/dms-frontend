import { antelopeFmtPreset } from "@antelopejs/tooling-configs/oxc/fmt";

/** The journeys and their helpers keep the layout they had in the verify skill. */
export default antelopeFmtPreset({
  ignorePatterns: [
    "**/*.md",
    "**/*.vue",
    "e2e/journeys/**",
    "e2e/*.mjs",
    "e2e/control.d.ts",
  ],
});

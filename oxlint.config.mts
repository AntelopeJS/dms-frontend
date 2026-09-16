import { defineConfig } from "oxlint";
import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
} from "@antelopejs/tooling-configs/oxc/lint";

export default defineConfig({
  extends: [
    antelopePreset({
      // Turned on repository-wide with the import-sorting pass, so the
      // reordering lands as one reviewable change everywhere at once.
      importSorting: false,
    }),
  ],
  // The templates are compiled in the consumer's project, against its own
  // dependency graph and its own tsconfig, so the type-aware pass cannot read
  // them here. Their .mjs server files have no such tie and stay linted, which
  // is the coverage Biome had over the auth and SSR entry points.
  ignorePatterns: [
    ...ANTELOPE_IGNORE_PATTERNS,
    "templates/**/*.ts",
    "templates/**/*.tsx",
    "templates/**/*.vue",
  ],
  options: {
    typeAware: true,
    // Ceiling on what oxlint still reports. Most of the drop came from the
    // preset -- 0.0.4 leaves eight anti-slop rules off -- not from repair, so
    // this is a "nothing new" gate rather than a measure of remaining debt. It
    // never goes up. Here rather than in the lint script so a direct oxlint run
    // is held to it too; `lint:fix` opts out with its own `--max-warnings`,
    // since a fix pass is not a gate.
    maxWarnings: 0,
  },
  overrides: [
    {
      files: ["tests/**/*.test.ts", "tests/**/*.test.mts"],
      rules: {
        // A `describe` block is not a function anyone splits, and an integration
        // suite's length is its coverage. These ceilings are about code someone has
        // to hold in their head at once, which is not what a test file asks of a
        // reader.
        "eslint/max-lines": "off",
        "eslint/max-lines-per-function": "off",
        // node:test's describe/it return a promise the runner owns, which the
        // suite is not supposed to await. The rule has an option for known-safe
        // promises, but it does not match a node: builtin.
        "typescript/no-floating-promises": "off",
      },
    },
  ],
});

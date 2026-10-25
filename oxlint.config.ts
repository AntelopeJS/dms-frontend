import { defineConfig } from "oxlint";
import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
} from "@antelopejs/tooling-configs/oxc/lint";

/**
 * The templates are compiled in the consumer's project, against its own
 * dependency graph and tsconfig, so the type-aware pass cannot read them here.
 * Their .mjs server files have no such tie and stay linted.
 */
const CONSUMER_COMPILED_TEMPLATES = [
  "templates/**/*.ts",
  "templates/**/*.tsx",
  "templates/**/*.vue",
];

/**
 * Commands report through the core output module, so what they print keeps
 * its stream, its symbols and the color rules of ajs.
 */
const COMMANDS_USE_CORE_OUTPUT = {
  files: ["src/commands/**/*.ts"],
  rules: {
    "eslint/no-console": "error",
  },
} as const;

/**
 * A `describe` block is not a function anyone splits, and node:test's
 * describe/it return a promise the runner owns, which the suite does not await.
 */
const TEST_SUITES = {
  files: ["tests/**/*.test.ts", "tests/**/*.test.mts"],
  rules: {
    "eslint/max-lines": "off",
    "eslint/max-lines-per-function": "off",
    "typescript/no-floating-promises": "off",
  },
} as const;

export default defineConfig({
  extends: [antelopePreset({ importSorting: false })],
  ignorePatterns: [...ANTELOPE_IGNORE_PATTERNS, ...CONSUMER_COMPILED_TEMPLATES],
  options: {
    typeAware: true,
    maxWarnings: 0,
  },
  overrides: [COMMANDS_USE_CORE_OUTPUT, TEST_SUITES],
});

import { defineConfig } from "oxlint";
import {
  ANTELOPE_IGNORE_PATTERNS,
  antelopePreset,
} from "@antelopejs/tooling-configs/oxc/lint";

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

export default defineConfig({
  extends: [antelopePreset({ importSorting: false })],
  ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
  options: {
    typeAware: true,
    maxWarnings: 0,
  },
  overrides: [COMMANDS_USE_CORE_OUTPUT],
});

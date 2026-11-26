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

/**
 * tsx compiles Vite into CommonJS for a `.ts` file, while Vite's `build()`
 * still imports rolldown as ESM: rolldown loads twice and drops Vite's
 * built-in plugins. A file that builds with Vite is a `.mts` file.
 */
const VITE_BUILDS_FROM_ESM = {
  files: ["scripts/**/*.ts", "tests/**/*.ts"],
  rules: {
    "eslint/no-restricted-imports": [
      "error",
      {
        paths: [
          {
            name: "vite",
            importNames: ["build"],
            message:
              "Build with Vite from a .mts file: under tsx a .ts file loads rolldown twice.",
          },
        ],
      },
    ],
  },
} as const;

export default defineConfig({
  extends: [antelopePreset({ importSorting: false })],
  ignorePatterns: ANTELOPE_IGNORE_PATTERNS,
  options: {
    typeAware: true,
    maxWarnings: 0,
  },
  overrides: [COMMANDS_USE_CORE_OUTPUT, VITE_BUILDS_FROM_ESM],
});

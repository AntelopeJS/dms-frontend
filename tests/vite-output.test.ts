import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { BUILD_STEPS } from "../src/commands/build";
import {
  describeViteFailure,
  VERBOSE_VITE_HINT,
  viteLogLevel,
  ViteWarnings,
} from "../src/vite-output";

const TEMPLATE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/vue",
);

/** What Vite prints on a syntax error, paths already mapped to the source. */
const SYNTAX_ERROR = [
  "✗ Build failed in 2.91s",
  "error during build:",
  "[vite:vue] [vue/compiler-sfc] Unexpected token (10:50)",
  "",
  "frontend-vue/app/components/Callout.vue",
  "8  |  }",
  "9  |  ",
  "10 |  const props = withDefaults(defineProps<Props>(), {{{ broken",
  "   |                                                    ^",
  "file: frontend-vue/app/components/Callout.vue:10:50",
  "    at constructor (/ws/node_modules/@babel/parser/lib/index.js:369:19)",
  "    at TypeScriptParserMixin.raise (/ws/node_modules/@babel/parser/lib/index.js:6622:19)",
];

describe("Vite build failures", () => {
  it("names the source file and keeps the code frame, not the stack", () => {
    const problem = describeViteFailure(SYNTAX_ERROR, "client bundle", false);
    assert.deepEqual(problem, {
      title:
        "Vite could not compile frontend-vue/app/components/Callout.vue:10:50",
      reason: "[vue/compiler-sfc] Unexpected token",
      fixes: ["Fix the file and run ajs dms build again"],
      details: [
        "8  |  }",
        "9  |",
        "10 |  const props = withDefaults(defineProps<Props>(), {{{ broken",
        "   |                                                    ^",
        VERBOSE_VITE_HINT,
      ],
    });
  });

  it("does not point at --verbose in a verbose run", () => {
    const problem = describeViteFailure(SYNTAX_ERROR, "client bundle", true);
    assert.ok(!problem?.details?.includes(VERBOSE_VITE_HINT));
  });

  it("names the step when Vite reports no file", () => {
    const problem = describeViteFailure(
      [
        "error during build:",
        '[vite]: Rollup failed to resolve import "missing" from "frontend-vue/app/pages/a.vue".',
        "This is most likely unintended because it can break your application at runtime.",
        "    at viteLog (/ws/node_modules/vite/dist/node/chunks/config.js:1:1)",
      ],
      "SSR bundle",
      false,
    );
    assert.equal(problem?.title, "Vite could not build the SSR bundle");
    assert.equal(
      problem?.reason,
      '[vite]: Rollup failed to resolve import "missing" from "frontend-vue/app/pages/a.vue".',
    );
    assert.deepEqual(problem?.details, [
      "This is most likely unintended because it can break your application at runtime.",
      VERBOSE_VITE_HINT,
    ]);
  });

  it("leaves a failure Vite did not report to the generic report", () => {
    assert.equal(
      describeViteFailure(
        ["Error: ENOENT: no such file or directory, scandir 'dist/client'"],
        "compressed assets",
        false,
      ),
      undefined,
    );
  });
});

describe("Vite build warnings", () => {
  it("counts warnings, not the lines they span", () => {
    const warnings = new ViteWarnings();
    for (const line of [
      "",
      "(!) Some chunks are larger than 500 kB after minification. Consider:",
      "- Using dynamic import() to code-split the application",
      "[plugin vite:reporter] ",
      "(!) frontend-vue/app/RunFireTree.vue is dynamically imported by a.vue but also statically imported by b.vue",
      "",
      "[plugin vite:reporter] ",
      "(!) frontend-vue/app/RunTrace.vue is dynamically imported by c.vue",
      "[plugin:vite:css] @import must precede all other statements",
    ])
      warnings.read(line);
    assert.equal(warnings.count, 4);
    assert.equal(warnings.lines().length, 7);
    assert.equal(warnings.lines()[2], "[plugin vite:reporter]");
  });

  it("counts output without a known warning opening as one warning", () => {
    const warnings = new ViteWarnings();
    warnings.read('Generated an empty chunk: "vendor".');
    assert.equal(warnings.count, 1);
    assert.equal(new ViteWarnings().count, 0);
  });

  it("runs Vite at warn, or at info in a verbose run", () => {
    assert.equal(viteLogLevel(false), "warn");
    assert.equal(viteLogLevel(true), "info");
  });
});

describe("production build steps", () => {
  const pkg = JSON.parse(
    readFileSync(resolve(TEMPLATE, "package.json"), "utf8"),
  );

  it("run what the workspace build script runs, in its order", () => {
    assert.equal(
      BUILD_STEPS.map((step) => pkg.scripts[step.script]).join(" && "),
      pkg.scripts.build,
    );
  });

  it("let the CLI set the Vite log level of every config", () => {
    for (const config of ["vite.config.ts", "vite.email.config.ts"]) {
      const source = readFileSync(resolve(TEMPLATE, config), "utf8");
      assert.match(source, /process\.env\.DMS_VITE_LOG_LEVEL/);
      assert.match(source, /^ {2}logLevel,$/m);
    }
  });
});

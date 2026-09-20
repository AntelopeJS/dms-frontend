import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import { build, createServer, type DepOptimizationOptions } from "vite";

function templateOptimization(): DepOptimizationOptions {
  const template = readFileSync(
    resolve("templates/vue/vite.config.ts"),
    "utf8",
  );
  const options = template.match(/optimizeDeps: (\{[^}]+\})/);
  assert.ok(
    options,
    "the generated template configures the dependency optimizer",
  );
  return runInNewContext(`(${options[1]})`, {
    optimizedDependencies: [],
    // The template crawls each materialized module at startup. A fixture has
    // none, so the crawl is empty here and the lazy-discovery guarantee below
    // is what this test still exercises.
    optimizerEntries: [],
  }) as DepOptimizationOptions;
}

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

it("optimizes a module's CommonJS dependency discovered after startup", async () => {
  const root = mkdtempSync(join(tmpdir(), "dms-vite-dependency-"));
  const moduleRoot = "frontend-modules/example";
  const dependencyRoot = `${moduleRoot}/node_modules/example-cjs`;
  writeFixture(root, "package.json", '{"type":"module"}');
  writeFixture(
    root,
    "index.html",
    '<script type="module" src="/entry.js"></script>',
  );
  writeFixture(root, "entry.js", 'console.log("shell");');
  writeFixture(
    root,
    `${moduleRoot}/package.json`,
    JSON.stringify({
      name: "example-module",
      dependencies: { "example-cjs": "1.0.0" },
    }),
  );
  writeFixture(
    root,
    `${dependencyRoot}/package.json`,
    JSON.stringify({
      name: "example-cjs",
      version: "1.0.0",
      main: "index.cjs",
    }),
  );
  writeFixture(
    root,
    `${dependencyRoot}/index.cjs`,
    "exports.multiply = (value) => value * 7;",
  );
  const pagePath = `${moduleRoot}/page.js`;
  writeFixture(
    root,
    pagePath,
    'import { multiply } from "example-cjs"; export const answer = multiply(6);',
  );
  const optimizeDeps = templateOptimization();
  const server = await createServer({
    root,
    configFile: false,
    optimizeDeps,
    server: { port: 0, host: "127.0.0.1" },
  });
  try {
    await server.listen();
    const transformed = await server.transformRequest(`/${pagePath}`);
    assert.ok(transformed);
    assert.match(
      transformed.code,
      /\/\.vite\/deps\//,
      "late module imports must use a prebundle, not raw CommonJS",
    );
    assert.equal(
      optimizeDeps.noDiscovery ?? false,
      false,
      "discovery stays on: the startup crawl reaches the modules, not every dependency they pull at run time",
    );
    const optimizedUrl = transformed.code.match(/from "([^"?]+\.js)/)?.[1];
    assert.ok(optimizedUrl);
    await server.transformRequest(optimizedUrl);
    const optimizedModule = await import(
      pathToFileURL(join(root, optimizedUrl)).href
    );
    assert.equal(optimizedModule.default.multiply(6), 42);
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        lib: { entry: join(root, pagePath), formats: ["es"], fileName: "page" },
      },
    });
    const builtModule = await import(
      pathToFileURL(join(root, "dist/page.js")).href
    );
    assert.equal(builtModule.answer, 42);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { it } from "node:test";
import {
  build,
  createServer,
  normalizePath,
  type DepOptimizationOptions,
} from "vite";
import { readText } from "./helpers/files";
import { isText } from "./helpers/guards";

function templateSource(): string {
  return readText(resolve("templates/vue/vite.config.ts"));
}

function templateOptimization(
  optimizerEntries: string[] = [],
): DepOptimizationOptions {
  const template = templateSource();
  const options = template.match(/optimizeDeps: (\{[^}]+\})/);
  assert.ok(
    options,
    "the generated template configures the dependency optimizer",
  );
  return runInNewContext(`(${options[1]})`, {
    optimizedDependencies: [],
    optimizerEntries,
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

it("pre-bundles a module's dependency at startup without naming it", async () => {
  const root = mkdtempSync(join(tmpdir(), "dms-vite-dependency-"));
  const moduleRoot = "frontend-modules/example";
  const dependencyRoot = `${moduleRoot}/node_modules/example-sortable`;
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
      dependencies: { "example-sortable": "1.0.0" },
    }),
  );
  writeFixture(
    root,
    `${dependencyRoot}/package.json`,
    JSON.stringify({ name: "example-sortable", version: "1.0.0" }),
  );
  writeFixture(
    root,
    `${dependencyRoot}/index.js`,
    "exports.sortable = () => true;",
  );
  writeFixture(
    root,
    `${moduleRoot}/app/composables/useList.ts`,
    'import { sortable } from "example-sortable"; export const useList = sortable;',
  );
  const optimizeDeps = templateOptimization([
    normalizePath(resolve(root, moduleRoot, "app/**/*.ts")),
  ]);
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    optimizeDeps,
    server: { port: 0, host: "127.0.0.1" },
  });
  try {
    await server.listen();
    const optimizer = server.environments.client.depsOptimizer;
    assert.ok(optimizer);
    await optimizer.scanProcessing;
    const { discovered, optimized } = optimizer.metadata;
    assert.ok(
      "example-sortable" in discovered || "example-sortable" in optimized,
      "the crawl of the module's sources finds the dependency at startup",
    );
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("names no dependency the DMS dropped for SortableJS", () => {
  const list = templateSource().match(
    /const optimizedDependencies = (\[[^\]]*\])/,
  );
  assert.ok(list, "the template lists the dependencies it pre-bundles");
  const names: unknown = runInNewContext(list[1]);
  assert.ok(
    Array.isArray(names) && names.every(isText),
    "the template lists names",
  );
  assert.ok(names.includes("vue"));
  assert.ok(!names.includes("vuedraggable"));
});

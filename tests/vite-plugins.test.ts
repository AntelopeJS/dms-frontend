import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { build, createServer, loadConfigFromFile, type Plugin } from "vite";
import {
  copyStaticTemplates,
  writeFrontendModuleRegistry,
} from "../src/common";
import { materializeLayers } from "../src/materialize";
import {
  defineDmsFrontendBuild,
  type DmsFrontendBuild,
} from "../templates/vue/frontend-build";
import { vitePlugins } from "../templates/vue/frontend-build-loader";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

type Registered = Parameters<DmsFrontendBuild["registerVitePlugins"]>[0];

const MODULES = [
  { id: "billing", name: "@acme/billing-frontend" },
  { id: "crm" },
];

function declaring(...factories: Registered[]) {
  return defineDmsFrontendBuild((declared) => {
    for (const create of factories) declared.registerVitePlugins(create);
  });
}

function pluginsOf(...setups: ReturnType<typeof declaring>[]): Plugin[] {
  return vitePlugins(
    MODULES,
    setups.map((setup, index) => ({ id: MODULES[index].id, setup })),
  );
}

function project(): string {
  const root = temporaryDirectory("dms-vite-plugins-");
  for (const [path, content] of [
    ["entry.js", 'import { answer } from "./dep.js";\nconsole.log(answer);\n'],
    ["dep.js", "export const answer = 42;\n"],
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function recording(name: string, seen: string[]): Plugin {
  return {
    name,
    enforce: "pre",
    resolveId(id) {
      seen.push(`${name}:${id}`);
      return null;
    },
  };
}

function throwing(): Plugin {
  return {
    name: "boundary",
    enforce: "pre",
    resolveId(id) {
      if (id.endsWith("dep.js")) throw new Error(`forbidden import ${id}`);
      return null;
    },
  };
}

function production(root: string, plugins: Plugin[]) {
  return build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    build: {
      write: false,
      rolldownOptions: { input: join(root, "entry.js") },
    },
  });
}

async function development(root: string, plugins: Plugin[]) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins,
    appType: "custom",
    server: { middlewareMode: true, ws: false },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    await server.transformRequest("/entry.js");
  } finally {
    await server.close();
  }
}

describe("The Vite plugins a module registers", () => {
  it("run in a production build, in module order", async () => {
    const seen: string[] = [];
    const plugins = pluginsOf(
      declaring(() => [recording("first", seen)]),
      declaring(() => [recording("second", seen)]),
    );

    await production(project(), plugins);

    assert.deepEqual(
      plugins.map(({ name }) => name),
      ["first", "second"],
    );
    assert.ok(seen.some((entry) => entry.startsWith("first:")));
    assert.ok(seen.some((entry) => entry.endsWith("dep.js")));
    assert.ok(
      seen.findIndex((entry) => entry.startsWith("second:")) >
        seen.findIndex((entry) => entry.startsWith("first:")),
    );
  });

  it("run in a dev server", async () => {
    const seen: string[] = [];

    await development(
      project(),
      pluginsOf(declaring(() => [recording("boundary", seen)])),
    );

    assert.ok(seen.some((entry) => entry.endsWith("dep.js")));
  });

  it("keep a module's calls in order and leave its plugin objects untouched", () => {
    const original = recording("one", []);
    const hook = original.resolveId;

    const plugins = pluginsOf(
      declaring(
        () => [original],
        () => [recording("two", [])],
      ),
    );

    assert.deepEqual(
      plugins.map(({ name }) => name),
      ["one", "two"],
    );
    assert.equal(original.resolveId, hook);
    assert.notEqual(plugins[0], original);
  });

  it("add nothing for a module without the hook, or whose factory returns nothing", () => {
    const none = defineDmsFrontendBuild((declared) => {
      declared.registerAutoImports(["app/composables"]);
    });

    assert.deepEqual(
      pluginsOf(
        none,
        declaring(() => undefined),
      ),
      [],
    );
  });

  it("fail a production build naming the module when a hook throws", async () => {
    await assert.rejects(
      production(project(), pluginsOf(declaring(() => [throwing()]))),
      (error: Error) => {
        assert.match(
          error.message,
          /Frontend module @acme\/billing-frontend: .*forbidden import/s,
        );
        return true;
      },
    );
  });

  it("fail a dev server request naming the module when a hook throws", async () => {
    await assert.rejects(
      development(project(), pluginsOf(declaring(() => [throwing()]))),
      /Frontend module @acme\/billing-frontend: .*forbidden import/s,
    );
  });

  it("name the module when an async hook given as an object rejects", async () => {
    const plugin: Plugin = {
      name: "slow",
      load: {
        handler: async (id) => {
          if (id.endsWith("dep.js")) throw new Error("rejected load");
          return null;
        },
      },
    };

    await assert.rejects(
      production(project(), pluginsOf(declaring(() => [plugin]))),
      /Frontend module @acme\/billing-frontend: .*rejected load/s,
    );
  });

  it("name the module by its id when the registry gives it no name", () => {
    assert.throws(
      () =>
        pluginsOf(
          declaring(() => []),
          declaring(() => {
            throw new Error("no boundary configured");
          }),
        ),
      /^Error: Frontend module crm: no boundary configured$/,
    );
  });

  it("refuse anything but an array of plugin objects, naming the module", () => {
    const invalid: unknown[] = [
      {},
      "plugin",
      [{ resolveId() {} }],
      [recording("fine", []), null],
      [[recording("nested", [])]],
      null,
    ];

    for (const value of invalid) {
      assert.throws(
        // SAFETY: the value is wrong on purpose, to reach the runtime validation.
        () => pluginsOf(declaring((() => value) as Registered)),
        /Frontend module @acme\/billing-frontend registered Vite plugins that are not valid/,
      );
    }
  });
});

describe("The Vite plugins of a module laid out in the workspace", () => {
  const PROBE = "__dmsVitePluginsProbe";

  it("reach the config Vite loads, through the generated declarations", async () => {
    const module = temporaryDirectory("dms-vite-plugins-module-");
    const layers = [
      {
        path: module,
        name: "@acme/billing-frontend",
        packageName: "@acme/billing-frontend",
        priority: 1,
      },
    ];
    writeFileSync(
      join(module, "package.json"),
      '{"name":"@acme/billing-frontend","version":"1.0.0"}',
    );
    writeFileSync(
      join(module, "dms.frontend.build.ts"),
      [
        'import { defineDmsFrontendBuild } from "#dms/frontend-build";',
        "export default defineDmsFrontendBuild((build) => {",
        `  build.registerVitePlugins(() => [{ name: "probe", enforce: "pre", resolveId(id: string) { Reflect.get(globalThis, "${PROBE}").push(id); return null; } }]);`,
        "});",
        "",
      ].join("\n"),
    );
    const workspace = mkdtempSync(resolve(".vite-plugins-"));
    try {
      copyStaticTemplates(workspace);
      writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
      writeFrontendModuleRegistry(workspace, layers);
      materializeLayers(workspace, layers);
      writeFileSync(
        join(workspace, "probe.config.ts"),
        [
          'import registry from "./generated-frontend-modules.json";',
          'import { vitePlugins } from "./frontend-build-loader";',
          'import { frontendBuilds } from "./frontend-builds.generated";',
          "export default { plugins: vitePlugins(registry.modules, frontendBuilds) };",
          "",
        ].join("\n"),
      );
      const seen: string[] = [];
      Reflect.set(globalThis, PROBE, seen);
      const loaded = await loadConfigFromFile(
        { command: "build", mode: "production" },
        join(workspace, "probe.config.ts"),
        workspace,
        "silent",
      );
      assert.ok(loaded);

      // SAFETY: the probe config above exports `vitePlugins(...)`, an array of plugins.
      await production(project(), loaded.config.plugins as Plugin[]);

      assert.ok(seen.some((id) => id.endsWith("dep.js")));
    } finally {
      Reflect.deleteProperty(globalThis, PROBE);
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

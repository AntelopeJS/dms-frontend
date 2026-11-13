import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  build,
  createServer,
  normalizePath,
  type Plugin,
  type ViteDevServer,
} from "vite";
import { createFrontendModuleRegistry } from "../src/derived-outputs";
import {
  copyStaticTemplates,
  materializeLayers,
  writeFrontendModuleRegistry,
} from "../src/materialize";
import type { ResolvedLayer } from "../src/workspace";
import { rejectBackendSources } from "../templates/vue/backend-boundary.mjs";

const BACKEND = "@antelopejs/dms-fixture";

function put(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

interface Layout {
  backend: string;
  layer: string;
}

/** A backend package with its frontend layer in `frontend-vue`, beside another package. */
function layout(t: TestContext): Layout {
  const root = realpathSync(
    realpathSync.native(mkdtempSync(join(tmpdir(), "dms-boundary-"))),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backend = join(root, "backend");
  const layer = join(backend, "frontend-vue");
  put(backend, "package.json", JSON.stringify({ name: BACKEND }));
  for (const file of ["src/x.ts", "src/x/y.ts", "srcx/api.ts", "dist/src/x.ts"])
    put(backend, file, `export default ${JSON.stringify(file)};\n`);
  put(root, "other/package.json", JSON.stringify({ name: "@fixture/other" }));
  put(root, "other/src/x.ts", 'export default "other";\n');
  put(
    layer,
    "package.json",
    JSON.stringify({ name: `${BACKEND}-frontend-vue`, type: "module" }),
  );
  put(layer, "src/own.ts", 'export default "own";\n');
  put(layer, "worker.ts", 'import x from "../src/x.ts";\npostMessage(x);\n');
  symlinkSync(join(backend, "src"), join(layer, "linked"), "dir");
  return { backend, layer };
}

function answering(specifier: string, id: string, external = false): Plugin {
  return {
    name: "fixture-resolver",
    enforce: "pre",
    resolveId: (source) =>
      source === specifier ? (external ? { id, external } : id) : null,
  };
}

interface Case {
  name: string;
  entry?: string;
  imports?: string;
  extra?: (backend: string) => Plugin[];
  external?: (backend: string) => string[];
  alias?: (backend: string) => Record<string, string>;
  preserveSymlinks?: boolean;
  expected: "boundary" | "built";
}

const CASES: Case[] = [
  {
    name: "a relative import of the backend's src fails",
    imports: "../src/x.ts",
    expected: "boundary",
  },
  {
    name: "a nested file of the backend's src fails",
    imports: "../src/x/y.ts",
    expected: "boundary",
  },
  {
    name: "a src-prefixed sibling builds",
    imports: "../srcx/api.ts",
    expected: "built",
  },
  {
    name: "src under dist builds",
    imports: "../dist/src/x.ts",
    expected: "built",
  },
  {
    name: "a ?raw import of the backend's src fails",
    imports: "../src/x.ts?raw",
    expected: "boundary",
  },
  {
    name: "a resolution with a #hash fails",
    imports: "virtual:hash",
    extra: (backend) => [answering("virtual:hash", `${backend}/src/x.ts#a`)],
    expected: "boundary",
  },
  {
    name: "a resolver answering external fails",
    imports: "virtual:external",
    extra: (backend) => [
      answering("virtual:external", `${backend}/src/x.ts`, true),
    ],
    expected: "boundary",
  },
  {
    name: "an external option matching the resolved id fails",
    imports: "../src/x.ts",
    external: (backend) => [join(backend, "src/x.ts")],
    expected: "boundary",
  },
  {
    name: "an alias into the backend's src fails",
    imports: "#backend/x.ts",
    alias: (backend) => ({ "#backend": join(backend, "src") }),
    expected: "boundary",
  },
  {
    name: "a symlink into the backend's src fails",
    imports: "./linked/x.ts",
    preserveSymlinks: true,
    expected: "boundary",
  },
  {
    name: "another package's src builds",
    imports: "../../other/src/x.ts",
    expected: "built",
  },
  {
    name: "the frontend package's own src builds",
    imports: "./src/own.ts",
    expected: "built",
  },
  {
    name: "a worker importing the backend's src fails",
    entry:
      'export default new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });\n',
    expected: "boundary",
  },
];

function failure(error: Error): string {
  const { message } = error;
  return message.includes("Backend boundary: ")
    ? "boundary"
    : `failed otherwise: ${message}`;
}

async function outcome({ backend, layer }: Layout, check: Case) {
  put(
    layer,
    "entry.ts",
    check.entry ??
      `import value from ${JSON.stringify(check.imports)};\nexport default value;\n`,
  );
  try {
    await build({
      root: layer,
      configFile: false,
      logLevel: "silent",
      plugins: [
        rejectBackendSources([BACKEND]),
        ...(check.extra?.(backend) ?? []),
      ],
      resolve: {
        alias: check.alias?.(backend) ?? {},
        preserveSymlinks: check.preserveSymlinks ?? false,
      },
      build: {
        write: false,
        lib: { entry: join(layer, "entry.ts"), formats: ["es"] },
        rolldownOptions: { external: check.external?.(backend) ?? [] },
      },
    });
    return "built";
  } catch (error) {
    assert.ok(error instanceof Error, "Vite fails with an Error");
    return failure(error);
  }
}

void describe("The backend boundary plugin", () => {
  for (const check of CASES)
    void it(check.name, async (t) => {
      assert.equal(await outcome(layout(t), check), check.expected);
    });

  void it("names the importer and the backend package", async (t) => {
    const { layer } = layout(t);
    put(layer, "entry.ts", 'import x from "../src/x.ts";\nexport default x;\n');
    const built = build({
      root: layer,
      configFile: false,
      logLevel: "silent",
      plugins: [rejectBackendSources([BACKEND])],
      build: {
        write: false,
        lib: { entry: join(layer, "entry.ts"), formats: ["es"] },
      },
    });
    await assert.rejects(built, (error: Error) => {
      assert.ok(
        error.message.includes(
          `Backend boundary: ${normalizePath(join(layer, "entry.ts"))} imports ${normalizePath(join(dirname(layer), "src", "x.ts"))}, which is under the src of ${BACKEND}.`,
        ),
        error.message,
      );
      return true;
    });
  });
});

void describe("A generated workspace", () => {
  function layerOf({ layer }: Layout): ResolvedLayer {
    return {
      path: layer,
      sourcePath: layer,
      packageName: `${BACKEND}-frontend-vue`,
    };
  }

  void it("records the package that ships each module as its backend package", (t) => {
    const fixture = layout(t);
    const registry = createFrontendModuleRegistry(
      join(fixture.backend, "..", "workspace"),
      [layerOf(fixture)],
    );
    assert.deepEqual(
      registry.modules.map((module) => module.backendPackage),
      [BACKEND],
    );
  });

  /**
   * The template's Vite config, on a workspace whose one module is the
   * fixture's layer, loading `file` from that module through the server
   * renderer's module graph.
   */
  async function loadThroughGeneratedConfig(fixture: Layout, file: string) {
    const workspace = realpathSync(mkdtempSync(resolve(".backend-boundary-")));
    let server: ViteDevServer | undefined;
    try {
      copyStaticTemplates(workspace);
      put(
        workspace,
        "node_modules/@nuxt/ui/package.json",
        JSON.stringify({
          name: "@nuxt/ui",
          type: "module",
          exports: { "./vite": "./vite.mjs" },
        }),
      );
      put(
        workspace,
        "node_modules/@nuxt/ui/vite.mjs",
        "export default () => ({ name: 'fixture-nuxt-ui' });\n",
      );
      put(workspace, "package.json", '{"type":"module"}');
      materializeLayers(workspace, [layerOf(fixture)]);
      writeFrontendModuleRegistry(workspace, [layerOf(fixture)]);
      server = await createServer({
        root: workspace,
        configFile: join(workspace, "vite.config.ts"),
        logLevel: "silent",
        appType: "custom",
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, ws: false, watch: null },
      });
      const module = join(
        workspace,
        "frontend-modules",
        "antelopejs__dms-fixture-frontend-vue",
        file,
      );
      return await server.ssrLoadModule(module).then(() => "built", failure);
    } finally {
      await server?.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  void it("fails a module that imports the src of the package that ships it", async (t) => {
    const fixture = layout(t);
    put(
      fixture.layer,
      "app/uses-backend.ts",
      `import x from ${JSON.stringify(join(fixture.backend, "src/x.ts"))};\nexport default x;\n`,
    );
    assert.equal(
      await loadThroughGeneratedConfig(fixture, "app/uses-backend.ts"),
      "boundary",
    );
  });

  void it("loads a module that imports that package's built files", async (t) => {
    const fixture = layout(t);
    put(
      fixture.layer,
      "app/uses-dist.ts",
      `import x from ${JSON.stringify(join(fixture.backend, "dist/src/x.ts"))};\nexport default x;\n`,
    );
    assert.equal(
      await loadThroughGeneratedConfig(fixture, "app/uses-dist.ts"),
      "built",
    );
  });
});

import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { build } from "vite";
import {
  clientCodeSplitting,
  onBuildLog,
} from "../templates/vue/client-chunking.mjs";

interface ManifestChunk {
  file: string;
  isEntry?: boolean;
  imports?: string[];
}

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

/**
 * The shape of the DMS's entry: it imports a registry and a component
 * statically, the registry imports another component, every component is
 * reached through a glob (a module's `dms.frontend.ts`), and pages load
 * components lazily in turn. The components use an installed, side-effect free
 * package (as the UI libraries are), each another subset of its files.
 */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "dms-client-chunking-"));
  roots.push(root);
  write(
    root,
    "node_modules/ui/package.json",
    JSON.stringify({
      name: "ui",
      type: "module",
      sideEffects: false,
      exports: { "./*": "./*.js" },
    }),
  );
  for (const name of ["a", "b", "c", "d"]) {
    write(
      root,
      `node_modules/ui/${name}.js`,
      `export const ${name} = "${name}".repeat(40) + Math.random();\n`,
    );
  }
  const components: Record<string, string[]> = {
    shared: ["a", "b"],
    cell: ["a", "c"],
    one: ["a"],
    two: ["b", "c"],
    three: ["c", "d"],
    four: ["a", "b", "d"],
  };
  const usesRegistry = new Set(["one", "two", "three", "four"]);
  for (const [name, libs] of Object.entries(components)) {
    write(
      root,
      `components/${name}.ts`,
      (usesRegistry.has(name)
        ? `import { registry } from "../registry";\n`
        : "") +
        libs.map((lib) => `import { ${lib} } from "ui/${lib}";\n`).join("") +
        (usesRegistry.has(name) ? `console.log(registry);\n` : "") +
        `export default [${libs.join(", ")}].join();\n`,
    );
  }
  write(
    root,
    "registry.ts",
    `import cell from "./components/cell";\nexport const registry = new Map([["cell", cell]]);\n`,
  );
  const pages: Record<string, string> = {
    home: "one",
    list: "two",
    edit: "three",
  };
  for (const [page, component] of Object.entries(pages)) {
    write(
      root,
      `pages/${page}.ts`,
      `import shared from "../components/shared";\nconsole.log(shared);\n` +
        `export const load = () => import("../components/${component}");\n`,
    );
  }
  write(
    root,
    "main.ts",
    `import shared from "./components/shared";\nimport { registry } from "./registry";\n` +
      `console.log(shared, registry);\n` +
      `Object.assign(globalThis, {\n  components: import.meta.glob("./components/*.ts"),\n  pages: import.meta.glob("./pages/*.ts"),\n});\n`,
  );
  return root;
}

/** Files the entry loads before running: the entry and its static imports. */
async function entryClosure(
  root: string,
  codeSplitting: unknown,
): Promise<{ closure: string[]; files: string[] }> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    build: {
      outDir: join(root, "dist"),
      emptyOutDir: true,
      manifest: true,
      minify: false,
      rolldownOptions: {
        input: join(root, "main.ts"),
        // @ts-expect-error `codeSplitting` is typed as a boolean here
        output: codeSplitting === undefined ? {} : { codeSplitting },
      },
    },
  });
  const manifest = JSON.parse(
    readFileSync(join(root, "dist", ".vite", "manifest.json"), "utf8"),
  ) as Record<string, ManifestChunk>;
  const entry = Object.keys(manifest).find((key) => manifest[key]?.isEntry);
  assert.ok(entry, "the build has an entry");
  const seen = new Set<string>();
  const visit = (key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    for (const next of manifest[key]?.imports ?? []) visit(next);
  };
  visit(entry);
  return {
    closure: [...seen].map((key) => manifest[key]?.file ?? key),
    files: Object.values(manifest).map((chunk) => chunk.file),
  };
}

describe("client code splitting", () => {
  it("keeps the entry's static imports in one file, where Rolldown's own splitting preloads several", async () => {
    const without = await entryClosure(fixture(), undefined);
    assert.ok(
      without.closure.length > 1,
      `the fixture no longer shows the default's common chunks (${without.closure.length} file)`,
    );
    const { closure, files } = await entryClosure(
      fixture(),
      clientCodeSplitting,
    );
    assert.equal(closure.length, 1, closure.join(", "));
    assert.ok(files.length > closure.length, "components are separate chunks");
  });

  it("is applied to the browser bundle only", () => {
    const config = readFileSync(
      new URL("../templates/vue/vite.config.ts", import.meta.url),
      "utf8",
    );
    const client = config.slice(config.indexOf("environments: {"));
    assert.match(
      client,
      /client:\s*\{\s*build:\s*\{\s*rolldownOptions:\s*\{\s*output:\s*\{\s*codeSplitting: clientCodeSplitting/,
    );
    assert.equal(config.match(/codeSplitting/g)?.length, 1);
  });
});

describe("onBuildLog", () => {
  const log = (ids: string[]) => ({ code: "INEFFECTIVE_DYNAMIC_IMPORT", ids });

  function run(entry: { code: string; ids?: string[] }): boolean {
    let forwarded = false;
    onBuildLog("warn", entry, () => {
      forwarded = true;
    });
    return forwarded;
  }

  it("drops the notice for a module's catch-all glob", () => {
    assert.equal(
      run(
        log([
          "/ws/frontend-modules/acme__dms-frontend-vue/dms.frontend.ts",
          "/ws/layers/ui/StatusPill.vue",
        ]),
      ),
      false,
    );
  });

  it("keeps it for a dynamic import written anywhere else", () => {
    assert.equal(
      run(log(["/ws/frontend-modules/acme__shop/app/pages/Cart.vue"])),
      true,
    );
  });

  it("keeps every other notice", () => {
    assert.equal(run({ code: "CIRCULAR_DEPENDENCY" }), true);
  });
});

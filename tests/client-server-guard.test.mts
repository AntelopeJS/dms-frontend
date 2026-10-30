import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { build } from "vite";
import {
  isServerSource,
  rejectServerSourcesInClient,
} from "../templates/vue/client-server-guard.mjs";
import { readText, listTree } from "./helpers/files";

const SECRET_MARKER = "server-only-secret-marker";

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

/** A workspace whose single module has a server/ directory and a dms.server.ts. */
function createWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "dms-client-server-guard-"));
  const moduleRoot = join(root, "frontend-modules", "shop");
  writeFixture(
    moduleRoot,
    "server/secret.ts",
    `export const secret = "${SECRET_MARKER}";\n`,
  );
  writeFixture(
    moduleRoot,
    "dms.server.ts",
    `import { secret } from "./server/secret";\nexport default { secret };\n`,
  );
  writeFixture(moduleRoot, "app/util.ts", "export const util = 1;\n");
  return { root, moduleRoot };
}

async function buildClient(
  root: string,
  moduleRoot: string,
  entry: string,
  ssr = false,
): Promise<void> {
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [rejectServerSourcesInClient([moduleRoot])],
    resolve: { alias: { "#shop": moduleRoot } },
    build: {
      outDir: join(root, "dist"),
      emptyOutDir: true,
      write: true,
      ssr: ssr ? entry : false,
      rolldownOptions: ssr ? undefined : { input: entry },
    },
  });
}

function builtJavascript(root: string): string {
  return listTree(join(root, "dist"))
    .filter((file) => /\.m?js$/.test(file))
    .map((file) => readText(join(root, "dist", file)))
    .join("\n");
}

describe("server code in the client bundle", () => {
  const workspaces: string[] = [];
  after(() => {
    for (const root of workspaces)
      rmSync(root, { recursive: true, force: true });
  });

  function workspace(): { root: string; moduleRoot: string } {
    const created = createWorkspace();
    workspaces.push(created.root);
    return created;
  }

  it("rejects a static import of a module's server/ file", async () => {
    const { root, moduleRoot } = workspace();
    writeFixture(
      root,
      "main.ts",
      `import { secret } from "#shop/server/secret";\nconsole.log(secret);\n`,
    );
    await assert.rejects(
      buildClient(root, moduleRoot, join(root, "main.ts")),
      /Server code in the client bundle: .*server\/secret\.ts/,
    );
  });

  it("rejects a static import of a dms.server.ts", async () => {
    const { root, moduleRoot } = workspace();
    writeFixture(
      root,
      "main.ts",
      `import server from "./frontend-modules/shop/dms.server";\nconsole.log(server);\n`,
    );
    await assert.rejects(
      buildClient(root, moduleRoot, join(root, "main.ts")),
      /Server code in the client bundle: .*dms\.server\.ts/,
    );
  });

  it("builds client code that imports no server code", async () => {
    const { root, moduleRoot } = workspace();
    writeFixture(
      root,
      "main.ts",
      `import { util } from "#shop/app/util";\nconsole.log(util);\n`,
    );
    await buildClient(root, moduleRoot, join(root, "main.ts"));
    assert.doesNotMatch(builtJavascript(root), new RegExp(SECRET_MARKER));
  });

  it("leaves an SSR build that imports server code alone", async () => {
    const { root, moduleRoot } = workspace();
    writeFixture(
      root,
      "entry.ts",
      `import server from "./frontend-modules/shop/dms.server";\nexport default server;\n`,
    );
    await buildClient(root, moduleRoot, join(root, "entry.ts"), true);
    assert.match(builtJavascript(root), new RegExp(SECRET_MARKER));
  });
});

describe("isServerSource", () => {
  const moduleRoot = "/workspace/frontend-modules/shop";

  it("matches a module's server entry and its server/ files", () => {
    assert.equal(
      isServerSource(`${moduleRoot}/dms.server.ts`, [moduleRoot]),
      true,
    );
    assert.equal(
      isServerSource(`${moduleRoot}/layers/base/server/token.ts?import`, [
        moduleRoot,
      ]),
      true,
    );
  });

  it("leaves client files, packages and other directories alone", () => {
    for (const id of [
      `${moduleRoot}/app/pages/server.vue`,
      `${moduleRoot}/app/servers/list.ts`,
      `${moduleRoot}/node_modules/pkg/server/index.js`,
      "/workspace/node_modules/@vue/server-renderer/index.mjs",
      "/workspace/server/inertia.mjs",
      "\0virtual:server/x",
    ])
      assert.equal(isServerSource(id, [moduleRoot]), false, id);
  });
});

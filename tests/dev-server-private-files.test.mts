import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { createServer as createViteServer } from "vite";
import {
  DEV_FS_DENY,
  denyPrivateFiles,
} from "../templates/vue/server/dev-private-files.mjs";

const SECRET = "dev-server-private-secret";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

describe("private files the development server refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-dev-private-files-"));
  const previousCwd = process.cwd();
  const previousDev = process.env.DMS_DEV;
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backend = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"message":"Not found"}');
  });
  let frontend: Server | undefined;
  let base = "";

  before(async () => {
    process.env.DMS_API_BASE_URL = await listen(backend);
    writeFixture(
      root,
      "vite.config.mjs",
      "export default { logLevel: 'silent', server: { watch: null, ws: false } };",
    );
    writeFixture(
      root,
      "generated-server-options.json",
      JSON.stringify({ modules: { shop: { apiKey: SECRET } } }),
    );
    writeFixture(
      root,
      ".manifest-cache.json",
      JSON.stringify({ manifest: { privateOptions: SECRET } }),
    );
    writeFixture(
      root,
      "frontend-modules/shop/dms.server.ts",
      `export const secret = "${SECRET}";\n`,
    );
    writeFixture(
      root,
      "frontend-modules/shop/server/token.ts",
      `export const token = "${SECRET}";\n`,
    );
    writeFixture(
      root,
      "frontend-modules/shop/layers/base/server/sign.ts",
      `export const sign = "${SECRET}";\n`,
    );
    writeFixture(
      root,
      "frontend-modules/shop/layers/base/app/util.ts",
      "export const util = 1;\n",
    );
    process.env.DMS_DEV = "true";
    process.chdir(root);
    const runtime = (await import(
      pathToFileURL(join(previousCwd, "templates", "vue", "server.mjs")).href
    )) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    base = await listen(frontend);
  });

  after(() => {
    process.chdir(previousCwd);
    process.env.DMS_DEV = previousDev;
    process.env.DMS_API_BASE_URL = previousBackend;
    frontend?.close();
    backend.close();
    rmSync(root, { recursive: true, force: true });
  });

  const privatePaths = [
    "/generated-server-options.json",
    "/generated-server-options.json?raw",
    "/generated-server-options.json?import",
    "/generated-server-options.json?url",
    "/generated-server-options.json?import&raw",
    "/generated-server-options%2Ejson",
    "/.manifest-cache.json",
    "/.manifest-cache.json?raw",
    "/.manifest-cache.json?import",
    "/frontend-modules/shop/dms.server.ts",
    "/frontend-modules/shop/dms.server.ts?raw",
    "/frontend-modules/shop/server/token.ts",
    "/frontend-modules/shop/server/token.ts?import",
    "/frontend-modules/shop/layers/base/server/sign.ts",
    "/frontend-modules/shop/layers/base/server/sign.ts?raw",
    "/frontend-modules/shop/layers/base/server/sign.ts?import&raw",
    "/frontend-modules/shop/layers/base/../base/server/sign.ts",
    "/@id/frontend-modules/shop/server/token.ts",
  ];

  for (const path of privatePaths)
    it(`refuses ${path}`, async () => {
      const response = await fetch(`${base}${path}`);
      const body = await response.text();
      assert.equal(response.status, 403, body);
      assert.doesNotMatch(body, new RegExp(SECRET));
    });

  it("refuses them under /@fs/ too", async () => {
    for (const file of [
      "generated-server-options.json",
      ".manifest-cache.json",
      "frontend-modules/shop/layers/base/server/sign.ts",
    ]) {
      const response = await fetch(`${base}/@fs${join(root, file)}?raw`);
      const body = await response.text();
      assert.equal(response.status, 403, file);
      assert.doesNotMatch(body, new RegExp(SECRET));
    }
  });

  it("still serves a module's client code", async () => {
    const response = await fetch(
      `${base}/frontend-modules/shop/layers/base/app/util.ts`,
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
    assert.equal(response.headers.get("x-dms-route-owner"), "renderer");
  });

  it("names the owner of what no module declares: a page, or a 404", async () => {
    const page = await fetch(`${base}/api/items`, { method: "HEAD" });
    assert.equal(page.headers.get("x-dms-route-owner"), "page");
    const write = await fetch(`${base}/api/items`, { method: "POST" });
    assert.equal(write.status, 404);
    assert.equal(write.headers.get("x-dms-route-owner"), "not-found");
    await write.body?.cancel();
  });

  it("still loads a module's server code for the server, never for the client", async () => {
    const vite = await createViteServer({
      root,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      plugins: [denyPrivateFiles()],
      server: {
        middlewareMode: true,
        watch: null,
        ws: false,
        fs: { deny: DEV_FS_DENY },
      },
    });
    try {
      const entry = await vite.ssrLoadModule(
        "/frontend-modules/shop/dms.server.ts",
      );
      const handler = await vite.ssrLoadModule(
        "/frontend-modules/shop/layers/base/server/sign.ts",
      );
      assert.equal(entry.secret, SECRET);
      assert.equal(handler.sign, SECRET);
      for (const url of [
        "/frontend-modules/shop/layers/base/server/sign.ts",
        "/generated-server-options.json?import&raw",
      ])
        await assert.rejects(
          vite.transformRequest(url),
          /is private to the server|Denied ID/,
          url,
        );
    } finally {
      await vite.close();
    }
  });
});

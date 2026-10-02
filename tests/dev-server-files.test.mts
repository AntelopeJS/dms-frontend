import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const UNREAD_COUNT_PATH = "/settings/user/notifications/unread-count";
const MEDIA_PATH = "/media/asset-1/photo.webp";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

describe("files the development server serves", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-dev-server-files-"));
  const previousCwd = process.cwd();
  const previousDev = process.env.DMS_DEV;
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backendPaths: string[] = [];
  const backend = createServer((request, response) => {
    backendPaths.push(request.url ?? "");
    if (request.url === MEDIA_PATH) {
      response.writeHead(200, { "content-type": "image/webp" });
      response.end("backend media");
      return;
    }
    const found = request.url === UNREAD_COUNT_PATH;
    response.writeHead(found ? 200 : 404, {
      "content-type": "application/json",
    });
    response.end(found ? '{"unreadCount":7}' : '{"message":"Not found"}');
  });
  let frontend: Server | undefined;
  let base = "";

  before(async () => {
    process.env.DMS_API_BASE_URL = await listen(backend);
    // The real development server: Vite in middleware mode, rooted in a
    // directory of its own, without the watcher and HMR socket that would keep
    // the test process alive.
    writeFileSync(
      join(root, "vite.config.mjs"),
      "export default { logLevel: 'silent', server: { watch: null, ws: false } };",
    );
    writeFileSync(join(root, "probe.ts"), "export const probe = 1;\n");
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

  it("serves Vite's modules without asking the backend first", async () => {
    backendPaths.length = 0;
    for (const path of ["/@vite/client", "/probe.ts"]) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(
        response.headers.get("content-type") ?? "",
        /javascript/,
        path,
      );
    }
    assert.deepEqual(backendPaths, []);
  });

  it("still serves a file the frontend does not have from the backend", async () => {
    backendPaths.length = 0;
    const response = await fetch(`${base}${MEDIA_PATH}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "backend media");
    assert.deepEqual(backendPaths, [MEDIA_PATH]);
  });

  it("still asks the backend first for a path without an extension", async () => {
    backendPaths.length = 0;
    const response = await fetch(`${base}${UNREAD_COUNT_PATH}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { unreadCount: 7 });
    assert.deepEqual(backendPaths, [UNREAD_COUNT_PATH]);
  });
});

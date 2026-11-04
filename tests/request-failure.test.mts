import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { requestOf, responseOf } from "./helpers/http-doubles";
import { addressOf } from "./helpers/net";

/**
 * A path whose last percent-escape is cut short: Vite's HTML transform and
 * the router both run `decodeURI` on it, which throws.
 */
const MALFORMED_PATH = "/cloud/projects/%E0%A4%A";
/** A request the server dropped would otherwise wait forever. */
const REQUEST_TIMEOUT_MS = 10_000;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = addressOf(server);
  return `http://127.0.0.1:${address.port}`;
}

describe("requests the frontend server cannot serve", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-request-failure-"));
  const previousCwd = process.cwd();
  const previousDev = process.env.DMS_DEV;
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backendPaths: string[] = [];
  const backend = createServer((request, response) => {
    backendPaths.push(request.url ?? "");
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"message":"Not found"}');
  });
  let frontend: Server | undefined;
  let base = "";
  let runtime: typeof import("../templates/vue/server.mjs");

  before(async () => {
    process.env.DMS_API_BASE_URL = await listen(backend);
    writeFileSync(
      join(root, "vite.config.mjs"),
      "export default { logLevel: 'silent', server: { watch: null, ws: false } };",
    );
    process.env.DMS_DEV = "true";
    process.chdir(root);
    runtime = await import("../templates/vue/server.mjs");
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

  it("answers a malformed page path with 400 and keeps serving", async () => {
    for (const headers of [
      { accept: "text/html" },
      { "x-inertia": "true" },
      {},
    ]) {
      const response = await fetch(`${base}${MALFORMED_PATH}`, {
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      assert.equal(response.status, 400);
      assert.equal(await response.text(), "Bad Request");
    }
    assert.deepEqual(
      backendPaths,
      [],
      "a path no decoder accepts never reaches the backend",
    );
    const next = await fetch(`${base}/cloud/projects`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    assert.notEqual(next.status, 400, "the process is still up and serving");
  });

  it("answers 500 when rendering the error page fails too", async () => {
    const writes: Array<[number, Record<string, string>]> = [];
    let body: string | undefined;
    const response = Object.assign(responseOf(), {
      writeHead(status: number, headers: Record<string, string>) {
        writes.push([status, headers]);
      },
      end(content: string) {
        body = content;
      },
    });
    const request = Object.defineProperty(
      requestOf({ headers: { accept: "text/html" }, method: "GET" }),
      "url",
      {
        get(): string {
          throw new Error("unreadable request");
        },
      },
    );
    await runtime.handleRequestSafely(request, response);
    assert.deepEqual(writes, [
      [500, { "content-type": "text/plain; charset=utf-8" }],
    ]);
    assert.equal(body, "Internal Server Error");
  });

  it("drops the connection when the failed response had already started", async () => {
    let destroyed = false;
    let headersSent = false;
    const response = Object.defineProperty(
      Object.assign(responseOf(), {
        writeHead() {
          headersSent = true;
          throw new Error("render failed mid-response");
        },
        destroy() {
          destroyed = true;
        },
      }),
      "headersSent",
      { get: () => headersSent },
    );
    let reads = 0;
    const request = Object.defineProperty(
      requestOf({ headers: { accept: "application/json" }, method: "GET" }),
      "url",
      {
        get(): string {
          reads += 1;
          if (reads === 1) throw new Error("unreadable request");
          return "/fixture";
        },
      },
    );
    await runtime.handleRequestSafely(request, response);
    assert.equal(destroyed, true);
  });
});

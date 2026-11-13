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

void describe("requests the frontend server cannot serve", () => {
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

  void it("answers a malformed page path with 400 and keeps serving", async () => {
    const variants: Record<string, string>[] = [
      { accept: "text/html" },
      { "x-inertia": "true" },
      {},
    ];
    for (const headers of variants) {
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

  void it("answers 500 when rendering the error page fails too", async (context) => {
    const writes: Array<[number, Record<string, string>]> = [];
    let body: string | undefined;
    const response = responseOf();
    context.mock.method(
      response,
      "writeHead",
      (status: number, headers: Record<string, string>) => {
        writes.push([status, headers]);
      },
    );
    context.mock.method(response, "end", (content: string) => {
      body = content;
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

  void it("falls back to the client-rendered shell when the server render fails", async (context) => {
    const errors = context.mock.method(console, "error", () => undefined);
    const page = runtime.createInertiaPage("/articles", { path: "/articles" });
    const reads = Object.assign(async () => undefined, {
      reuseCompletedReads: () => undefined,
    });
    const { html, status } = await runtime.renderHtml(
      page,
      "/articles",
      reads,
      undefined,
    );
    assert.equal(status, 500);
    assert.ok(
      html.includes(runtime.inertiaAppHtml(page)),
      "the page document carries the page for the client to render",
    );
    assert.ok(
      errors.mock.calls.some(({ arguments: [message] }) =>
        String(message).includes("falling back to client rendering"),
      ),
      "the operator is told the page was not server-rendered",
    );
  });

  void it("drops the connection when the failed response had already started", async (context) => {
    let destroyed = false;
    let headersSent = false;
    const response = Object.defineProperty(responseOf(), "headersSent", {
      get: () => headersSent,
    });
    context.mock.method(response, "writeHead", () => {
      headersSent = true;
      throw new Error("render failed mid-response");
    });
    context.mock.method(response, "destroy", () => {
      destroyed = true;
    });
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

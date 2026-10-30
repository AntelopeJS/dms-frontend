import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { requestOf, responseOf } from "./helpers/http-doubles";
import { addressOf } from "./helpers/net";
import { server } from "./fixtures/inertia";

describe("Inertia HTTP protocol", () => {
  it("shares the frontend HTTP server with the Vite HMR websocket", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(process.cwd(), "templates", "vue", "server.mjs"), "utf8"),
    );
    assert.match(
      source,
      /serverOptions\.ws = \{ server: frontendHttpServer \}/,
    );
    assert.match(source, /vitePromise \?\?=/);
    assert.match(source, /vitePromise = undefined/);
    assert.match(
      source,
      /frontendHttpServer = createServer\(SERVER_OPTIONS, handleRequestSafely\)/,
    );
  });

  it("returns the required page object", async () => {
    const runtime = await server;
    const page = runtime.createInertiaPage("/articles", { path: "/articles" });
    assert.equal(page.component, "DmsDynamicPage");
    assert.equal(page.url, "/articles");
    assert.deepEqual(page.props, { path: "/articles", errors: {} });
    assert.equal(page.version, runtime.assetVersion());
    assert.notEqual(page.version, "1");
    assert.equal("clearHistory" in page, false);
    assert.equal("encryptHistory" in page, false);
  });

  it("embeds the initial page using the safe Inertia v3 JSON script", async () => {
    const runtime = await server;
    const html = runtime.inertiaAppHtml({
      component: "DmsDynamicPage",
      props: { value: "</script><script>alert(1)</script>" },
      url: "/articles",
      version: "test",
    });
    assert.match(html, /^<script data-page="app" type="application\/json">/);
    assert.match(html, /<div id="app"><\/div>$/);
    assert.doesNotMatch(html, /<\/script><script>alert/);
    assert.match(html, /<\\\/script>/);
  });

  it("sets Inertia response and cache variation headers", async () => {
    const runtime = await server;
    assert.deepEqual(runtime.inertiaHeaders(), {
      "cache-control": "private, no-cache",
      "content-type": "application/json",
      "x-inertia": "true",
      vary: "X-Inertia",
      "x-inertia-version": runtime.assetVersion(),
    });
  });

  it("keeps session-bearing responses out of shared caches", async () => {
    const backend = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"route":{},"layout":{}}');
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = addressOf(frontend);
    try {
      const response = await fetch(
        `http://127.0.0.1:${frontendAddress.port}/articles`,
        { headers: { "x-inertia": "true" } },
      );
      assert.equal(response.headers.get("cache-control"), "private, no-cache");
    } finally {
      frontend.close();
      backend.close();
    }
    assert.deepEqual(runtime.htmlHeaders(), {
      "cache-control": "private, no-cache",
      "content-type": "text/html",
      vary: "X-Inertia",
    });
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(process.cwd(), "templates", "vue", "server.mjs"), "utf8"),
    );
    assert.doesNotMatch(source, /"content-type": "text\/html"/);
  });

  it("uses native Inertia v3 semantics for internal, fragment, and external redirects", async () => {
    const runtime = await server;
    const capture = (location: string) => {
      let result:
        | { status: number; headers: Record<string, string> }
        | undefined;
      runtime.redirectFrontendVisit(
        requestOf({ method: "GET", headers: { "x-inertia": "true" } }),
        Object.assign(responseOf(), {
          end: () => undefined,
          writeHead: (status: number, headers: Record<string, string>) => {
            result = { status, headers };
          },
        }),
        location,
      );
      return result;
    };
    assert.deepEqual(capture("/articles"), {
      status: 302,
      headers: { vary: "X-Inertia", location: "/articles" },
    });
    assert.deepEqual(capture("/articles#details"), {
      status: 409,
      headers: {
        vary: "X-Inertia",
        "x-inertia-redirect": "/articles#details",
      },
    });
    assert.deepEqual(capture("https://docs.example.test/articles"), {
      status: 409,
      headers: {
        vary: "X-Inertia",
        "x-inertia-location": "https://docs.example.test/articles",
      },
    });
  });

  it("keeps shared navigation data on regular Inertia visits", async () => {
    let backendUrl = "";
    const backend = createServer((request, response) => {
      backendUrl = request.url ?? "";
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"route":{},"layout":{}}');
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = addressOf(frontend);
    try {
      const response = await fetch(
        `http://127.0.0.1:${frontendAddress.port}/articles`,
        { headers: { "x-inertia": "true" } },
      );
      assert.equal(response.status, 200);
      assert.equal(backendUrl, "/dms/page?path=%2Farticles");
    } finally {
      frontend.close();
      backend.close();
    }
  });

  it("forces a full visit when the deployed asset version changed", async () => {
    let backendRequests = 0;
    const backend = createServer((_request, response) => {
      backendRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"route":{},"layout":{}}');
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = addressOf(frontend);
    try {
      const response = await fetch(
        `http://127.0.0.1:${frontendAddress.port}/articles?tab=recent`,
        {
          headers: {
            "x-inertia": "true",
            "x-inertia-version": "stale-assets",
          },
          redirect: "manual",
        },
      );
      assert.equal(response.status, 409);
      assert.equal(
        response.headers.get("x-inertia-location"),
        "/articles?tab=recent",
      );
      assert.equal(
        response.headers.get("x-inertia-version"),
        runtime.assetVersion(),
      );
      assert.equal(response.headers.get("x-inertia"), null);
      assert.equal(backendRequests, 0);
    } finally {
      frontend.close();
      backend.close();
    }
  });
});

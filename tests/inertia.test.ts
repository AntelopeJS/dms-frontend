import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DMS_BACKEND_PROXIES } from "./fixtures/dms-backend-proxies.mts";
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
      let result: Record<string, unknown> = {};
      runtime.redirectFrontendVisit(
        { method: "GET", headers: { "x-inertia": "true" } },
        {
          end: () => undefined,
          writeHead: (status: number, headers: Record<string, string>) => {
            result = { status, headers };
          },
        },
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

  it("serves a built asset without asking the backend first", async () => {
    const backendPaths: string[] = [];
    const backend = createServer((request, response) => {
      backendPaths.push(request.url ?? "");
      const found = request.url === "/media/asset-1/photo.webp";
      response.writeHead(found ? 200 : 404, { "content-type": "image/webp" });
      response.end(found ? "backend media" : "");
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
    const base = `http://127.0.0.1:${frontendAddress.port}`;
    const assetName = `probe-${randomUUID()}.js`;
    const assets = join(
      process.cwd(),
      "templates",
      "vue",
      "dist",
      "client",
      "assets",
    );
    const created = await mkdir(assets, { recursive: true });
    await writeFile(join(assets, assetName), "export const probe = 1;\n");
    try {
      const asset = await fetch(`${base}/assets/${assetName}`);
      assert.equal(asset.status, 200);
      assert.equal(await asset.text(), "export const probe = 1;\n");
      assert.equal(
        asset.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assert.deepEqual(backendPaths, []);
      await writeFile(join(assets, "..", `${assetName}.woff2`), "font");
      const font = await fetch(`${base}/${assetName}.woff2`);
      assert.equal(font.headers.get("content-type"), "font/woff2");
      assert.equal(font.headers.get("cache-control"), "no-cache");
      await font.body?.cancel();
      const revalidated = await fetch(`${base}/${assetName}.woff2`, {
        headers: { "if-none-match": font.headers.get("etag") ?? "" },
      });
      assert.equal(revalidated.status, 304);
      await revalidated.body?.cancel();
      assert.deepEqual(backendPaths, []);
      process.env.DMS_BACKEND_PROXIES = JSON.stringify([
        { path: "/media/**", auth: "none" },
      ]);
      const media = await fetch(`${base}/media/asset-1/photo.webp`);
      assert.equal(media.status, 200);
      assert.equal(await media.text(), "backend media");
      assert.deepEqual(backendPaths, ["/media/asset-1/photo.webp"]);
      const missing = await fetch(`${base}/assets/missing-${assetName}`);
      assert.equal(missing.status, 404);
      await missing.body?.cancel();
      assert.deepEqual(backendPaths, ["/media/asset-1/photo.webp"]);
    } finally {
      process.env.DMS_BACKEND_PROXIES = DMS_BACKEND_PROXIES;
      await rm(join(assets, "..", `${assetName}.woff2`), { force: true });
      await rm(created ?? join(assets, assetName), {
        recursive: true,
        force: true,
      });
      frontend.close();
      backend.close();
    }
  });
});

import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DMS_BACKEND_PROXIES } from "./fixtures/dms-backend-proxies.mts";
import { addressOf } from "./helpers/net";
import {
  ACCESS_BLOCKED_CODE,
  pagePropsModule,
  server,
  sessions,
  writeSsrRendererFixture,
  frontendWithBackend,
} from "./fixtures/inertia";

describe("Inertia HTTP protocol", () => {
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

  it("puts a favicon placeholder in a page whose render declares no icon", async () => {
    await writeSsrRendererFixture();
    const runtime = await server;
    try {
      const page = runtime.createInertiaPage("/articles", {
        path: "/articles",
      });
      const { html } = await runtime.renderHtml(page, "/articles");
      assert.deepEqual(html.match(/<link rel="icon"[^>]*>/g), [
        '<link rel="icon" href="data:," />',
      ]);
      assert.match(
        html,
        /<head>[^]*<link rel="icon" href="data:," \/>[^]*<\/head>/,
      );
    } finally {
      await rm(join(process.cwd(), "templates", "vue", "dist"), {
        force: true,
        recursive: true,
      });
    }
  });

  it("renders sanitized backend failures through Inertia for HTML and X-Inertia visits", async () => {
    await writeSsrRendererFixture();
    const backend = createServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end('{"secret":"must-not-leak"}');
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
    try {
      for (const headers of [
        { accept: "text/html" },
        { "x-inertia": "true" },
      ]) {
        const response = await fetch(`${base}/broken`, { headers });
        const body = await response.text();
        assert.equal(response.status, 503);
        assert.doesNotMatch(body, /must-not-leak/);
        assert.doesNotMatch(body, /DMS backend request failed/);
        assert.doesNotMatch(body, /An unexpected error occurred/);
        assert.doesNotMatch(body, /Application error/);
        assert.match(
          body,
          /error(?:&quot;|\\?"):\{(?:&quot;|\\?")statusCode(?:&quot;|\\?"):503\}/,
        );
        if ("x-inertia" in headers)
          assert.equal(response.headers.get("x-inertia"), "true");
        else
          assert.match(
            response.headers.get("content-type") ?? "",
            /text\/html/,
          );
      }
      const apiResponse = await fetch(`${base}/api/broken`);
      assert.equal(apiResponse.status, 503);
      assert.deepEqual(await apiResponse.json(), {
        secret: "must-not-leak",
      });
    } finally {
      frontend.close();
      backend.close();
      await rm(join(process.cwd(), "templates", "vue", "dist"), {
        force: true,
        recursive: true,
      });
    }
  });

  it("redirects a typed access refusal to the page a frontend module registered", async () => {
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    await writeSsrRendererFixture();
    const refusals = new Map([
      ["/projects", ACCESS_BLOCKED_CODE],
      ["/workspace-suspended", ACCESS_BLOCKED_CODE],
      ["/json-refusal", JSON.stringify({ message: ACCESS_BLOCKED_CODE })],
      ["/unregistered", "saas.errors.other"],
    ]);
    const backend = createServer((request, response) => {
      const path =
        new URL(request.url ?? "/", "http://backend.local").searchParams.get(
          "path",
        ) ?? "";
      response.writeHead(403, { "content-type": "text/plain" });
      response.end(refusals.get(path) ?? "forbidden");
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const sessionRuntime = await sessions;
    const cookieHeaders = new Map<string, string | string[]>();
    sessionRuntime.writeSession(
      {
        getHeader: (name: string) => cookieHeaders.get(name),
        setHeader: (name: string, value: string | string[]) =>
          cookieHeaders.set(name, value),
      },
      {
        accessToken: "access",
        user: { id: "user-1", email: "a@example.com" },
      },
    );
    const cookie = [cookieHeaders.get("set-cookie") ?? []]
      .flat()
      .map((value) => value.split(";")[0])
      .join("; ");
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = addressOf(frontend);
    const base = `http://127.0.0.1:${frontendAddress.port}`;
    const visit = (path: string, headers: Record<string, string>) =>
      fetch(`${base}${path}`, {
        headers: { cookie, ...headers },
        redirect: "manual",
      });
    try {
      for (const headers of [
        { accept: "text/html" },
        { "x-inertia": "true" },
      ]) {
        for (const path of ["/projects", "/json-refusal"]) {
          const redirected = await visit(path, headers);
          assert.equal(redirected.status, 302);
          assert.equal(
            redirected.headers.get("location"),
            "/workspace-suspended",
          );
          assert.equal(redirected.headers.get("vary"), "X-Inertia");
        }
        for (const path of ["/workspace-suspended", "/unregistered"]) {
          const refused = await visit(path, headers);
          assert.equal(refused.status, 403);
          assert.equal(refused.headers.get("location"), null);
          assert.match(await refused.text(), /statusCode(?:&quot;|\\?"):403/);
        }
      }
    } finally {
      frontend.close();
      backend.close();
      await rm(join(process.cwd(), "templates", "vue", "dist"), {
        force: true,
        recursive: true,
      });
    }
  });
});

describe("Site layout as an Inertia once prop", () => {
  it("keeps the layout over a frontend-only page only when the browser holds it", async () => {
    await writeSsrRendererFixture();
    const { sharedOnceKey } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    const held = sharedOnceKey(undefined);
    try {
      const holding = await visit("/auth/custom", {
        "x-inertia-except-once-props": held,
      });
      assert.equal(
        (holding.page.props.page as { isFrontendOnly?: boolean })
          .isFrontendOnly,
        true,
      );
      assert.deepEqual(holding.page.onceProps, {
        [held]: { prop: "shared", expiresAt: null },
      });
      const bare = await visit("/auth/custom");
      assert.equal("shared" in bare.page.props, false);
      assert.equal(bare.page.onceProps, undefined);
    } finally {
      close();
      await rm(join(process.cwd(), "templates", "vue", "dist"), {
        force: true,
        recursive: true,
      });
    }
  });
});

import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DMS_BACKEND_PROXIES } from "./fixtures/dms-backend-proxies.mts";

interface ServerTemplate {
  assetVersion: () => string;
  createInertiaPage: (url: string, props: unknown) => Record<string, unknown>;
  inertiaAppHtml: (page: unknown) => string;
  inertiaHeaders: () => Record<string, string>;
  htmlHeaders: () => Record<string, string>;
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
  redirectFrontendVisit: (
    request: unknown,
    response: unknown,
    location: string,
  ) => void;
  renderHtml: (
    page: unknown,
    requestUrl: string,
  ) => Promise<{ html: string; status: number }>;
}

const server = import(
  join(process.cwd(), "templates", "vue", "server.mjs")
) as Promise<ServerTemplate>;

interface SessionTemplate {
  writeSession: (response: unknown, session: Record<string, unknown>) => void;
}

const sessions = import(
  join(process.cwd(), "templates", "vue", "server", "auth", "session.mjs")
) as Promise<SessionTemplate>;

const SSR_DIRECTORY = join(process.cwd(), "templates", "vue", "dist", "ssr");
const ACCESS_BLOCKED_CODE = "saas.errors.workspace.access_blocked";
// Node caches the first renderer import for the whole run: every test that
// needs one writes this same module.
const SSR_RENDERER_FIXTURE = `export async function renderDmsPage(page) {
  const serialized = JSON.stringify(page).replaceAll("/", "\\\\/");
  return { body: \`<script data-page="app" type="application/json">\${serialized}</script><div data-server-rendered="true" id="app"></div>\`, head: { headTags: "", htmlAttrs: "", bodyAttrs: "" }, overlays: "" };
}
export function isDmsFrontendPage(path) {
  return path === "/auth/custom";
}
export function accessRedirect(code) {
  return code === "${ACCESS_BLOCKED_CODE}" ? "/workspace-suspended" : undefined;
}\n`;

async function writeSsrRendererFixture(): Promise<void> {
  await mkdir(SSR_DIRECTORY, { recursive: true });
  await writeFile(join(SSR_DIRECTORY, "ssr-renderer.js"), SSR_RENDERER_FIXTURE);
}

/**
 * The session cookie of `session`, sealed as the module owning sign-in writes
 * it, for the backend `DMS_API_BASE_URL` names.
 */
async function sessionCookie(
  session: Record<string, unknown>,
): Promise<string> {
  process.env.DMS_SESSION_SECRET ??=
    "test-secret-with-at-least-thirty-two-characters";
  const sessionRuntime = await sessions;
  const headers = new Map<string, string | string[]>();
  sessionRuntime.writeSession(
    {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string | string[]) =>
        headers.set(name, value),
    },
    session,
  );
  return [headers.get("set-cookie") ?? []]
    .flat()
    .map((value) => value.split(";")[0])
    .join("; ");
}

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
      // Every payload carries the visitor's own session, so it must never
      // reach a shared cache, and the browser's own copy must be revalidated
      // rather than replayed. `no-store` would go further and cost the
      // back-forward cache on every page.
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
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
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
    // The document path renders through Vite, which this suite does not boot.
    // Hold it to the same stance by checking the headers it writes, and that
    // no document response builds its own set behind the helper's back.
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
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
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
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
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
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
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
    // The first directory this test creates, if any: removing it leaves no
    // `dist/` behind to switch later tests to the production paths.
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
      // A public file keeps its name across builds: sent with its type, then
      // revalidated rather than downloaded again.
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
      // A file the build does not have is the backend's under a prefix a
      // module declares, and the backend is asked for nothing else.
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

  it("does not write a second response after a client disconnect", async () => {
    const runtime = await server;
    let writeCount = 0;
    const response = {
      destroyed: false,
      headersSent: false,
      writableEnded: false,
      writeHead: () => {
        writeCount += 1;
      },
    };
    const disconnect = Object.assign(new Error("client disconnected"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
    const request = {
      get url() {
        throw disconnect;
      },
    };
    await runtime.handleRequestSafely(request, response);
    assert.equal(writeCount, 0);

    response.headersSent = true;
    const invalidRequest = {
      get url() {
        throw new Error("response already started");
      },
    };
    await runtime.handleRequestSafely(invalidRequest, response);
    assert.equal(writeCount, 0);
  });

  it("releases the backend stream of a client that leaves before it answers", async () => {
    let backendClosed: () => void = () => {};
    const released = new Promise<void>((settle) => {
      backendClosed = settle;
    });
    const backend = createServer((request, response) => {
      request.socket.once("close", backendClosed);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": open\n\n");
      }, 100);
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
    try {
      await assert.rejects(
        fetch(`http://127.0.0.1:${frontendAddress.port}/api/feed`, {
          headers: { accept: "text/event-stream" },
          signal: AbortSignal.timeout(20),
        }),
      );
      const timeout = new Promise<string>((settle) =>
        setTimeout(() => settle("still open"), 2_000).unref(),
      );
      assert.equal(
        await Promise.race([released.then(() => "released"), timeout]),
        "released",
      );
    } finally {
      frontend.closeAllConnections();
      frontend.close();
      backend.closeAllConnections();
      backend.close();
    }
  });

  it("puts a favicon placeholder in a page whose render declares no icon", async () => {
    // The template no longer carries one: a page declaring its own icons
    // would compete with it (see server/favicon.mjs).
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

  it("injects the SSR body without replacement-token expansion", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(process.cwd(), "templates", "vue", "server.mjs"), "utf8"),
    );
    assert.match(source, /renderer\.renderDmsPage\(/);
    assert.match(source, /\(\) => rendered\.body/);
    assert.doesNotMatch(source, /, rendered\.body\)/);
    assert.match(source, /falling back to client rendering/);
  });

  it("leaves the session, sign-in, e-mail render and tester paths to the modules and the backend", async () => {
    const reached: string[] = [];
    const backend = createServer((request, response) => {
      reached.push(`${request.method} ${request.url}`);
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"message":"error.page_not_found"}');
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const [method, path] of [
        ["POST", "/api/_auth/session"],
        ["DELETE", "/api/_auth/session"],
        ["POST", "/api/html/render"],
        ["POST", "/api/_dms/tester"],
      ]) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", origin: base },
          body: "{}",
        });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(reached.at(-1), `${method} ${path}`);
      }
      // A path no module route and no backend proxy covers is a page: a
      // sign-in action no module serves is a 404, never the backend's.
      const signIn = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "{}",
      });
      assert.equal(signIn.status, 404);
      await signIn.body?.cancel();
      assert.equal(reached.at(-1), "POST /api/_dms/tester");
    } finally {
      frontend.close();
      backend.close();
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
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
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

  it("redirects signed-out protected visits while preserving public routes", async () => {
    const publicRoutes = new Map([
      ["/auth", { fullSlug: "/auth", publicAccess: true }],
      [
        "/privacy",
        { fullSlug: "/privacy", hasAccess: false, publicAccess: true },
      ],
    ]);
    const backend = createServer((request, response) => {
      const path = new URL(
        request.url ?? "/",
        "http://backend.local",
      ).searchParams.get("path");
      const route = publicRoutes.get(path ?? "") ?? {
        fullSlug: "/protected",
        hasAccess: false,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ route, layout: {}, shared: {} }));
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
    const base = `http://127.0.0.1:${frontendAddress.port}`;
    try {
      const html = await fetch(`${base}/protected?tab=one`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      assert.equal(html.status, 302);
      assert.equal(
        html.headers.get("location"),
        "/auth?redirect=%2Fprotected%3Ftab%3Done",
      );
      const inertia = await fetch(`${base}/protected`, {
        headers: { "x-inertia": "true" },
        redirect: "manual",
      });
      assert.equal(inertia.status, 302);
      assert.equal(
        inertia.headers.get("location"),
        "/auth?redirect=%2Fprotected",
      );
      assert.equal(inertia.headers.get("vary"), "X-Inertia");
      const publicRoute = await fetch(`${base}/auth`, {
        headers: { "x-inertia": "true" },
      });
      assert.equal(publicRoute.status, 200);
      assert.equal(publicRoute.headers.get("x-inertia"), "true");
      const publicDeniedRoute = await fetch(`${base}/privacy`, {
        headers: { "x-inertia": "true" },
        redirect: "manual",
      });
      assert.equal(publicDeniedRoute.status, 200);
      assert.equal(publicDeniedRoute.headers.get("x-inertia"), "true");
    } finally {
      frontend.close();
      backend.close();
    }
  });

  it("redirects a typed access refusal to the page a frontend module registered", async () => {
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    await writeSsrRendererFixture();
    const refusals = new Map([
      ["/projects", ACCESS_BLOCKED_CODE],
      // The registered destination refused in turn keeps the error page.
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
    const address = backend.address();
    assert.ok(address && typeof address === "object");
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
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
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

describe("proxied mutations", () => {
  it("protects proxied mutations and preserves backend validation errors", async () => {
    const backend = createServer((_request, response) => {
      response.writeHead(422, {
        "content-type": "application/json",
        "x-validation-source": "dms",
      });
      response.end(
        '{"message":"Validation failed","errors":{"name":"Required"}}',
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const rejected = await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      });
      assert.equal(rejected.status, 403);
      assert.deepEqual(await rejected.json(), {
        error: "Forbidden",
        reason: "missing or untrusted Origin header",
      });

      const relayed = await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "{}",
      });
      assert.equal(relayed.status, 422);
      assert.equal(relayed.headers.get("x-validation-source"), "dms");
      assert.deepEqual(await relayed.json(), {
        message: "Validation failed",
        errors: { name: "Required" },
      });
    } finally {
      frontend.close();
      backend.close();
    }
  });
});

describe("public endpoints through the proxy", () => {
  it("lets a declared public route through anonymously, with its headers", async () => {
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    process.env.DMS_PUBLIC_ENDPOINTS = JSON.stringify([
      { path: "/api/hooks/*", headers: ["x-hook-secret"] },
    ]);
    const jwt = `x.${Buffer.from('{"tenantId":"tenant-1"}').toString("base64url")}.x`;
    const seen: Record<string, string | undefined>[] = [];
    const backend = createServer((request, response) => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        secret: request.headers["x-hook-secret"] as string | undefined,
        other: request.headers["x-other"] as string | undefined,
        ifMatch: request.headers["if-match"],
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    try {
      const cookie = await sessionCookie({
        accessToken: jwt,
        refreshToken: "refresh-1",
        user: { id: "user-1" },
      });

      const hook = await fetch(`${base}/api/hooks/resend?tenant=acme`, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.example",
          "x-hook-secret": "s3cret",
          "x-other": "dropped",
        },
        body: "{}",
      });
      assert.equal(hook.status, 202);
      assert.deepEqual(seen.at(-1), {
        url: "/api/hooks/resend?tenant=acme",
        authorization: undefined,
        secret: "s3cret",
        other: undefined,
        ifMatch: undefined,
      });

      const deeper = await fetch(`${base}/api/hooks/resend/more`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(deeper.status, 403);

      const owned = await fetch(`${base}/api/items`, {
        method: "PUT",
        headers: {
          cookie,
          origin: base,
          "if-match": '"7"',
          "x-hook-secret": "not-relayed",
        },
        body: "{}",
      });
      assert.equal(owned.status, 202);
      assert.deepEqual(seen.at(-1), {
        url: "/api/items",
        authorization: `Bearer ${jwt}`,
        secret: undefined,
        other: undefined,
        ifMatch: '"7"',
      });
    } finally {
      delete process.env.DMS_PUBLIC_ENDPOINTS;
      frontend.close();
      backend.close();
    }
  });
});

interface PagePropsTemplate {
  sharedOnceKey: (session?: Record<string, unknown>) => string;
  SHARED_PROP_TTL_MS: number;
}

const pagePropsModule = import(
  join(process.cwd(), "templates", "vue", "server", "page-props.mjs")
) as Promise<PagePropsTemplate>;

describe("Site layout as an Inertia once prop", () => {
  const PAGE = { route: { fullSlug: "/articles" }, layout: { id: "layout" } };
  const SHARED = { siteLayout: { pages: {} }, isOwner: true };
  const FRESH_SHARED = { siteLayout: { pages: {} }, isOwner: false };

  async function frontendWithBackend() {
    const backendCalls: string[] = [];
    const backend = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://backend.local");
      backendCalls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/dms/sitelayout") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(FRESH_SHARED));
        return;
      }
      if (url.searchParams.get("path") === "/auth/custom") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"message":"error.page_not_found"}');
        return;
      }
      const omitShared = url.searchParams.get("shared") === "false";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(omitShared ? PAGE : { ...PAGE, shared: SHARED }),
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = frontend.address();
    assert.ok(frontendAddress && typeof frontendAddress === "object");
    const base = `http://127.0.0.1:${frontendAddress.port}`;
    const visit = async (
      path: string,
      headers: Record<string, string> = {},
    ) => {
      backendCalls.length = 0;
      const response = await fetch(`${base}${path}`, {
        headers: { "x-inertia": "true", ...headers },
        redirect: "manual",
      });
      const page = (await response.json()) as {
        props: Record<string, unknown>;
        onceProps?: Record<string, { prop: string; expiresAt: number | null }>;
      };
      return { page, backendCalls: [...backendCalls] };
    };
    const close = () => {
      frontend.close();
      backend.close();
    };
    return { visit, close };
  }

  function accountCookie(accountId: string): Promise<string> {
    return sessionCookie({
      accessToken: "access",
      accountId,
      activeTenantId: "tenant-1",
      user: { id: accountId },
    });
  }

  it("sends the site layout once per session, then the page alone", async () => {
    const { sharedOnceKey, SHARED_PROP_TTL_MS } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    const anonymous = sharedOnceKey(undefined);
    try {
      const before = Date.now();
      const first = await visit("/articles");
      assert.deepEqual(first.backendCalls, ["/dms/page?path=%2Farticles"]);
      assert.deepEqual(first.page.props.shared, SHARED);
      assert.deepEqual(first.page.props.page, PAGE);
      assert.deepEqual(Object.keys(first.page.onceProps ?? {}), [anonymous]);
      const declared = first.page.onceProps?.[anonymous];
      assert.equal(declared?.prop, "shared");
      assert.ok(
        (declared?.expiresAt ?? 0) >= before + SHARED_PROP_TTL_MS &&
          (declared?.expiresAt ?? 0) <= Date.now() + SHARED_PROP_TTL_MS,
      );

      const next = await visit("/articles", {
        "x-inertia-except-once-props": anonymous,
      });
      assert.deepEqual(next.backendCalls, [
        "/dms/page?path=%2Farticles&shared=false",
      ]);
      assert.equal("shared" in next.page.props, false);
      assert.deepEqual(next.page.props.page, PAGE);
      assert.deepEqual(next.page.onceProps, {
        [anonymous]: { prop: "shared", expiresAt: null },
      });

      // The layout another session was sent is not this one's.
      const cookie = await accountCookie("account-a");
      const signedIn = await visit("/articles", {
        cookie,
        "x-inertia-except-once-props": anonymous,
      });
      assert.deepEqual(signedIn.backendCalls, ["/dms/page?path=%2Farticles"]);
      assert.deepEqual(signedIn.page.props.shared, SHARED);
      const accountKey = sharedOnceKey({
        accountId: "account-a",
        activeTenantId: "tenant-1",
      });
      assert.notEqual(accountKey, anonymous);
      assert.deepEqual(Object.keys(signedIn.page.onceProps ?? {}), [
        accountKey,
      ]);
      const held = await visit("/articles", {
        cookie,
        "x-inertia-except-once-props": accountKey,
      });
      assert.deepEqual(held.backendCalls, [
        "/dms/page?path=%2Farticles&shared=false",
      ]);
      // A browser that holds another session's layout too may show that one
      // under `shared`: it is sent this session's again.
      const mixed = await visit("/articles", {
        cookie,
        "x-inertia-except-once-props": `${anonymous},${accountKey}`,
      });
      assert.deepEqual(mixed.backendCalls, ["/dms/page?path=%2Farticles"]);
      assert.deepEqual(mixed.page.props.shared, SHARED);
      assert.deepEqual(Object.keys(mixed.page.onceProps ?? {}), [accountKey]);
      assert.equal(
        sharedOnceKey({
          accountId: "account-a",
          activeTenantId: "tenant-2",
        }) === accountKey,
        false,
      );
    } finally {
      close();
    }
  });

  it("answers a partial reload with the props it names", async () => {
    const { sharedOnceKey } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    const held = sharedOnceKey(undefined);
    const partial = (data: string, extra: Record<string, string> = {}) =>
      visit("/articles?tab=b", {
        "x-inertia-partial-component": "DmsDynamicPage",
        "x-inertia-partial-data": data,
        ...extra,
      });
    try {
      // A forced reload of the layout the browser holds.
      const shared = await partial("shared", {
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(shared.backendCalls, ["/dms/sitelayout"]);
      assert.deepEqual(Object.keys(shared.page.props).sort(), [
        "errors",
        "shared",
      ]);
      assert.deepEqual(shared.page.props.shared, FRESH_SHARED);
      assert.notEqual(shared.page.onceProps?.[held]?.expiresAt, null);

      const page = await partial("page.layout", {
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(page.backendCalls, [
        "/dms/page?path=%2Farticles&tab=b&shared=false",
      ]);
      assert.deepEqual(Object.keys(page.page.props).sort(), ["errors", "page"]);

      // A signed-out session is sent as one, so the merge cannot keep the old.
      const session = await partial("user,session", {
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(session.backendCalls, []);
      assert.deepEqual(session.page.props, {
        user: null,
        session: null,
        errors: {},
      });

      // A browser without this session's layout gets it with any reload.
      const stale = await partial("page");
      assert.deepEqual(stale.backendCalls, [
        "/dms/page?path=%2Farticles&tab=b",
      ]);
      assert.deepEqual(stale.page.props.shared, SHARED);

      const excepted = await visit("/articles", {
        "x-inertia-partial-component": "DmsDynamicPage",
        "x-inertia-partial-except": "page",
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(excepted.backendCalls, ["/dms/sitelayout"]);
      assert.equal("page" in excepted.page.props, false);

      // Another component's reload is a full visit.
      const other = await visit("/articles", {
        "x-inertia-partial-component": "Other",
        "x-inertia-partial-data": "shared",
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(other.backendCalls, [
        "/dms/page?path=%2Farticles&shared=false",
      ]);
      assert.equal(typeof other.page.props.path, "string");
    } finally {
      close();
    }
  });

  it("asks the backend for the page with the query of the visit", async () => {
    const { sharedOnceKey } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    try {
      // A header button's availability reads the page query: the layout is
      // asked for the query the browser shows, one value per name, the last.
      const first = await visit(
        "/articles?workspace=web&locale=fr&locale=de&path=%2Fother",
      );
      assert.deepEqual(first.backendCalls, [
        "/dms/page?path=%2Farticles&workspace=web&locale=de",
      ]);
      const next = await visit("/articles?workspace=web&shared=true", {
        "x-inertia-except-once-props": sharedOnceKey(undefined),
      });
      assert.deepEqual(next.backendCalls, [
        "/dms/page?path=%2Farticles&workspace=web&shared=false",
      ]);
    } finally {
      close();
    }
  });

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

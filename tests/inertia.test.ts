import * as assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";

interface ServerTemplate {
  assetVersion: () => string;
  createInertiaPage: (url: string, props: unknown) => Record<string, unknown>;
  inertiaAppHtml: (page: unknown) => string;
  inertiaHeaders: () => Record<string, string>;
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
  redirectFrontendVisit: (
    request: unknown,
    response: unknown,
    location: string,
  ) => void;
  renderHtml: (page: unknown, requestUrl: string) => Promise<string>;
  requestOwnership: (method: string, pathname: string) => string;
}

const server = import(
  join(process.cwd(), "templates", "vue", "server.mjs")
) as Promise<ServerTemplate>;

interface SessionTemplate {
  readAccounts: (request: unknown) => Record<string, Record<string, unknown>>;
  storeAccount: (
    request: unknown,
    response: unknown,
    session: Record<string, unknown>,
    accountId: string,
  ) => void;
}

const sessions = import(
  join(process.cwd(), "templates", "vue", "server", "auth", "session.mjs")
) as Promise<SessionTemplate>;

function serviceToken(secret: string): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      namespace: "html-render-service",
      purpose: "html-render",
      aud: "dms-frontend",
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("Inertia HTTP protocol", () => {
  it("shares the frontend HTTP server with the Vite HMR websocket", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(process.cwd(), "templates", "vue", "server.mjs"), "utf8"),
    );
    assert.match(
      source,
      /serverOptions\.hmr = \{ server: frontendHttpServer \}/,
    );
    assert.match(source, /vitePromise \?\?=/);
    assert.match(source, /vitePromise = undefined/);
    assert.match(
      source,
      /frontendHttpServer = createServer\(handleRequestSafely\)/,
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
      "content-type": "application/json",
      "x-inertia": "true",
      vary: "X-Inertia",
      "x-inertia-version": runtime.assetVersion(),
    });
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

  it("injects the SSR body without replacement-token expansion", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(process.cwd(), "templates", "vue", "server.mjs"), "utf8"),
    );
    assert.match(source, /renderer\.renderDmsPage\(/);
    assert.match(source, /\(\) => rendered\.body/);
    assert.doesNotMatch(source, /, rendered\.body\)/);
    assert.match(source, /falling back to client rendering/);
  });

  it("classifies every dms-auth server route without claiming browser pages", async () => {
    const runtime = await server;
    const routes = [
      ["POST", "/auth/login"],
      ["POST", "/auth/signup"],
      ["POST", "/auth/verify-2fa"],
      ["POST", "/auth/request-2fa-email"],
      ["POST", "/auth/switch-account"],
      ["POST", "/auth/switch-tenant"],
      ["POST", "/auth/validate-account"],
      ["POST", "/auth/oauth/handoff"],
      ["GET", "/auth/oauth/github/start"],
      ["GET", "/auth/oauth/github/callback"],
    ];
    routes.forEach(([method, path]) => {
      assert.equal(
        runtime.requestOwnership(method, path),
        "server",
        `${method} ${path}`,
      );
    });
    for (const path of ["/auth/login", "/auth/signup", "/auth/oauth/complete"])
      assert.equal(
        runtime.requestOwnership("GET", path),
        "frontend",
        `GET ${path}`,
      );
  });

  it("routes every tester method and optional trailing slash to its handler", async () => {
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    try {
      for (const [method, suffix] of [
        ["GET", ""],
        ["PATCH", "/"],
      ]) {
        const response = await fetch(
          `http://127.0.0.1:${address.port}/api/_dms/tester${suffix}`,
          { method },
        );
        assert.equal(response.status, 405);
        assert.equal(response.headers.get("allow"), "POST");
      }
    } finally {
      frontend.close();
    }
  });

  it("renders sanitized backend failures through Inertia for HTML and X-Inertia visits", async () => {
    const ssrDirectory = join(process.cwd(), "templates", "vue", "dist", "ssr");
    const ssrRenderer = join(ssrDirectory, "ssr-renderer.js");
    await mkdir(ssrDirectory, { recursive: true });
    await writeFile(
      ssrRenderer,
      `export async function renderDmsPage(page) {
  const serialized = JSON.stringify(page).replaceAll("/", "\\\\/");
  return { body: \`<script data-page="app" type="application/json">\${serialized}</script><div data-server-rendered="true" id="app"></div>\`, head: { headTags: "", htmlAttrs: "", bodyAttrs: "" }, overlays: "" };
}\n`,
    );
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
        assert.match(body, /DMS backend request failed/);
        assert.match(body, /statusCode(?:&quot;|\\?"):503/);
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
});

describe("frontend auth runtime", () => {
  it("rotates the sealed account tokens when validating an account", async () => {
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    const backend = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        '{"access_token":"access-new","refresh_token":"refresh-new"}',
      );
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const runtime = await server;
    const sessionRuntime = await sessions;
    const cookieHeaders = new Map<string, string | string[]>();
    const cookieResponse = {
      getHeader: (name: string) => cookieHeaders.get(name),
      setHeader: (name: string, value: string | string[]) =>
        cookieHeaders.set(name, value),
    };
    const accountId = "00000000-0000-4000-8000-000000000001";
    sessionRuntime.storeAccount(
      { headers: {} },
      cookieResponse,
      {
        accessToken: "access-old",
        refreshToken: "refresh-old",
        user: { id: "user-1", email: "a@example.com" },
      },
      accountId,
    );
    const storedCookie = cookieHeaders.get("set-cookie") ?? "";
    const initialCookie = Array.isArray(storedCookie)
      ? storedCookie.join("; ")
      : storedCookie;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/auth/validate-account`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            cookie: initialCookie,
            origin: `http://127.0.0.1:${address.port}`,
          },
          body: JSON.stringify({ accountId }),
        },
      );
      assert.deepEqual(await response.json(), { valid: true });
      const updatedCookie = response.headers.get("set-cookie") ?? "";
      assert.match(updatedCookie, /dms_account_/);
      assert.notEqual(updatedCookie, initialCookie);
      assert.doesNotMatch(updatedCookie, /refresh-new/);
    } finally {
      frontend.close();
      backend.close();
    }
  });

  it("establishes, refreshes, and clears an HttpOnly session without exposing refresh tokens", async () => {
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    const jwt = `x.${Buffer.from('{"tenantId":"tenant-1"}').toString("base64url")}.x`;
    const backend = createServer(async (request, response) => {
      const payloads: Record<string, unknown> = {
        "/api/auth/login": {
          user: { id: "user-1" },
          access_token: jwt,
          refresh_token: "refresh-1",
        },
        "/api/auth/refresh": { access_token: jwt, refresh_token: "refresh-2" },
        "/api/auth/me": { id: "user-1", name: "Updated" },
        "/api/auth/logout": {},
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payloads[request.url ?? ""]));
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
      const login = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: '{"email":"a@example.com"}',
      });
      const cookie = login.headers.get("set-cookie") ?? "";
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /SameSite=Lax/i);
      assert.doesNotMatch(await login.text(), /refresh-1/);
      const session = await fetch(`${base}/api/_auth/session`, {
        method: "POST",
        headers: { cookie, origin: base },
      });
      const sessionBody = await session.text();
      assert.match(sessionBody, /Updated/);
      assert.doesNotMatch(
        sessionBody,
        /accessToken|access_token|x\.[A-Za-z0-9_-]+\.x/,
      );
      assert.doesNotMatch(sessionBody, /refresh-2/);
      const logout = await fetch(`${base}/api/_auth/session`, {
        method: "DELETE",
        headers: { cookie, origin: base },
      });
      assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
      const rejected = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      });
      assert.equal(rejected.status, 403);
    } finally {
      frontend.close();
      backend.close();
    }
  });

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

describe("HTML render HTTP endpoint", () => {
  it("rejects an empty template name with 400", async () => {
    process.env.DMS_HTML_RENDER_SECRET = "render-secret";
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/html/render`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dms-service-token": serviceToken("render-secret"),
          },
          body: '{"templateName":"","props":{}}',
        },
      );
      assert.equal(response.status, 400);
    } finally {
      frontend.close();
    }
  });

  it("uses the content language header as the rendered locale", async () => {
    process.env.DMS_HTML_RENDER_SECRET = "render-secret";
    const rendererDir = join(
      process.cwd(),
      "templates",
      "vue",
      "dist",
      "server",
    );
    const rendererPath = join(rendererDir, "email-renderer.js");
    await mkdir(rendererDir, { recursive: true });
    await writeFile(
      rendererPath,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: The fixture must retain this interpolation.
      "export async function renderEmail(_name, _props, options) { return `<p>${options.locale}</p>`; }\n",
    );
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/api/html/render`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-dms-service-token": serviceToken("render-secret"),
            "x-content-language": "fr-FR",
          },
          body: '{"templateName":"welcome","props":{}}',
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { html: "<p>fr-FR</p>" });
    } finally {
      frontend.close();
      await rm(join(process.cwd(), "templates", "vue", "dist"), {
        recursive: true,
        force: true,
      });
    }
  });
});

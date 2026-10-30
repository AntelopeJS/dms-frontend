import * as assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  copyStaticTemplates,
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../src/common";
import { readSealedCookie } from "../templates/vue/server/auth/session.mjs";
import {
  SESSION_SECRET,
  SERVER_ENTRY,
  writeFixture,
  BackendCall,
  listen,
  close,
  FIXTURE_HANDLERS,
  FIXTURE_ENTRY,
} from "./fixtures/server-modules";
import { builtServer } from "./helpers/built-templates";

describe("Module server routes in the production server", () => {
  const workspace = realpathSync(mkdtempSync(resolve(".server-modules-")));
  const source = mkdtempSync(join(tmpdir(), "dms-server-fixture-"));
  const backendCalls: BackendCall[] = [];
  const warnings: string[] = [];
  let backend: Server | undefined;
  let frontend: Server | undefined;
  let frontendUrl = "";
  let backendUrl = "";
  const originalWarn = console.warn;
  const environment = {
    DMS_API_BASE_URL: process.env.DMS_API_BASE_URL,
    DMS_SESSION_SECRET: process.env.DMS_SESSION_SECRET,
    DMS_OAUTH_RELAY_SECRET: process.env.DMS_OAUTH_RELAY_SECRET,
    DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE,
  };

  before(async () => {
    backend = createServer((request, response) => {
      backendCalls.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
      });
      if (request.url === "/api/refuse") {
        response.writeHead(403, { "content-type": "application/json" });
        response.end('{"message":"error.fixture.refused"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"from":"backend"}');
    });
    backendUrl = await listen(backend);
    process.env.DMS_API_BASE_URL = backendUrl;
    process.env.DMS_SESSION_SECRET = SESSION_SECRET;
    process.env.DMS_OAUTH_RELAY_SECRET = "relay-from-environment";
    process.env.DMS_COOKIE_SECURE = "false";

    writeFixture(source, SERVER_ENTRY, FIXTURE_ENTRY);
    writeFixture(source, "server/handlers.ts", FIXTURE_HANDLERS);
    copyStaticTemplates(workspace);
    writeFixture(workspace, "package.json", '{"type":"module"}');
    const layers = [
      {
        path: source,
        packageName: "@acme/fixture-frontend",
        options: { greeting: "hi" },
        privateOptions: { oauth: { relaySecret: "relay-from-manifest" } },
      },
    ];
    const registry = createFrontendModuleRegistry(workspace, layers);
    cpSync(source, registry.modules[0].root, { recursive: true });
    writeFrontendModuleRegistry(workspace, layers);
    const { build } = await import("vite");
    await build({
      configFile: join(workspace, "vite.server.config.ts"),
      root: workspace,
      logLevel: "silent",
    });

    console.warn = (message: string) => warnings.push(message);
    const server = await builtServer(workspace);
    frontend = createServer((request, response) => {
      void server.handleRequestSafely(request, response);
    });
    frontendUrl = await listen(frontend);
  });

  after(async () => {
    console.warn = originalWarn;
    await close(frontend);
    await close(backend);
    for (const [name, value] of Object.entries(environment))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  it("answers a route from the built bundle with its parameters, the module's options and no-store", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/hello/ada?q=1`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      name: "ada",
      module: "acme__fixture-frontend",
      options: { greeting: "hi" },
      relaySecret: "relay-from-manifest",
      origin: frontendUrl,
      query: "1",
    });
  });

  it("refuses a state-changing request without the frontend's Origin", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/echo`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Forbidden",
      reason: "missing or untrusted Origin header",
    });
  });

  it("reads the body and writes a sealed cookie the built-in code decodes", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/echo`, {
      method: "POST",
      headers: { origin: frontendUrl, "content-type": "application/json" },
      body: '{"a":1}',
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { a: 1 });
    const [cookie] = response.headers.getSetCookie();
    assert.match(
      cookie,
      /^acme__fixture-frontend\.fixture_flow_[0-9a-f]{12}=[^;]+; Path=\/auth\/fixture; HttpOnly; SameSite=Lax; Max-Age=60$/,
    );
    const pair = cookie.split(";", 1)[0];
    assert.deepEqual(
      readSealedCookie(
        { headers: { cookie: pair } },
        "acme__fixture-frontend.fixture_flow",
      ),
      { input: { a: 1 } },
    );
  });

  it("answers 413 past the route's body limit", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/echo`, {
      method: "POST",
      headers: { origin: frontendUrl },
      body: JSON.stringify({ text: "x".repeat(100) }),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      message: "Request body too large",
    });
  });

  it("answers 413 for a streamed body past the limit, which declares no length", async () => {
    const chunk = new TextEncoder().encode(`"${"x".repeat(100)}"`);
    const response = await fetch(`${frontendUrl}/api/_fixture/echo`, {
      method: "POST",
      headers: { origin: frontendUrl },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(chunk);
          controller.close();
        },
      }),
      duplex: "half",
    });
    assert.equal(response.status, 413);
  });

  it("streams a returned Response and keeps every cookie", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/stream`);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "max-age=5");
    assert.equal(await response.text(), "one two three");
    const cookies = response.headers.getSetCookie();
    assert.equal(cookies.length, 3);
    assert.match(
      cookies[0],
      /^acme__fixture-frontend\.fixture_seen_[0-9a-f]{12}=/,
    );
    assert.deepEqual(cookies.slice(1), [
      "plain_a=1; Path=/",
      "plain_b=2; Path=/",
    ]);
  });

  it("calls the backend with the client's address, which a module cannot replace", async () => {
    backendCalls.length = 0;
    const response = await fetch(`${frontendUrl}/api/_fixture/backend`, {
      method: "POST",
      headers: {
        origin: frontendUrl,
        "x-realtime-connection": "connection-7",
        "x-time-zone": "Europe/Brussels",
        "x-custom": "dropped",
      },
    });
    assert.deepEqual(await response.json(), { from: "backend" });
    const [call] = backendCalls;
    assert.equal(call.url, "/api/echo");
    assert.equal(call.headers["x-forwarded-for"], "127.0.0.1");
    assert.equal(call.headers["x-realtime-connection"], "connection-7");
    assert.equal(call.headers["x-time-zone"], undefined);
    assert.equal(call.headers["x-custom"], undefined);
    assert.equal(call.headers["x-fixture"], "yes");
    assert.equal(call.headers.authorization, "Bearer module-token");
  });

  it("gives a backend URL on the backend's origin, whatever the path names", async () => {
    backendCalls.length = 0;
    const response = await fetch(`${frontendUrl}/api/_fixture/raw`);
    assert.deepEqual(await response.json(), {
      status: 200,
      url: `${backendUrl}/api/raw?x=1`,
    });
    assert.equal(backendCalls[0].url, "/api/raw?x=1");
  });

  it("answers a backend refusal with its status and public message", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/refused`);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      message: "error.fixture.refused",
    });
  });

  it("answers 204 for a handler that returns nothing", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/empty`);
    assert.equal(response.status, 204);
  });

  it("owns the paths of its routes for every method, the backend never asked", async () => {
    const declared = await fetch(`${frontendUrl}/api/_auth/session`);
    assert.deepEqual(await declared.json(), {
      shadowed: true,
      signedIn: false,
    });
    backendCalls.length = 0;
    for (const [method, path] of [
      ["DELETE", "/api/_auth/session"],
      ["PUT", "/api/_fixture/hello/ada"],
    ]) {
      const response = await fetch(`${frontendUrl}${path}`, {
        method,
        headers: { origin: frontendUrl },
      });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.match(response.headers.get("allow") ?? "", /GET, HEAD/);
      await response.body?.cancel();
    }
    assert.deepEqual(backendCalls, []);
  });

  it("answers a HEAD with the GET route, without its body", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/hello/ada`, {
      method: "HEAD",
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  });

  it("proxies the prefix the module declares, and nothing outside it", async () => {
    backendCalls.length = 0;
    await (await fetch(`${frontendUrl}/api/items?x=1`)).body?.cancel();
    const outside = await fetch(`${frontendUrl}/dms/page`, {
      method: "POST",
      headers: { origin: frontendUrl },
    });
    assert.equal(outside.status, 404);
    await outside.body?.cancel();
    assert.deepEqual(
      backendCalls.map(({ method, url }) => ({ method, url })),
      [{ method: "GET", url: "/api/items?x=1" }],
    );
  });

  it("reports the routes it ignored when it loaded them", () => {
    assert.ok(
      warnings.some((warning) =>
        /declares route "GET \/assets\/taken\.js", which is ignored/.test(
          warning,
        ),
      ),
      warnings.join("\n"),
    );
  });
});

import * as assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  copyStaticTemplates,
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../src/common";
import {
  matchModuleRoute,
  resolveServerDeclarations,
} from "../templates/vue/server/module-routes.mjs";
import { compilePublicEndpoint } from "../templates/vue/server/public-endpoints.mjs";
import { readSealedCookie } from "../templates/vue/server/auth/session.mjs";
import {
  type DmsServerSetup,
  defineDmsServer,
} from "../templates/vue/server-module";
import { readText } from "./helpers/files";

const SESSION_SECRET = "a-test-only-session-secret-of-32-characters";
const SERVER_ENTRY = "dms.server.ts";

type Setup = Parameters<typeof defineDmsServer>[0];

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function resolved(
  declarations: { id: string; priority?: number; setup: Setup }[],
  publicEndpoints: unknown[] = [],
) {
  const warnings: string[] = [];
  const { routes } = resolveServerDeclarations(
    declarations,
    (message: string) => warnings.push(message),
    publicEndpoints.map(compilePublicEndpoint),
  );
  return { routes, warnings };
}

const handler = () => ({ ok: true });

describe("Module server declarations", () => {
  it("serve nothing for a deployment whose modules declare nothing", () => {
    assert.deepEqual(resolved([]), { routes: [], warnings: [] });
  });

  it("match a declared route with its parameters, decoded, and ignore a trailing slash", () => {
    const { routes, warnings } = resolved([
      {
        id: "auth",
        setup: (server) => {
          server.registerRoute("GET", "/auth/oauth/:provider/start", handler);
        },
      },
    ]);
    assert.deepEqual(warnings, []);
    const reached = matchModuleRoute(
      routes,
      "GET",
      "/auth/oauth/git%2Dhub/start/",
    );
    assert.equal(reached?.route.id, "auth");
    assert.deepEqual(reached?.params, { provider: "git-hub" });
    assert.equal(
      matchModuleRoute(routes, "POST", "/auth/oauth/github/start"),
      undefined,
    );
    assert.equal(
      matchModuleRoute(routes, "GET", "/auth/oauth/a/b/start"),
      undefined,
    );
  });

  it("register one handler for several methods", () => {
    const { routes } = resolved([
      {
        id: "auth",
        setup: (server) => {
          server.registerRoute(
            ["GET", "DELETE"],
            "/api/_auth/session",
            handler,
          );
        },
      },
    ]);
    assert.deepEqual(
      routes.map((route: { method: string }) => route.method),
      ["GET", "DELETE"],
    );
  });

  it("ignore a malformed declaration with a warning naming the module", () => {
    const { routes, warnings } = resolved([
      {
        id: "billing",
        setup: (server) => {
          server.registerRoute("FETCH" as never, "/api/_billing/a", handler);
          server.registerRoute("GET", "api/_billing/b", handler);
          server.registerRoute("GET", "/api/_billing/../c", handler);
          server.registerRoute("GET", "/api/_billing/:id/:id", handler);
          server.registerRoute("GET", "/api/_billing/d", "nope" as never);
          server.registerRoute("GET", "/api/_billing/e", handler, {
            bodyLimit: -1,
          });
          server.registerRoute("GET", "/api/_billing/ok", handler);
        },
      },
    ]);
    assert.deepEqual(
      routes.map((route: { path: string }) => route.path),
      ["/api/_billing/ok"],
    );
    assert.equal(warnings.length, 6);
    for (const warning of warnings)
      assert.match(
        warning,
        /^Frontend module billing declares route ".+", which is ignored: .+\.$/,
      );
  });

  it("refuse the renderer's own paths", () => {
    const { routes, warnings } = resolved([
      {
        id: "greedy",
        setup: (server) => {
          server.registerRoute("GET", "/api/_dms/icons/x", handler);
          server.registerRoute("GET", "/@vite/client", handler);
          server.registerRoute("GET", "/assets/main.js", handler);
        },
      },
    ]);
    assert.deepEqual(routes, []);
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /are the renderer's own paths/);
  });

  it("let the higher-priority module keep a contested route, and say so", () => {
    const { routes, warnings } = resolved([
      {
        id: "saas",
        priority: 0,
        setup: (s) => s.registerRoute("GET", "/api/_x/ping", handler),
      },
      {
        id: "override",
        priority: 10,
        setup: (s) => s.registerRoute("GET", "/api/_x/ping", handler),
      },
    ]);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].id, "override");
    assert.deepEqual(warnings, [
      '"GET /api/_x/ping": saas (priority 0) is shadowed by override (priority 10); the higher priority wins.',
    ]);
  });

  it("settle a priority tie by module id, and say so", () => {
    const { routes, warnings } = resolved([
      {
        id: "zeta",
        setup: (s) => s.registerRoute("POST", "/api/_x/a", handler),
      },
      {
        id: "alpha",
        setup: (s) => s.registerRoute("POST", "/api/_x/a", handler),
      },
    ]);
    assert.equal(routes[0].id, "alpha");
    assert.match(warnings[0], /same priority, the first module id wins/);
  });

  it("try a literal route before another route's parameter", () => {
    const { routes } = resolved([
      {
        id: "high",
        priority: 5,
        setup: (s) => s.registerRoute("POST", "/auth/oauth/:action", handler),
      },
      {
        id: "low",
        setup: (s) => s.registerRoute("POST", "/auth/oauth/handoff", handler),
      },
    ]);
    assert.equal(
      matchModuleRoute(routes, "POST", "/auth/oauth/handoff")?.route.id,
      "low",
    );
    assert.equal(
      matchModuleRoute(routes, "POST", "/auth/oauth/other")?.route.id,
      "high",
    );
  });

  it("warn when two modules' different routes can match the same request", () => {
    const { routes, warnings } = resolved([
      {
        id: "oauth",
        priority: 5,
        setup: (s) =>
          s.registerRoute("GET", "/auth/oauth/:provider/callback", handler),
      },
      {
        id: "google",
        setup: (s) =>
          s.registerRoute("GET", "/auth/oauth/google/callback", handler),
      },
    ]);
    assert.deepEqual(warnings, [
      '"GET /auth/oauth/google/callback" of google (priority 0) and ' +
        '"GET /auth/oauth/:provider/callback" of oauth (priority 5) can match ' +
        "the same request, which google answers: it has fewer parameters.",
    ]);
    // The order is unchanged: the literal route still answers its path.
    assert.equal(
      matchModuleRoute(routes, "GET", "/auth/oauth/google/callback")?.route.id,
      "google",
    );
    assert.equal(
      matchModuleRoute(routes, "GET", "/auth/oauth/github/callback")?.route.id,
      "oauth",
    );
  });

  it("warn on overlapping parameter routes settled by priority", () => {
    const { warnings } = resolved([
      {
        id: "low",
        setup: (s) => s.registerRoute("POST", "/api/_x/:id/a", handler),
      },
      {
        id: "high",
        priority: 3,
        setup: (s) => s.registerRoute("POST", "/api/_x/b/:name", handler),
      },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /^"POST \/api\/_x\/b\/:name" of high .+ and "POST \/api\/_x\/:id\/a" of low .+ which high answers: the higher priority wins\.$/,
    );
  });

  it("stay quiet on routes that cannot match the same request", () => {
    const { warnings } = resolved([
      {
        id: "one",
        setup: (s) => {
          s.registerRoute("GET", "/api/_x/:id", handler);
          s.registerRoute("GET", "/api/_x/:id/items", handler);
        },
      },
      {
        id: "two",
        setup: (s) => {
          s.registerRoute("POST", "/api/_x/:id", handler);
          s.registerRoute("GET", "/api/_y/:id", handler);
          s.registerRoute("GET", "/api/_x/a/b/c", handler);
        },
      },
      {
        id: "same",
        setup: (s) => {
          s.registerRoute("GET", "/api/_same/:id", handler);
          s.registerRoute("GET", "/api/_same/list", handler);
        },
      },
    ]);
    assert.deepEqual(warnings, []);
  });

  it("warn on a route whose first segment is a parameter", () => {
    const { routes, warnings } = resolved([
      { id: "pages", setup: (s) => s.registerRoute("GET", "/:slug", handler) },
    ]);
    assert.equal(routes.length, 1);
    assert.deepEqual(warnings, [
      'Frontend module pages serves "GET /:slug", whose first segment is a parameter: ' +
        "it answers every path of that shape, the pages and other modules' routes " +
        "included. Start the path with a literal segment.",
    ]);
  });

  it("warn when a route hides the backend's namespace, unless it says it means to", () => {
    const { warnings } = resolved([
      {
        id: "dms",
        setup: (server) => {
          server.registerRoute("POST", "/api/users", handler);
          server.registerRoute("POST", "/api/html/render", handler, {
            overridesBackend: true,
          });
          server.registerRoute("POST", "/api/_dms-api/tester", handler);
        },
      },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /"POST \/api\/users".+hides whatever the backend serves there/,
    );
  });

  it("warn when a route answers a public endpoint a backend module declared", () => {
    const { warnings } = resolved(
      [
        {
          id: "mailing",
          setup: (s) =>
            s.registerRoute("POST", "/api/mailing/webhook/:provider", handler, {
              overridesBackend: true,
            }),
        },
      ],
      [{ path: "/api/mailing/webhook/*" }],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /a public endpoint a backend module declared/);
  });

  it("ignore a module whose setup throws, and keep the others", () => {
    const { routes, warnings } = resolved([
      {
        id: "broken",
        setup: () => {
          throw new Error("boom");
        },
      },
      {
        id: "fine",
        setup: (s) => s.registerRoute("GET", "/api/_fine", handler),
      },
    ]);
    assert.deepEqual(
      routes.map((route: { id: string }) => route.id),
      ["fine"],
    );
    assert.match(
      warnings[0],
      /^Frontend module broken has a dms\.server\.ts that failed.+boom$/,
    );
  });
});

describe("The generated server modules loader", () => {
  it("lists the modules that have a server entry, with their priority, and types #dms/server", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-server-workspace-"));
    const auth = mkdtempSync(join(tmpdir(), "dms-server-auth-"));
    const crm = mkdtempSync(join(tmpdir(), "dms-server-crm-"));
    try {
      writeFixture(auth, SERVER_ENTRY, "export default () => {};\n");
      const layers = [
        {
          path: auth,
          packageName: "@acme/auth-frontend",
          priority: 3,
          privateOptions: { oauth: { relaySecret: "relay" } },
        },
        { path: crm, packageName: "@acme/crm-frontend", priority: 1 },
      ];
      const registry = createFrontendModuleRegistry(workspace, layers);
      assert.deepEqual(
        registry.modules.map(({ id, server }) => ({ id, server })),
        [
          { id: "acme__auth-frontend", server: SERVER_ENTRY },
          { id: "acme__crm-frontend", server: undefined },
        ],
      );
      writeFrontendModuleRegistry(workspace, layers);
      const loader = readText(join(workspace, "server-modules.generated.ts"));
      assert.match(
        loader,
        /import server0 from "\.\/frontend-modules\/acme__auth-frontend\/dms\.server\.ts";/,
      );
      assert.match(
        loader,
        /\{ id: "acme__auth-frontend", priority: 3, setup: server0 \}/,
      );
      assert.doesNotMatch(loader, /server1/);
      assert.deepEqual(
        JSON.parse(readText(join(workspace, "frontend-paths.generated.json")))
          .compilerOptions.paths["#dms/server"],
        ["./server-module.ts"],
      );
      const optionsFile = join(workspace, "generated-server-options.json");
      assert.deepEqual(JSON.parse(readText(optionsFile)).modules, {
        "acme__auth-frontend": { oauth: { relaySecret: "relay" } },
      });
      if (process.platform !== "win32")
        assert.equal(statSync(optionsFile).mode & 0o777, 0o600);
    } finally {
      for (const directory of [workspace, auth, crm])
        rmSync(directory, { recursive: true, force: true });
    }
  });
});

interface BackendCall {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((settle) => {
    if (!server?.listening) return settle();
    server.closeAllConnections();
    server.close(() => settle());
  });
}

const FIXTURE_HANDLERS = `
export function hello(event) {
  return {
    name: event.params.name,
    module: event.module.id,
    options: event.module.options,
    relaySecret: event.module.privateOptions.oauth?.relaySecret,
    origin: event.url.origin,
    query: event.url.searchParams.get("q"),
  };
}

export async function echo(event) {
  const input = await event.readJson();
  event.cookies.writeSealed("fixture_flow", { input }, { maxAge: 60, path: "/auth/fixture" });
  return input;
}

export function stream(event) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const part of ["one ", "two ", "three"]) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  event.cookies.writeSealed("fixture_seen", { seen: true });
  const headers = new Headers({ "content-type": "text/plain", "cache-control": "max-age=5" });
  headers.append("set-cookie", "plain_a=1; Path=/");
  headers.append("set-cookie", "plain_b=2; Path=/");
  return new Response(body, { status: 201, headers });
}

export async function viaBackend(event) {
  return event.backend("/api/echo", {
    method: "POST",
    body: { from: "module" },
    token: "module-token",
    headers: { "X-Forwarded-For": "1.2.3.4", "X-Fixture": "yes" },
  });
}

export async function raw(event) {
  const response = await fetch(event.backendUrl("//elsewhere.test/api/raw?x=1"));
  return { status: response.status, url: event.backendUrl("/api/raw?x=1").href };
}

export async function refused(event) {
  return event.backend("/api/refuse");
}

export function session(event) {
  return { shadowed: true, signedIn: Boolean(event.session.read()) };
}

export function empty() {
  return null;
}
`;

const FIXTURE_ENTRY = `
import { defineDmsServer } from "#dms/server";
import * as handlers from "./server/handlers";

export default defineDmsServer((server) => {
  server.registerRoute("GET", "/api/_fixture/hello/:name", handlers.hello);
  server.registerRoute("POST", "/api/_fixture/echo", handlers.echo, { bodyLimit: 64 });
  server.registerRoute("GET", "/api/_fixture/stream", handlers.stream);
  server.registerRoute("POST", "/api/_fixture/backend", handlers.viaBackend);
  server.registerRoute("GET", "/api/_fixture/refused", handlers.refused);
  server.registerRoute("GET", "/api/_fixture/raw", handlers.raw);
  server.registerRoute("GET", "/api/_fixture/empty", handlers.empty);
  server.registerRoute("GET", "/api/_auth/session", handlers.session);
  server.registerRoute("GET", "/assets/taken.js", handlers.empty);
  server.registerBackendProxy("/api/**");
});
`;

describe("Module server routes in the production server", () => {
  // Inside the repository, so the bundle and the server find their
  // dependencies installed.
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
    const server = (await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    )) as {
      handleRequestSafely: (
        request: IncomingMessage,
        response: ServerResponse,
      ) => Promise<void>;
    };
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
      // The manifest's secret wins: the environment only fills a gap.
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
    } as RequestInit);
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
    // The client headers the proxy relays reach a module's backend call too.
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

describe("Module server routes in development", () => {
  it("answers with an edited handler on the next request", async () => {
    // Resolved, because Vite reports a change under the path it resolved.
    const workspace = realpathSync(
      mkdtempSync(resolve(".server-modules-dev-")),
    );
    const { createServer: createViteServer } = await import("vite");
    let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
    let frontend: Server | undefined;
    const handlerFile = join(
      workspace,
      "frontend-modules",
      "fixture",
      "server",
      "handlers.ts",
    );
    const writeHandler = (version: string) =>
      writeFixture(
        dirname(handlerFile),
        "handlers.ts",
        `export const hello = () => ({ version: ${JSON.stringify(version)} });\n`,
      );
    try {
      cpSync("templates/vue", workspace, { recursive: true });
      writeFixture(workspace, "package.json", '{"type":"module"}');
      writeFixture(workspace, "frontend-paths.generated.json", "{}");
      writeFixture(
        workspace,
        "generated-frontend-modules.json",
        JSON.stringify({ modules: [{ id: "fixture", options: {} }] }),
      );
      writeFixture(
        workspace,
        "frontend-modules/fixture/dms.server.ts",
        'import { defineDmsServer } from "#dms/server";\nimport { hello } from "./server/handlers";\nexport default defineDmsServer((server) => server.registerRoute("GET", "/api/_fixture/version", hello));\n',
      );
      writeFixture(
        workspace,
        "server-modules.generated.ts",
        'import server0 from "./frontend-modules/fixture/dms.server.ts";\nexport const serverModules = [{ id: "fixture", priority: 0, setup: server0 }];\n',
      );
      writeHandler("v1");
      vite = await createViteServer({
        root: workspace,
        configFile: false,
        logLevel: "silent",
        appType: "custom",
        optimizeDeps: { noDiscovery: true },
        server: { middlewareMode: true, ws: false },
        resolve: {
          alias: { "#dms/server": join(workspace, "server-module.ts") },
        },
      });
      const devServer = vite;
      const { handleModuleRoute, loadServerModules } = (await import(
        pathToFileURL(join(workspace, "server", "module-server.mjs")).href
      )) as {
        handleModuleRoute: (
          request: IncomingMessage,
          response: ServerResponse,
          pathname: string,
          modules: unknown,
        ) => Promise<boolean>;
        loadServerModules: (devServer: unknown) => Promise<unknown>;
      };
      // What server.mjs does for each request in development.
      frontend = createServer(async (request, response) => {
        void handleModuleRoute(
          request,
          response,
          new URL(request.url ?? "/", "http://x").pathname,
          await loadServerModules(devServer),
        ).then((answered) => {
          if (!answered) response.writeHead(404).end();
        });
      });
      const url = `${await listen(frontend)}/api/_fixture/version`;
      const version = async () =>
        ((await (await fetch(url)).json()) as { version: string }).version;

      assert.equal(await version(), "v1");
      // Vite's watcher drops a second change to a file within 50 ms on Linux.
      await new Promise((settle) => setTimeout(settle, 100));
      writeHandler("v2");
      const deadline = Date.now() + 15_000;
      while ((await version()) !== "v2" && Date.now() < deadline)
        await new Promise((settle) => setTimeout(settle, 25));
      assert.equal(await version(), "v2");
    } finally {
      await close(frontend);
      await vite?.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("The module testing helper", () => {
  it("serves a module's routes as the frontend server does, for its own tests", async () => {
    const { serveModuleRoutes } =
      await import("../templates/vue/server/module-testing.mjs");
    const served = await serveModuleRoutes(
      [
        {
          id: "billing",
          setup: defineDmsServer((server) => {
            server.registerRoute("POST", "/api/_billing/:id", (event) => ({
              id: event.params.id,
              secret: event.module.privateOptions.secret,
              endpoints: event.app.authEstablishEndpoints,
            }));
          }),
        },
      ],
      {
        privateOptions: { billing: { secret: "s" } },
        authEstablishEndpoints: ["/api/billing/finalize"],
      },
    );
    try {
      const refused = await fetch(`${served.url}/api/_billing/7`, {
        method: "POST",
      });
      assert.equal(refused.status, 403);
      const response = await fetch(`${served.url}/api/_billing/7`, {
        method: "POST",
        headers: { origin: served.url },
      });
      assert.deepEqual(await response.json(), {
        id: "7",
        secret: "s",
        endpoints: ["/api/billing/finalize"],
      });
      assert.equal((await fetch(`${served.url}/nothing`)).status, 404);
    } finally {
      await served.close();
    }
  });

  it("keeps the dms_* sealed cookies to the module that owns sign-in, and each module's to itself", async () => {
    process.env.DMS_SESSION_SECRET ??=
      "a-test-only-session-secret-of-32-characters";
    const { serveModuleRoutes } =
      await import("../templates/vue/server/module-testing.mjs");
    const cookieRoutes = (
      server: Parameters<DmsServerSetup>[0],
      base: string,
    ) => {
      server.registerRoute("GET", `${base}/write/:name`, (event) => {
        event.cookies.writeSealed(event.params.name, { from: base });
        return null;
      });
      server.registerRoute("GET", `${base}/read/:name`, (event) => ({
        value: event.cookies.readSealed(event.params.name) ?? null,
      }));
    };
    const served = await serveModuleRoutes([
      {
        id: "dms",
        priority: 10,
        setup: defineDmsServer((server) => {
          server.registerAuth({});
          cookieRoutes(server, "/api/_dms-auth");
        }),
      },
      {
        id: "shop",
        setup: defineDmsServer((server) => cookieRoutes(server, "/api/_shop")),
      },
    ]);
    const call = async (path: string, cookie = "") => {
      const response = await fetch(`${served.url}${path}`, {
        headers: cookie ? { cookie } : {},
      });
      return {
        status: response.status,
        cookie: response.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "",
        body: response.status === 200 ? await response.json() : undefined,
      };
    };
    try {
      const account = await call("/api/_dms-auth/write/dms_account_1");
      assert.equal(account.status, 204);
      assert.match(account.cookie, /^dms_account_1_[0-9a-f]{12}=/);
      // Another module can neither read nor write the owner's cookies.
      assert.equal(
        (await call("/api/_shop/read/dms_account_1", account.cookie)).status,
        502,
      );
      assert.equal((await call("/api/_shop/write/dms_account_1")).status, 502);
      // Its own cookies carry its id, and the owner's same name is another.
      const flow = await call("/api/_shop/write/flow");
      assert.match(flow.cookie, /^shop\.flow_[0-9a-f]{12}=/);
      assert.deepEqual((await call("/api/_shop/read/flow", flow.cookie)).body, {
        value: { from: "/api/_shop" },
      });
      assert.deepEqual(
        (await call("/api/_dms-auth/read/flow", flow.cookie)).body,
        { value: null },
      );
    } finally {
      await served.close();
    }
  });

  it("fills any module's empty private options from DMS_PRIVATE_OPTIONS, the manifest's winning", async () => {
    const { privateOptionsFromJson } =
      await import("../templates/vue/server/module-server.mjs");
    const warnings: string[] = [];
    const filled = privateOptionsFromJson(
      {
        shop: {
          apiKey: "",
          region: "eu",
          retries: 5,
          hooks: { token: "" },
          keys: ["", ""],
        },
        other: { apiKey: "" },
      },
      JSON.stringify({
        shop: {
          apiKey: "from-env",
          region: "us",
          retries: "9",
          hooks: "flattened",
          keys: ["k1", "k2"],
          added: "new",
        },
        missing: { apiKey: "ignored" },
        __proto__: { polluted: "yes" },
        constructor: { polluted: "yes" },
      }),
      (message: string) => warnings.push(message),
    );
    assert.deepEqual(filled, {
      shop: {
        apiKey: "from-env",
        region: "eu",
        retries: 5,
        hooks: { token: "" },
        keys: ["k1", "k2"],
      },
      other: { apiKey: "" },
    });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.deepEqual(warnings, []);

    const untouched = { shop: { apiKey: "" } };
    privateOptionsFromJson(
      untouched,
      '["secret-in-array"]',
      (message: string) => warnings.push(message),
    );
    assert.deepEqual(untouched, { shop: { apiKey: "" } });
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes("secret-in-array"));
  });

  it("takes a secret from the environment only where the manifest has none", async () => {
    const { privateOptionsWithFallbacks } =
      await import("../templates/vue/server/module-server.mjs");
    const environment = {
      DMS_OAUTH_RELAY_SECRET: ["oauth", "relaySecret"],
      DMS_HTML_RENDER_SECRET: ["htmlRender", "serviceSecret"],
    };
    const env = {
      DMS_OAUTH_RELAY_SECRET: "relay-env",
      DMS_HTML_RENDER_SECRET: "render-env",
    };
    assert.deepEqual(
      privateOptionsWithFallbacks(
        {
          published: {
            oauth: { relaySecret: "relay-manifest" },
            htmlRender: { serviceSecret: "render-manifest" },
          },
          missing: { oauth: {}, htmlRender: { serviceSecret: "" } },
          unrelated: { other: true },
        },
        environment,
        env,
      ),
      {
        published: {
          oauth: { relaySecret: "relay-manifest" },
          htmlRender: { serviceSecret: "render-manifest" },
        },
        missing: {
          oauth: { relaySecret: "relay-env" },
          htmlRender: { serviceSecret: "render-env" },
        },
        unrelated: { other: true },
      },
    );
  });
});

import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../src/common";
import { matchModuleRoute } from "../templates/vue/server/module-routes.mjs";
import { readText } from "./helpers/files";
import {
  SERVER_ENTRY,
  writeFixture,
  resolved,
  handler,
} from "./fixtures/server-modules";

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

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchBackendProxy,
  proxyRejection,
  resolveBackendProxies,
  routingReport,
} from "../templates/vue/server/backend-proxies.mjs";
import { reportRouting } from "../templates/vue/server/cli-report.mjs";
import { resolveServerDeclarations } from "../templates/vue/server/module-routes.mjs";
import { requestOwner } from "../templates/vue/server/request-routing.mjs";
import type { DmsServerSetup } from "../templates/vue/server-module";
import { isText } from "./helpers/guards";

const handler = () => null;

function resolved(
  declarations: { id: string; priority?: number; setup: DmsServerSetup }[],
  manifest: Parameters<typeof resolveServerDeclarations>[3] = [],
) {
  const warnings: string[] = [];
  const modules = resolveServerDeclarations(
    declarations,
    (message: string) => warnings.push(message),
    [],
    manifest,
  );
  return { modules, warnings };
}

function registerResolutionTests(): void {
  void it("keep one owner per pattern, the highest-priority module's, with a warning", () => {
    const { modules, warnings } = resolved([
      {
        id: "low",
        priority: 1,
        setup: (s) => s.registerBackendProxy("/api/**"),
      },
      {
        id: "dms",
        priority: 5,
        setup: (s) => {
          s.registerBackendProxy("/api/**");
          s.registerBackendProxy("/dms/**");
          s.registerBackendProxy("/**");
        },
      },
    ]);
    assert.deepEqual(
      modules.proxies.map((proxy) => [proxy.path, proxy.owner, proxy.auth]),
      [
        ["/api/**", "Frontend module dms", "session"],
        ["/dms/**", "Frontend module dms", "session"],
      ],
    );
    assert.deepEqual(warnings, [
      'Frontend module dms declares the backend proxy "/**", which is ignored: its first segment is not literal: it would take every page.',
      'Frontend module low declares the backend proxy "/api/**", which is ignored: Frontend module dms declares it.',
    ]);
  });

  void it("add the backend modules' prefixes from the manifest, the most specific first", () => {
    const { modules, warnings } = resolved(
      [{ id: "dms", setup: (s) => s.registerBackendProxy("/api/**") }],
      [
        {
          module: "@acme/mailing",
          path: "/api/mailing/hooks/**",
          auth: "none",
        },
        { module: "@acme/media", path: "/media/**", auth: "none" },
        { module: "@acme/other", path: "/api/**" },
      ],
    );
    assert.deepEqual(
      modules.proxies.map((proxy) => proxy.path),
      ["/api/mailing/hooks/**", "/api/**", "/media/**"],
    );
    assert.equal(
      matchBackendProxy(modules.proxies, "/api/mailing/hooks/sent")?.auth,
      "none",
    );
    assert.equal(
      matchBackendProxy(modules.proxies, "/api/items")?.auth,
      "session",
    );
    assert.equal(matchBackendProxy(modules.proxies, "/apis"), undefined);
    assert.equal(matchBackendProxy(modules.proxies, "/settings"), undefined);
    assert.deepEqual(warnings, [
      'Backend module @acme/other declares the backend proxy "/api/**", which is ignored: Frontend module dms declares it.',
    ]);
  });

  void it("rank a literal segment above a wildcard tail, whatever the declaration order", () => {
    const { modules } = resolved(
      [],
      [
        { module: "@acme/any", path: "/api/*", auth: "none" },
        { module: "@acme/hooks", path: "/api/hooks" },
      ],
    );
    assert.equal(
      matchBackendProxy(modules.proxies, "/api/hooks")?.auth,
      "session",
    );
    assert.equal(
      matchBackendProxy(modules.proxies, "/api/other")?.auth,
      "none",
    );
  });
}

void describe("Backend proxy declarations", () => {
  void it("refuse a pattern that would take the pages or the renderer's paths", () => {
    for (const pattern of ["/", "/**", "/*/**", "api/**", "/api/../x"])
      assert.ok(proxyRejection(pattern, undefined), pattern);
    for (const pattern of ["/assets/**", "/node_modules/x", "/api/_dms/**"])
      assert.match(
        proxyRejection(pattern, undefined) ?? "",
        /renderer's own paths/,
      );
    const proxyRejectionFromJavaScript: Function = proxyRejection;
    const cookieAuth: unknown = proxyRejectionFromJavaScript("/api/**", {
      auth: "cookie",
    });
    assert.ok(isText(cookieAuth), "an off-contract auth mode is refused");
    assert.match(cookieAuth, /auth is not one of "session", "none"/);
    assert.equal(proxyRejection("/api/**", { auth: "none" }), undefined);
    for (const maxBodyBytes of [0, -1, 1.5])
      assert.match(
        proxyRejection("/upload/**", { maxBodyBytes }) ?? "",
        /maxBodyBytes is not a positive whole number/,
      );
    const textSize: unknown = proxyRejectionFromJavaScript("/upload/**", {
      maxBodyBytes: "1024",
    });
    assert.ok(isText(textSize), "a size given as text is refused");
    assert.match(textSize, /maxBodyBytes is not a positive whole number/);
    assert.equal(
      proxyRejection("/upload/**", { maxBodyBytes: 1024 }),
      undefined,
    );
    assert.equal(proxyRejection("/media", undefined), undefined);
  });

  registerResolutionTests();

  void it("are listed at startup with their owner and their auth", () => {
    const proxies = resolveBackendProxies(
      [{ id: "dms", pattern: "/api/**", options: undefined }],
      [{ module: "@acme/media", path: "/media/**", auth: "none" }],
      () => {},
    );
    assert.deepEqual(routingReport(proxies, 3), [
      "Routing: renderer files, then 3 module routes, then the backend proxies below, then the pages",
      "  /api/**    -> backend (session), declared by dms",
      "  /media/**  -> backend (none), declared by @acme/media",
    ]);
    assert.match(routingReport([], 0)[1], /no request reaches the backend/);
  });

  void it("are left out of a quiet run, as the Local url alone is printed", (t) => {
    const log = t.mock.method(console, "log", () => {});
    const lines = routingReport([], 0);
    const printed = (env: NodeJS.ProcessEnv) => {
      log.mock.resetCalls();
      reportRouting(lines, env);
      return log.mock.calls.map((call) => call.arguments);
    };
    assert.deepEqual(printed({ ANTELOPEJS_QUIET: "1" }), []);
    assert.deepEqual(printed({ ANTELOPEJS_QUIET: "true" }), []);
    const listed = lines.map((line) => [line]);
    assert.deepEqual(printed({}), listed);
    assert.deepEqual(printed({ ANTELOPEJS_QUIET: "" }), listed);
    assert.deepEqual(printed({ ANTELOPEJS_QUIET: "0" }), listed);
    assert.deepEqual(printed({ ANTELOPEJS_QUIET: "FALSE" }), listed);
  });
});

void describe("Request owners", () => {
  const { modules } = resolved([
    {
      id: "dms",
      setup: (s) => {
        s.registerBackendProxy("/api/**");
        s.registerRoute("GET", "/api/_auth/session", handler);
        s.registerRoute("GET", "/robots.txt", handler);
      },
    },
  ]);
  const owner = (method: string, path: string, files: string[] = []) =>
    requestOwner(method, path, modules, (pathname: string) =>
      files.includes(pathname),
    );

  void it("are the renderer first, for its own paths and the files it has", () => {
    assert.equal(owner("GET", "/@vite/client").kind, "renderer");
    assert.equal(owner("GET", "/assets/app.js").kind, "renderer");
    assert.equal(owner("GET", "/api/_dms/icons").kind, "renderer");
    assert.equal(owner("POST", "/api/_dms/icons/x.json").kind, "renderer");
    assert.equal(owner("GET", "/api/_dms/iconsets").kind, "backend");
    assert.equal(owner("GET", "/robots.txt", ["/robots.txt"]).kind, "renderer");
  });

  void it("then the module routes, whatever the method", () => {
    assert.deepEqual(owner("GET", "/robots.txt"), {
      kind: "module",
      id: "dms",
    });
    assert.deepEqual(owner("DELETE", "/api/_auth/session"), {
      kind: "module",
      id: "dms",
    });
  });

  void it("then the backend proxies, whoever asks", () => {
    for (const method of ["GET", "POST", "HEAD"])
      assert.equal(owner(method, "/api/items").kind, "backend");
  });

  void it("then the pages, a write to a page path being a 404", () => {
    assert.equal(owner("GET", "/dms/page").kind, "page");
    assert.equal(owner("HEAD", "/settings").kind, "page");
    assert.equal(owner("POST", "/auth/login").kind, "not-found");
    assert.equal(owner("GET", "/media/photo.webp").kind, "page");
  });
});

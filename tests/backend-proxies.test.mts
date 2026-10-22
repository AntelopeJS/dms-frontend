import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchBackendProxy,
  proxyRejection,
  resolveBackendProxies,
  routingReport,
} from "../templates/vue/server/backend-proxies.mjs";
import { resolveServerDeclarations } from "../templates/vue/server/module-routes.mjs";
import { requestOwner } from "../templates/vue/server/request-routing.mjs";
import type { DmsServerSetup } from "../templates/vue/server-module";

const handler = () => null;

function resolved(
  declarations: { id: string; priority?: number; setup: DmsServerSetup }[],
  manifest: { module: string; path: string; auth?: string }[] = [],
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

describe("Backend proxy declarations", () => {
  it("refuse a pattern that would take the pages or the renderer's paths", () => {
    for (const pattern of ["/", "/**", "/*/**", "api/**", "/api/../x"])
      assert.ok(proxyRejection(pattern, undefined), pattern);
    for (const pattern of ["/assets/**", "/node_modules/x", "/api/_dms/**"])
      assert.match(
        proxyRejection(pattern, undefined) ?? "",
        /renderer's own paths/,
      );
    assert.match(
      proxyRejection("/api/**", { auth: "cookie" }) ?? "",
      /auth is not one of "session", "none"/,
    );
    assert.equal(proxyRejection("/api/**", { auth: "none" }), undefined);
    for (const maxBodyBytes of [0, -1, 1.5, "1024"])
      assert.match(
        proxyRejection("/upload/**", { maxBodyBytes }) ?? "",
        /maxBodyBytes is not a positive whole number/,
      );
    assert.equal(
      proxyRejection("/upload/**", { maxBodyBytes: 1024 }),
      undefined,
    );
    assert.equal(proxyRejection("/media", undefined), undefined);
  });

  it("keep one owner per pattern, the highest-priority module's, with a warning", () => {
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

  it("add the backend modules' prefixes from the manifest, the most specific first", () => {
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

  it("are listed at startup with their owner and their auth", () => {
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
});

describe("Request owners", () => {
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

  it("are the renderer first, for its own paths and the files it has", () => {
    assert.equal(owner("GET", "/@vite/client").kind, "renderer");
    assert.equal(owner("GET", "/assets/app.js").kind, "renderer");
    assert.equal(owner("GET", "/robots.txt", ["/robots.txt"]).kind, "renderer");
  });

  it("then the module routes, whatever the method", () => {
    assert.deepEqual(owner("GET", "/robots.txt"), {
      kind: "module",
      id: "dms",
    });
    assert.deepEqual(owner("DELETE", "/api/_auth/session"), {
      kind: "module",
      id: "dms",
    });
  });

  it("then the backend proxies, whoever asks", () => {
    for (const method of ["GET", "POST", "HEAD"])
      assert.equal(owner(method, "/api/items").kind, "backend");
  });

  it("then the pages, a write to a page path being a 404", () => {
    assert.equal(owner("GET", "/dms/page").kind, "page");
    assert.equal(owner("HEAD", "/settings").kind, "page");
    assert.equal(owner("POST", "/auth/login").kind, "not-found");
    assert.equal(owner("GET", "/media/photo.webp").kind, "page");
  });
});

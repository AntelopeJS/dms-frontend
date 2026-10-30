import * as assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  copyStaticTemplates,
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../src/common";
import { resolveServerDeclarations } from "../templates/vue/server/module-routes.mjs";
import {
  routeRuleFor,
  ruleHeaders,
} from "../templates/vue/server/route-rules.mjs";
import type { DmsServerSetup } from "../templates/vue/server-module";
import { builtServer } from "./helpers/built-templates";
import { addressOf } from "./helpers/net";

const PUBLIC_CACHE = {
  public: true as const,
  maxAge: 300,
  staleWhileRevalidate: 3600,
};

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function resolved(
  declarations: { id: string; priority?: number; setup: DmsServerSetup }[],
) {
  const warnings: string[] = [];
  const { rules } = resolveServerDeclarations(declarations, (message: string) =>
    warnings.push(message),
  );
  return { rules, warnings };
}

describe("Route rule declarations", () => {
  it("merge from the least to the most specific pattern", () => {
    const { rules, warnings } = resolved([
      {
        id: "site",
        setup: (server) =>
          server.registerRouteRules({
            "/legal/**": {
              cache: PUBLIC_CACHE,
              headers: { "x-section": "legal", "x-robots-tag": "all" },
            },
            "/legal/drafts/*": {
              cache: false,
              headers: { "x-robots-tag": "noindex" },
            },
            "/builder/**": { ssr: false },
          }),
      },
    ]);
    assert.deepEqual(warnings, []);
    assert.deepEqual(routeRuleFor(rules, "/legal"), {
      cache: PUBLIC_CACHE,
      headers: { "x-section": "legal", "x-robots-tag": "all" },
    });
    assert.deepEqual(routeRuleFor(rules, "/legal/drafts/next"), {
      cache: false,
      headers: { "x-section": "legal", "x-robots-tag": "noindex" },
    });
    assert.deepEqual(routeRuleFor(rules, "/builder/flows/1"), {
      ssr: false,
      headers: {},
    });
    assert.deepEqual(routeRuleFor(rules, "/dashboard"), { headers: {} });
  });

  it("keep the higher-priority module's rule for one pattern, and say so", () => {
    const { rules, warnings } = resolved([
      {
        id: "low",
        priority: 1,
        setup: (s) => s.registerRouteRules({ "/x": { ssr: false } }),
      },
      {
        id: "high",
        priority: 9,
        setup: (s) => s.registerRouteRules({ "/x": { cache: PUBLIC_CACHE } }),
      },
    ]);
    assert.deepEqual(routeRuleFor(rules, "/x"), {
      cache: PUBLIC_CACHE,
      headers: {},
    });
    assert.deepEqual(warnings, [
      'Frontend module low declares the route rule "/x", which is ignored: high (priority 9) declares it.',
    ]);
  });

  it("ignore a malformed rule with a warning", () => {
    const { rules, warnings } = resolved([
      {
        id: "site",
        setup: (server) =>
          server.registerRouteRules({
            "legal/**": { ssr: false },
            "/a": { ssr: true as never },
            "/b": { headers: { "cache-control": "public" } },
            "/c": { headers: { "bad header": "x" } },
            "/d": { cache: { public: true, maxAge: -1 } },
            "/e": { cache: { maxAge: 10 } as never },
          }),
      },
    ]);
    assert.deepEqual(rules, []);
    assert.equal(warnings.length, 6);
    assert.match(warnings[2], /the server sets "cache-control" itself/);
  });

  it("ignore a header value that would split the answer", () => {
    const { rules, warnings } = resolved([
      {
        id: "site",
        setup: (server) =>
          server.registerRouteRules({
            "/a": { headers: { "x-a": "ok\r\nset-cookie: stolen=1" } },
            "/b": { headers: { "x-b": "line\nbreak" } },
            "/c": { headers: { "x-c": "nul\u0000" } },
            "/d": { headers: { "x-d": "tab\tkept" } },
          }),
      },
    ]);
    assert.deepEqual(
      rules.map(
        (rule: { pattern: { pattern: string } }) => rule.pattern.pattern,
      ),
      ["/d"],
    );
    assert.equal(warnings.length, 3);
    assert.match(warnings[0], /"x-a" is not a header with a text value/);
  });
});

describe("Route rule headers", () => {
  const rule = { cache: PUBLIC_CACHE, headers: { "x-section": "legal" } };
  const anonymous = { method: "GET", headers: {} };

  it("make a cookie-less visit to a public page publicly cacheable", () => {
    assert.deepEqual(
      ruleHeaders(rule, anonymous, { publicAccess: true }, 200),
      {
        "x-section": "legal",
        "cache-control": "public, max-age=300, stale-while-revalidate=3600",
        vary: "X-Inertia, Cookie",
      },
    );
  });

  it("keep everything else private", () => {
    const privateCases: [unknown, unknown, number][] = [
      [
        { method: "GET", headers: { cookie: "dms_locale=fr" } },
        { publicAccess: true },
        200,
      ],
      [
        { method: "GET", headers: { "x-content-language": "fr" } },
        { publicAccess: true },
        200,
      ],
      [anonymous, { publicAccess: false }, 200],
      [anonymous, undefined, 200],
      [anonymous, { publicAccess: true }, 500],
    ];
    for (const [request, route, status] of privateCases)
      assert.deepEqual(ruleHeaders(rule, request, route, status), {
        "x-section": "legal",
      });
  });
});

const FIXTURE_ENTRY = `
import { defineDmsServer } from "#dms/server";

export default defineDmsServer((server) => {
  server.registerRouteRules({
    "/legal/**": { cache: { public: true, maxAge: 300 }, headers: { "x-section": "legal" } },
    "/builder/**": { ssr: false },
  });
});
`;

const SSR_RENDERER = `
export async function renderDmsPage() {
  return { body: '<p data-server-rendered="true">server rendered</p>', head: { headTags: "<title>Rendered</title>", htmlAttrs: "", bodyAttrs: "" }, overlays: "" };
}
export function registerDmsIconCollections() {}
export function isDmsFrontendPage() { return false; }
`;

describe("Route rules in the production server", () => {
  const workspace = realpathSync(mkdtempSync(resolve(".server-route-rules-")));
  const source = mkdtempSync(join(tmpdir(), "dms-rules-fixture-"));
  let backend: Server | undefined;
  let frontend: Server | undefined;
  let frontendUrl = "";
  const environment = {
    DMS_API_BASE_URL: process.env.DMS_API_BASE_URL,
    DMS_SESSION_SECRET: process.env.DMS_SESSION_SECRET,
  };

  before(async () => {
    backend = createServer((request, response) => {
      const path = new URL(
        request.url ?? "/",
        "http://backend",
      ).searchParams.get("path");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          route: {
            publicAccess:
              path?.startsWith("/legal") || path?.startsWith("/builder"),
          },
          layout: {},
        }),
      );
    });
    await new Promise<void>((settle) =>
      backend!.listen(0, "127.0.0.1", settle),
    );
    const backendAddress = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    process.env.DMS_SESSION_SECRET =
      "a-test-only-session-secret-of-32-characters";

    writeFixture(source, "dms.server.ts", FIXTURE_ENTRY);
    copyStaticTemplates(workspace);
    writeFixture(workspace, "package.json", '{"type":"module"}');
    writeFixture(workspace, "dist/ssr/ssr-renderer.js", SSR_RENDERER);
    const layers = [{ path: source, packageName: "@acme/site-frontend" }];
    const registry = createFrontendModuleRegistry(workspace, layers);
    cpSync(source, registry.modules[0].root, { recursive: true });
    writeFrontendModuleRegistry(workspace, layers);
    const { build } = await import("vite");
    await build({
      configFile: join(workspace, "vite.server.config.ts"),
      root: workspace,
      logLevel: "silent",
    });
    const server = await builtServer(workspace);
    frontend = createServer((request, response) => {
      void server.handleRequestSafely(request, response);
    });
    await new Promise<void>((settle) =>
      frontend!.listen(0, "127.0.0.1", settle),
    );
    const address = addressOf(frontend);
    frontendUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const server of [frontend, backend]) {
      server?.closeAllConnections();
      await new Promise((settle) => server?.close(settle));
    }
    for (const [name, value] of Object.entries(environment))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  const visit = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${frontendUrl}${path}`, {
      headers: { accept: "text/html", ...headers },
    });

  it("serves a cookie-less public page with the rule's cache and headers, document and Inertia alike", async () => {
    for (const headers of [{}, { "x-inertia": "true" }]) {
      const response = await visit("/legal/terms", headers);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("cache-control"),
        "public, max-age=300",
      );
      assert.match(response.headers.get("vary") ?? "", /^X-Inertia, Cookie\b/);
      assert.equal(response.headers.get("x-section"), "legal");
    }
  });

  it("keeps the same page private for a visitor with any cookie", async () => {
    const response = await visit("/legal/terms", { cookie: "dms_locale=fr" });
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.equal(response.headers.get("x-section"), "legal");
  });

  it("keeps pages without a rule as they were", async () => {
    const response = await visit("/dashboard");
    assert.equal(response.headers.get("cache-control"), "private, no-cache");
    assert.match(await response.text(), /server rendered/);
  });

  it("gives an ssr: false page the client-rendered shell", async () => {
    const html = await (await visit("/builder/flows")).text();
    assert.doesNotMatch(html, /server rendered/);
    assert.match(html, /<script data-page="app" type="application\/json">/);
    assert.match(html, /<div id="app"><\/div>/);
  });
});

import * as assert from "node:assert/strict";
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  type DmsServerSetup,
  defineDmsServer,
} from "../templates/vue/server-module";
import { writeFixture, listen, close } from "./fixtures/server-modules";

describe("Module server routes in development", () => {
  it("answers with an edited handler on the next request", async () => {
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
      assert.equal(
        (await call("/api/_shop/read/dms_account_1", account.cookie)).status,
        502,
      );
      assert.equal((await call("/api/_shop/write/dms_account_1")).status, 502);
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

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import "./fixtures/dms-backend-proxies.mts";

// A backend redirect is the browser's to follow. Followed by the proxy, a
// redirect to another site served that site's page, and its cookies, from the
// dashboard's origin.

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

interface ServedModules {
  url: string;
  close: () => Promise<void>;
}

interface ModuleEvent {
  backend: (path: string) => Promise<unknown>;
  backendUrl: (path: string) => URL;
}

interface ModuleServer {
  registerRoute: (
    method: string,
    path: string,
    handler: (event: ModuleEvent) => unknown,
  ) => void;
}

const ENVIRONMENT = [
  "DMS_API_BASE_URL",
  "DMS_PUBLIC_ENDPOINTS",
  "DMS_SESSION_SECRET",
] as const;
const REDIRECT_STATUSES = [302, 303, 307] as const;
const BACKEND_COOKIE = "backend=1; Path=/";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

describe("backend redirects", () => {
  const previous = Object.fromEntries(
    ENVIRONMENT.map((name) => [name, process.env[name]]),
  );
  let thirdPartyCalls = 0;
  const thirdParty = createServer((_request, response) => {
    thirdPartyCalls += 1;
    response.writeHead(200, {
      "content-type": "text/html",
      "set-cookie": "NID=tracking; Path=/",
    });
    response.end("<p>third party</p>");
  });
  let thirdPartyUrl = "";
  let backendUrl = "";
  const backend = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://backend.local");
    const status = Number(url.searchParams.get("status") ?? 302);
    const location = {
      "/api/maps": `${thirdPartyUrl}/maps/place?q=1`,
      "/api/public/hook": `${thirdPartyUrl}/maps/place?q=1`,
      "/api/internal": `${backendUrl}/api/target?from=internal#top`,
      "/api/relative": "target?from=relative",
      "/api/climbing": `${backendUrl}//elsewhere.test/x`,
    }[url.pathname];
    if (location) {
      response.writeHead(status, { location, "set-cookie": BACKEND_COOKIE });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"reached":"${url.pathname}"}`);
  });
  let frontend: Server | undefined;
  let frontendUrl = "";

  before(async () => {
    thirdPartyUrl = await listen(thirdParty);
    backendUrl = await listen(backend);
    process.env.DMS_API_BASE_URL = backendUrl;
    process.env.DMS_PUBLIC_ENDPOINTS = JSON.stringify([
      { path: "/api/public/hook" },
    ]);
    process.env.DMS_SESSION_SECRET ??=
      "a-test-only-session-secret-of-32-characters";
    const runtime =
      (await import("../templates/vue/server.mjs")) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    frontendUrl = await listen(frontend);
  });

  beforeEach(() => {
    thirdPartyCalls = 0;
  });

  after(() => {
    for (const name of ENVIRONMENT)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    frontend?.closeAllConnections();
    frontend?.close();
    backend.close();
    thirdParty.close();
  });

  /** What the browser gets for `path`, without following a redirect. */
  function visit(path: string, init: RequestInit = {}) {
    return fetch(`${frontendUrl}${path}`, { redirect: "manual", ...init });
  }

  describe("through a backend proxy", () => {
    for (const status of REDIRECT_STATUSES) {
      it(`relays a ${status} to another site as the backend sent it`, async () => {
        const method = status === 307 ? "POST" : "GET";
        const response = await visit(`/api/maps?status=${status}`, {
          method,
          headers: { origin: frontendUrl },
          body: method === "POST" ? "{}" : undefined,
        });
        assert.equal(response.status, status);
        assert.equal(
          response.headers.get("location"),
          `${thirdPartyUrl}/maps/place?q=1`,
        );
        assert.deepEqual(response.headers.getSetCookie(), [BACKEND_COOKIE]);
        assert.doesNotMatch(await response.text(), /third party/);
        assert.equal(thirdPartyCalls, 0);
      });

      it(`relays a ${status} on the backend's origin as a path on the frontend's`, async () => {
        const response = await visit(`/api/internal?status=${status}`);
        assert.equal(response.status, status);
        assert.equal(
          response.headers.get("location"),
          "/api/target?from=internal#top",
        );
        assert.deepEqual(response.headers.getSetCookie(), [BACKEND_COOKIE]);
      });
    }

    it("relays a relative Location, which already names the frontend's path", async () => {
      const response = await visit("/api/relative");
      assert.equal(response.status, 302);
      assert.equal(
        new URL(response.headers.get("location") ?? "", `${frontendUrl}/api/x`)
          .href,
        `${frontendUrl}/api/target?from=relative`,
      );
    });

    it("keeps a backend path that starts with // a path on the frontend", async () => {
      const response = await visit("/api/climbing");
      const location = response.headers.get("location") ?? "";
      assert.equal(new URL(location, frontendUrl).origin, frontendUrl);
      assert.equal(
        new URL(location, frontendUrl).pathname,
        "//elsewhere.test/x",
      );
    });

    it("leaves an answer that is no redirect as it was", async () => {
      const response = await visit("/api/target");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("location"), null);
      assert.deepEqual(await response.json(), { reached: "/api/target" });
    });
  });

  it("relays a public endpoint's redirect without following it", async () => {
    const response = await visit("/api/public/hook?status=307", {
      method: "POST",
      body: "{}",
    });
    assert.equal(response.status, 307);
    assert.equal(
      response.headers.get("location"),
      `${thirdPartyUrl}/maps/place?q=1`,
    );
    assert.equal(thirdPartyCalls, 0);
  });

  describe("from a module route", () => {
    let served: ServedModules | undefined;

    before(async () => {
      const { serveModuleRoutes } =
        await import("../templates/vue/server/module-testing.mjs");
      served = (await serveModuleRoutes([
        {
          id: "relay",
          setup: (server: ModuleServer) => {
            server.registerRoute("GET", "/api/_relay/json", (event) =>
              event.backend("/api/maps?status=302"),
            );
            server.registerRoute("GET", "/api/_relay/raw", (event) =>
              fetch(event.backendUrl("/api/internal?status=303"), {
                redirect: "manual",
              }),
            );
            server.registerRoute("GET", "/api/_relay/followed", (event) =>
              fetch(event.backendUrl("/api/maps?status=302")),
            );
            server.registerRoute(
              "GET",
              "/api/_relay/own",
              () =>
                new Response(null, {
                  status: 302,
                  headers: { location: `${backendUrl}/api/target` },
                }),
            );
          },
        },
      ])) as ServedModules;
    });

    after(() => served?.close());

    it("refuses a redirect to backend(), a JSON call, without following it", async () => {
      const originalError = console.error;
      console.error = () => {};
      try {
        const response = await fetch(`${served?.url}/api/_relay/json`, {
          redirect: "manual",
        });
        assert.equal(response.status, 502);
        assert.deepEqual(await response.json(), {
          message: "error.500.description",
        });
      } finally {
        console.error = originalError;
      }
      assert.equal(thirdPartyCalls, 0);
    });

    it("relays a backend redirect a route returns, on the frontend's origin", async () => {
      const response = await fetch(`${served?.url}/api/_relay/raw`, {
        redirect: "manual",
      });
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get("location"),
        "/api/target?from=internal#top",
      );
      assert.deepEqual(response.headers.getSetCookie(), [BACKEND_COOKIE]);
    });

    it("drops the cookies of another site a route's fetch was redirected to", async () => {
      const response = await fetch(`${served?.url}/api/_relay/followed`, {
        redirect: "manual",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(response.headers.getSetCookie(), []);
    });

    it("leaves a Location the route wrote itself as it is", async () => {
      const response = await fetch(`${served?.url}/api/_relay/own`, {
        redirect: "manual",
      });
      assert.equal(
        response.headers.get("location"),
        `${backendUrl}/api/target`,
      );
    });
  });
});

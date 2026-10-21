import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import "./fixtures/dms-backend-proxies.mts";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

interface SessionTemplate {
  writeSession: (response: unknown, session: Record<string, unknown>) => void;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function sessionCookie(
  session: Record<string, unknown>,
): Promise<string> {
  const { writeSession } =
    (await import("../templates/vue/server/auth/session.mjs")) as SessionTemplate;
  const headers = new Map<string, string | string[]>();
  writeSession(
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

/**
 * The backend checks where a beacon comes from and limits each client: the
 * proxy tells it the Origin, the Referer and the client's address, which no
 * caller can make up unless a trusted reverse proxy stands in front.
 */
describe("the proxy forwards who is asking", () => {
  const previous = {
    backend: process.env.DMS_API_BASE_URL,
    endpoints: process.env.DMS_PUBLIC_ENDPOINTS,
    hops: process.env.DMS_TRUSTED_PROXY_HOPS,
    secret: process.env.DMS_SESSION_SECRET,
  };
  let received: IncomingHttpHeaders = {};
  const backend = createServer((request, response) => {
    received = request.headers;
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  let frontendUrl = "";
  let frontend: Server | undefined;

  before(async () => {
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    process.env.DMS_PUBLIC_ENDPOINTS = JSON.stringify([
      { path: "/api/tracker/beacon", headers: ["x-tracker-site"] },
    ]);
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    const runtime =
      (await import("../templates/vue/server.mjs")) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    frontendUrl = `http://127.0.0.1:${await listen(frontend)}`;
  });

  beforeEach(() => {
    received = {};
    delete process.env.DMS_TRUSTED_PROXY_HOPS;
  });

  after(() => {
    for (const [name, value] of Object.entries({
      DMS_API_BASE_URL: previous.backend,
      DMS_PUBLIC_ENDPOINTS: previous.endpoints,
      DMS_TRUSTED_PROXY_HOPS: previous.hops,
      DMS_SESSION_SECRET: previous.secret,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    frontend?.close();
    backend.close();
  });

  it("sends a public endpoint the Origin, the Referer and the client, never the session", async () => {
    const cookie = await sessionCookie({
      accessToken: "access",
      accountId: "account-a",
      user: { id: "account-a" },
    });
    const response = await fetch(`${frontendUrl}/api/tracker/beacon`, {
      method: "POST",
      headers: {
        cookie,
        origin: "https://shop.example.test",
        referer: "https://shop.example.test/cart?step=2",
        "x-tracker-site": "shop",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "spoofed.example.test",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(received.origin, "https://shop.example.test");
    assert.equal(received.referer, "https://shop.example.test/cart?step=2");
    assert.equal(received["x-tracker-site"], "shop");
    // No trusted proxy: what the caller wrote is not believed.
    assert.equal(received["x-forwarded-for"], "127.0.0.1");
    assert.equal(received["x-forwarded-proto"], "http");
    assert.equal(received["x-forwarded-host"], new URL(frontendUrl).host);
    assert.equal(received.authorization, undefined);
    assert.equal(received.cookie, undefined);
  });

  it("appends the client to the chain a trusted reverse proxy sent", async () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    const response = await fetch(`${frontendUrl}/api/items`, {
      headers: {
        "x-forwarded-for": "198.51.100.7",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "app.example.test",
      },
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(received["x-forwarded-for"], "198.51.100.7, 127.0.0.1");
    assert.equal(received["x-forwarded-proto"], "https");
    assert.equal(received["x-forwarded-host"], "app.example.test");
  });

  it("relays the time zone and every realtime header, and no other custom header", async () => {
    const response = await fetch(`${frontendUrl}/api/items`, {
      headers: {
        "x-time-zone": "Europe/Brussels",
        "x-realtime-session": "session-1",
        "x-realtime-connection": "connection-7",
        "x-realtimeish": "not a realtime header",
        "x-custom": "dropped",
      },
    });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(received["x-time-zone"], "Europe/Brussels");
    assert.equal(received["x-realtime-session"], "session-1");
    assert.equal(received["x-realtime-connection"], "connection-7");
    assert.equal(received["x-realtimeish"], undefined);
    assert.equal(received["x-custom"], undefined);
  });

  it("sets the client alone on a request no proxy forwarded", async () => {
    const response = await fetch(`${frontendUrl}/api/items`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
    assert.equal(received["x-forwarded-for"], "127.0.0.1");
    assert.equal(received.origin, undefined);
    assert.equal(received.referer, undefined);
  });
});

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { backend } from "../templates/vue/server/auth/backend.mjs";
import { clientCountryHeader } from "../templates/vue/server/auth/client-ip.mjs";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

const ENVIRONMENT = [
  "DMS_API_BASE_URL",
  "DMS_COUNTRY_HEADER",
  "DMS_TRUSTED_PROXY_HOPS",
] as const;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function request(headers: Record<string, string>) {
  return { headers, socket: { remoteAddress: "10.0.0.2" } };
}

describe("client country header", () => {
  const previous = Object.fromEntries(
    ENVIRONMENT.map((name) => [name, process.env[name]]),
  );
  const received: IncomingHttpHeaders[] = [];
  const api = createServer((incoming, response) => {
    received.push(incoming.headers);
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"requires_2fa":true}');
  });
  let frontend: Server | undefined;
  let base = "";

  before(async () => {
    process.env.DMS_API_BASE_URL = await listen(api);
    const runtime = (await import(
      pathToFileURL(join(process.cwd(), "templates", "vue", "server.mjs")).href
    )) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    base = await listen(frontend);
  });

  afterEach(() => {
    received.length = 0;
    delete process.env.DMS_COUNTRY_HEADER;
    delete process.env.DMS_TRUSTED_PROXY_HOPS;
  });

  after(() => {
    for (const name of ENVIRONMENT)
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    frontend?.close();
    api.close();
  });

  it("relays CF-IPCountry from a trusted proxy by default", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    assert.deepEqual(clientCountryHeader(request({ "cf-ipcountry": " FR " })), {
      "cf-ipcountry": "FR",
    });
  });

  it("relays the header DMS_COUNTRY_HEADER names instead", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    process.env.DMS_COUNTRY_HEADER = "X-Country-Code";
    assert.deepEqual(
      clientCountryHeader(
        request({ "cf-ipcountry": "FR", "x-country-code": "BR" }),
      ),
      { "x-country-code": "BR" },
    );
  });

  it("relays nothing without a trusted proxy, since any caller can set it", () => {
    assert.deepEqual(
      clientCountryHeader(request({ "cf-ipcountry": "FR" })),
      {},
    );
  });

  it("relays nothing when DMS_COUNTRY_HEADER is empty or not a header name", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    for (const name of ["", "  ", "bad header", "x-country:"]) {
      process.env.DMS_COUNTRY_HEADER = name;
      assert.deepEqual(
        clientCountryHeader(request({ "cf-ipcountry": "FR" })),
        {},
      );
    }
  });

  it("relays nothing when the request has no value", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    assert.deepEqual(clientCountryHeader(request({})), {});
    assert.deepEqual(clientCountryHeader(request({ "cf-ipcountry": " " })), {});
  });

  it("sends the country to the backend with the client address", async () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    await backend(
      "/api/auth/login",
      request({
        "cf-ipcountry": "FR",
        "x-forwarded-for": "203.0.113.7",
        "x-unrelated": "dropped",
      }),
      { method: "POST", body: {} },
    );
    assert.equal(received[0]["cf-ipcountry"], "FR");
    assert.equal(received[0]["x-forwarded-for"], "203.0.113.7");
    assert.equal(received[0]["x-unrelated"], undefined);
  });

  it("never lets the country header replace a header the relay sets", async () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    process.env.DMS_COUNTRY_HEADER = "X-Forwarded-For";
    await backend(
      "/api/auth/login",
      request({ "x-forwarded-for": "198.51.100.1, 203.0.113.7" }),
      { method: "POST", body: {} },
    );
    assert.equal(received[0]["x-forwarded-for"], "203.0.113.7");
  });

  it("forwards the country on a sign-in through the frontend server", async () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: {
        "cf-ipcountry": "BR",
        "content-type": "application/json",
        origin: base,
      },
      body: '{"email":"member@example.test","password":"secret"}',
    });
    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0]["cf-ipcountry"], "BR");
  });

  it("forwards the country on a proxied API request", async () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    const response = await fetch(`${base}/api/items`, {
      headers: { "cf-ipcountry": "FR" },
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    assert.equal(received.length, 1);
    assert.equal(received[0]["cf-ipcountry"], "FR");
  });

  it("drops the country on a proxied request without a trusted proxy", async () => {
    const response = await fetch(`${base}/api/items`, {
      headers: { "cf-ipcountry": "FR" },
    });
    await response.body?.cancel();
    assert.equal(received.length, 1);
    assert.equal(received[0]["cf-ipcountry"], undefined);
  });
});

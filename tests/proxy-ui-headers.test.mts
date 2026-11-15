import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import "./fixtures/dms-backend-proxies.mts";
import { requestOf } from "./helpers/http-doubles";
import { addressOf } from "./helpers/net";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return addressOf(server).port;
}

/** The `x-dms-ui-*` headers among `headers`. */
function uiHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.startsWith("x-dms-ui-")),
  );
}

/** The `x-dms-ui-*` headers the backend gets from a server render's read that relays the client's header, then from one that sets its own. */
async function checkServerRenderReads(
  received: () => IncomingHttpHeaders,
): Promise<[IncomingHttpHeaders, IncomingHttpHeaders]> {
  const { serverComponentFetch } =
    await import("../templates/vue/server/backend-request.mjs");
  await serverComponentFetch(
    requestOf({
      headers: { "x-dms-ui-assistant": "1" },
      remoteAddress: "127.0.0.1",
    }),
  )("/api/items", { headers: { "X-Dms-Ui-Other": "made up" } });
  const relayed = uiHeaders(received());
  await serverComponentFetch(requestOf({ remoteAddress: "127.0.0.1" }))(
    "/api/items",
    { headers: { "x-dms-ui-assistant": "made up" } },
  );
  return [relayed, uiHeaders(received())];
}

/** The `x-dms-ui-*` headers the backend gets from a server route that relays the client's header, then from one that sets its own. */
async function checkServerRoutes(
  received: () => IncomingHttpHeaders,
): Promise<[IncomingHttpHeaders, IncomingHttpHeaders]> {
  const { backend: callBackend } =
    await import("../templates/vue/server/auth/backend.mjs");
  const request = requestOf({
    headers: { "x-dms-ui-assistant": "1" },
    remoteAddress: "127.0.0.1",
  });
  await callBackend("/api/items", request, {
    headers: { "X-Dms-Ui-Other": "made up" },
  });
  const relayed = uiHeaders(received());
  await callBackend("/api/items", requestOf({ remoteAddress: "127.0.0.1" }), {
    headers: { "x-dms-ui-assistant": "made up" },
  });
  return [relayed, uiHeaders(received())];
}

void describe("the relay forwards the x-dms-ui-* headers a module's client code sets", () => {
  const previous = {
    backend: process.env.DMS_API_BASE_URL,
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

  async function send(path: string, init: RequestInit = {}): Promise<void> {
    const response = await fetch(`${frontendUrl}${path}`, init);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }

  before(async () => {
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    const runtime = await import("../templates/vue/server.mjs");
    frontend = createServer(runtime.handleRequestSafely);
    frontendUrl = `http://127.0.0.1:${await listen(frontend)}`;
  });

  beforeEach(() => {
    received = {};
  });

  after(() => {
    for (const [name, value] of Object.entries({
      DMS_API_BASE_URL: previous.backend,
      DMS_SESSION_SECRET: previous.secret,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    frontend?.close();
    backend.close();
  });

  void it("relays the header of a same-origin request, and of a client that is no browser", async () => {
    await send("/api/assistant/connections", {
      method: "POST",
      headers: {
        origin: frontendUrl,
        "sec-fetch-site": "same-origin",
        "x-dms-ui-assistant": "1",
        "content-type": "application/json",
      },
      body: "{}",
    });
    assert.deepEqual(uiHeaders(received), { "x-dms-ui-assistant": "1" });
    await send("/api/items", { headers: { "x-dms-ui-assistant": "1" } });
    assert.deepEqual(uiHeaders(received), { "x-dms-ui-assistant": "1" });
  });

  void it("sends no such header when the client sent none, and makes none up from a query, a cookie or a form field", async () => {
    await send("/api/items?x-dms-ui-assistant=1", {
      method: "POST",
      headers: {
        origin: frontendUrl,
        "sec-fetch-site": "same-origin",
        cookie: "x-dms-ui-assistant=1",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "x-dms-ui-assistant=1",
    });
    assert.deepEqual(uiHeaders(received), {});
  });

  void it("drops the header of a request the browser sent from another origin or site", async () => {
    await send("/api/items", {
      headers: {
        origin: "https://pages.example.test",
        "sec-fetch-site": "cross-site",
        "x-dms-ui-assistant": "1",
      },
    });
    assert.deepEqual(uiHeaders(received), {});
    await send("/api/items", {
      headers: { "sec-fetch-site": "same-site", "x-dms-ui-assistant": "1" },
    });
    assert.deepEqual(uiHeaders(received), {});
    await send("/api/items", {
      headers: {
        origin: "https://dashboard.example.test",
        "x-dms-ui-assistant": "1",
      },
    });
    assert.deepEqual(uiHeaders(received), {});
  });

  void it("lets a server render's read relay the client's header and add none of its own", async () => {
    assert.deepEqual(await checkServerRenderReads(() => received), [
      { "x-dms-ui-assistant": "1" },
      {},
    ]);
  });

  void it("lets a server route relay the client's header and add none of its own", async () => {
    assert.deepEqual(await checkServerRoutes(() => received), [
      { "x-dms-ui-assistant": "1" },
      {},
    ]);
  });
});

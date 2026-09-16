import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { after, before, beforeEach, test } from "node:test";
import { handleTester } from "../templates/vue/server/tester.mjs";
import { writeSession } from "../templates/vue/server/auth/session.mjs";

const ACCESS_TOKEN = 'private/owner"access?token';
const REFRESH_TOKEN = 'private\\refresh"token';
const BODY_LIMIT = 64 * 1024;
const calls = [];
const servers = [];
const originalEnvironment = { ...process.env };
let frontend;
let backend;
let cookie;
let owner = true;
let ownerStatus = 200;

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(request, response) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  calls.push({
    path: request.url,
    method: request.method,
    headers: request.headers,
    body: Buffer.concat(chunks).toString(),
  });
  if (request.url === "/api/auth/me") {
    response.writeHead(ownerStatus, { location: "/unexpected-owner-redirect" });
    return response.end(JSON.stringify({ owner }));
  }
  if (request.url === "/api/network-error") return request.socket.destroy();
  if (request.url === "/api/large")
    return response.end("a".repeat(BODY_LIMIT + 1));
  if (request.url === "/api/redirect") {
    response.writeHead(302, {
      location: `${frontend}/unexpected-redirect`,
      "set-cookie": "upstream=secret",
    });
    return response.end("redirect response");
  }
  response.writeHead(422, {
    "x-result": "fixture",
    "set-cookie": "upstream=secret",
    "x-reflected": ACCESS_TOKEN,
    "x-reflected-uri": encodeURIComponent(ACCESS_TOKEN),
    "x-reflected-json": JSON.stringify(REFRESH_TOKEN).slice(1, -1),
    connection: "x-hop",
    "x-hop": "hidden",
  });
  response.end(
    [
      request.method,
      request.url,
      Buffer.concat(chunks),
      ACCESS_TOKEN,
      REFRESH_TOKEN,
      encodeURIComponent(ACCESS_TOKEN),
      JSON.stringify(REFRESH_TOKEN).slice(1, -1),
    ].join(":"),
  );
}

before(async () => {
  process.env.DMS_SESSION_SECRET =
    "disposable-fixture-secret-at-least-32-characters";
  process.env.DMS_TRUSTED_PROXY_HOPS = "0";
  backend = await listen(fixture);
  process.env.DMS_API_BASE_URL = `${backend}/ignored-configured-base-path/`;
  frontend = await listen(handleTester);
  const headers = new Map();
  writeSession(
    {
      getHeader: (name) => headers.get(name),
      setHeader: (name, value) => headers.set(name, value),
    },
    {
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      user: { owner: false },
    },
  );
  cookie = headers.get("set-cookie").split(";")[0];
});

beforeEach(() => {
  calls.length = 0;
  owner = true;
  ownerStatus = 200;
});
after(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
  for (const key of [
    "DMS_SESSION_SECRET",
    "DMS_TRUSTED_PROXY_HOPS",
    "DMS_API_BASE_URL",
  ]) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
});

async function invoke(input = {}, headers = {}, method = "POST") {
  const requestBody =
    method === "POST"
      ? JSON.stringify({
          path: "/api/echo",
          method: "GET",
          headers: {},
          useSession: true,
          ...input,
        })
      : undefined;
  const requestOptions: RequestInit = {
    method,
    headers: {
      origin: frontend,
      cookie,
      "content-type": "application/json",
      ...headers,
    },
  };
  if (requestBody !== undefined) requestOptions.body = requestBody;
  const response = await fetch(`${frontend}/api/_dms/tester`, requestOptions);
  return { response, data: await response.json() };
}

test("injects private session only when enabled and redacts reflected credentials", async () => {
  const { response, data } = await invoke();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(calls[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[1].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[1].headers["x-antelopejs-namespace"], "default");
  assert.equal(data.status, 422);
  assert.equal(
    data.body,
    "GET:/api/echo::[REDACTED]:[REDACTED]:[REDACTED]:[REDACTED]",
  );
  assert.equal(data.headers["x-result"], "fixture");
  assert.equal(data.headers["x-reflected"], "[REDACTED]");
  assert.equal(data.headers["x-reflected-uri"], "[REDACTED]");
  assert.equal(data.headers["x-reflected-json"], "[REDACTED]");
  assert.equal(data.headers["set-cookie"], undefined);
  assert.equal(data.headers["x-hop"], undefined);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("anonymous forwarding still authenticates the owner with the stored credential", async () => {
  const { response } = await invoke({ useSession: false });
  assert.equal(response.status, 200);
  assert.equal(calls[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers["x-antelopejs-namespace"], undefined);
});

test("manual mixed-case or empty authorization overrides session in either toggle state", async () => {
  for (const useSession of [true, false]) {
    for (const authorization of ["Bearer manual", ""]) {
      calls.length = 0;
      await invoke({
        useSession,
        headers: {
          AuThOrIzAtIoN: authorization,
          "X-Antelopejs-Namespace": "custom",
        },
      });
      assert.equal(calls[0].headers.authorization, `Bearer ${ACCESS_TOKEN}`);
      assert.equal(calls[1].headers.authorization, authorization);
      assert.equal(calls[1].headers["x-antelopejs-namespace"], "custom");
    }
  }
});

test("rejects absent, forged, non-owner and revoked sessions regardless of outbound credentials", async () => {
  for (const invalidCookie of ["", "dms_session=forged"]) {
    assert.equal(
      (
        await invoke(
          { useSession: false, headers: { authorization: "Bearer manual" } },
          { cookie: invalidCookie },
        )
      ).response.status,
      401,
    );
    assert.equal(calls.length, 0);
  }
  for (const value of [false, "true", 1, null]) {
    owner = value;
    assert.equal((await invoke({ useSession: false })).response.status, 403);
  }
  owner = true;
  ownerStatus = 401;
  assert.equal((await invoke()).response.status, 403);
  ownerStatus = 302;
  assert.equal((await invoke()).response.status, 403);
  assert.ok(calls.every((call) => call.path === "/api/auth/me"));
});

test("requires same-origin POST before any backend traffic", async () => {
  for (const origin of ["", "https://attacker.invalid", "null"]) {
    assert.equal(
      (await invoke({}, { origin, "x-forwarded-host": "attacker.invalid" }))
        .response.status,
      403,
    );
  }
  const { response } = await invoke({}, {}, "GET");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal(calls.length, 0);
});

test("rejects malicious paths without making an authorization or forwarding request", async () => {
  const paths = [
    "https://attacker.invalid/api",
    "//attacker.invalid",
    "/\\attacker",
    "/api#fragment",
    "/api/../escape",
    "/api/%2e%2e/escape",
    "/%252f%252fattacker",
    "/api/%255cescape",
    "/api/%00",
    "/api/\n",
    "/api/%zz",
    "api/echo",
    "/api/%23fragment",
  ];
  for (const path of paths)
    assert.equal((await invoke({ path })).response.status, 400, path);
  assert.equal(calls.length, 0);
});

test("supports backend-root-relative registered namespaces and custom paths, query and body", async () => {
  for (const path of [
    "/settings",
    "/dms/page",
    "/playground/run",
    "/custom/action?next=https%3A%2F%2Fexample.org%2F%23section%25done",
  ]) {
    const { response } = await invoke({
      path,
      method: "PATCH",
      body: "asymmetric body",
      headers: { "Content-Type": "text/plain" },
    });
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).path, path);
    assert.equal(calls.at(-1).method, "PATCH");
    assert.equal(calls.at(-1).body, "asymmetric body");
  }
});

test("strips case-insensitive transport, cookie, control and connection-nominated headers", async () => {
  const headers = {
    hOsT: "attacker.invalid",
    CoOkIe: "secret=value",
    CoNnEcTiOn: "X-Nominated",
    "X-Nominated": "hidden",
    "Transfer-Encoding": "chunked",
    "Content-Length": "987",
    "Proxy-Authorization": "private",
    "X-Forwarded-Host": "attacker.invalid",
    "X-Dms-Service-Token": "privileged",
    "Sec-Fetch-Site": "same-origin",
    "X-Http-Method-Override": "DELETE",
    "X-Custom": "retained",
  };
  assert.equal(
    (await invoke({ headers, useSession: false })).response.status,
    200,
  );
  const forwarded = calls.at(-1).headers;
  assert.equal(forwarded.host, new URL(backend).host);
  assert.equal(forwarded["x-custom"], "retained");
  for (const name of Object.keys(headers)
    .map((name) => name.toLowerCase())
    .filter((name) => !["host", "connection", "x-custom"].includes(name)))
    assert.equal(forwarded[name], undefined, name);
  assert.notEqual(forwarded.connection, "X-Nominated");
});

test("returns redirect envelope without following it or setting browser cookies", async () => {
  const { response, data } = await invoke({ path: "/api/redirect" });
  assert.equal(response.status, 200);
  assert.equal(data.status, 302);
  assert.equal(data.headers.location, `${frontend}/unexpected-redirect`);
  assert.equal(data.body, "redirect response");
  assert.equal(data.headers["set-cookie"], undefined);
  assert.equal(calls.length, 2);
});

test("bounds input and output and returns generic network errors", async () => {
  assert.equal(
    (await invoke({ method: "POST", body: "x".repeat(BODY_LIMIT) })).response
      .status,
    413,
  );
  assert.equal(calls.length, 0);
  for (const path of ["/api/large", "/api/network-error"]) {
    const { response, data } = await invoke({ path });
    assert.equal(response.status, 502);
    assert.deepEqual(data, { error: "DMS tester request failed" });
  }
});

test("validates method, header values and body shape before contacting backend", async () => {
  const inputs = [
    { method: "CONNECT" },
    { useSession: "false" },
    { headers: [] },
    { headers: { x: 1 } },
    { headers: { x: "bad\r\nheader" } },
    { body: "GET body" },
    { method: "POST", body: {} },
  ];
  for (const input of inputs)
    assert.equal((await invoke(input)).response.status, 400);
  assert.equal(calls.length, 0);
});

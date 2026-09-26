import * as assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  backend,
  publicBackendMessage,
  UpstreamError,
} from "../templates/vue/server/auth/backend.mjs";
import { isSameOrigin } from "../templates/vue/server/auth/client-ip.mjs";
import {
  hitOAuthRateLimitKey,
  isValidOAuthProvider,
  resolveOAuthClientKey,
} from "../templates/vue/server/auth/oauth.mjs";
import {
  allowedEstablishEndpoints,
  handleAuth,
  isAllowedEstablishEndpoint,
  readDeclaredEstablishEndpoints,
  refreshSession,
} from "../templates/vue/server/auth/routes.mjs";
import {
  assertAccountInvariant,
  writeSession,
} from "../templates/vue/server/auth/session.mjs";

const LIMIT = 10;
const WINDOW_MS = 60_000;
const NOW = 1_000_000;

interface CookieResponse {
  headers: Map<string, string | string[]>;
  getHeader: (name: string) => string | string[] | undefined;
  setHeader: (name: string, value: string | string[]) => void;
}

function cookieResponse(): CookieResponse {
  const headers = new Map<string, string | string[]>();
  return {
    headers,
    getHeader: (name) => headers.get(name),
    setHeader: (name, value) => headers.set(name, value),
  };
}

function sessionCookie(refreshToken = "refresh-token"): string {
  const response = cookieResponse();
  writeSession(response, {
    accessToken: "access-token",
    refreshToken,
    accountId: "account-1",
  });
  const value = response.headers.get("set-cookie");
  assert.equal(typeof value, "string");
  return value.split(";", 1)[0];
}

describe("OAuth adapter invariants", () => {
  it("allows ten attempts in a window", () => {
    for (let index = 0; index < LIMIT; index += 1)
      assert.equal(hitOAuthRateLimitKey("start:allowed", NOW), true);
  });

  it("refuses an eleventh attempt", () => {
    for (let index = 0; index < LIMIT; index += 1)
      hitOAuthRateLimitKey("callback:limited", NOW);
    assert.equal(hitOAuthRateLimitKey("callback:limited", NOW), false);
  });

  it("counts providers under the same client and route key", () => {
    for (let index = 0; index < LIMIT; index += 1)
      hitOAuthRateLimitKey("start:shared-client", NOW);
    assert.equal(hitOAuthRateLimitKey("start:shared-client", NOW), false);
  });

  it("keeps start and callback budgets independent", () => {
    for (let index = 0; index < LIMIT; index += 1)
      hitOAuthRateLimitKey("start:two-budgets", NOW);
    assert.equal(hitOAuthRateLimitKey("callback:two-budgets", NOW), true);
  });

  it("expires a client window", () => {
    for (let index = 0; index <= LIMIT; index += 1)
      hitOAuthRateLimitKey("start:expires", NOW);
    assert.equal(hitOAuthRateLimitKey("start:expires", NOW + WINDOW_MS), true);
  });

  it("uses the socket address and never caller-forwarded headers", () => {
    assert.equal(
      resolveOAuthClientKey({
        headers: { "x-forwarded-for": "forged" },
        socket: { remoteAddress: "127.0.0.2" },
      }),
      "127.0.0.2",
    );
  });

  it("uses a non-empty fallback client key", () => {
    assert.equal(resolveOAuthClientKey({ socket: {} }), "unknown");
  });

  it("uses the rightmost untrusted address behind configured proxies", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "2";
    try {
      assert.equal(
        resolveOAuthClientKey({
          headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
          socket: { remoteAddress: "10.0.0.2" },
        }),
        "203.0.113.7",
      );
    } finally {
      delete process.env.DMS_TRUSTED_PROXY_HOPS;
    }
  });

  it("validates the public origin supplied by a trusted reverse proxy", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    try {
      assert.equal(
        isSameOrigin({
          headers: {
            host: "127.0.0.1:32099",
            origin: "https://dms.example.test",
            "x-forwarded-host": "dms.example.test",
            "x-forwarded-proto": "https",
          },
          socket: {},
        }),
        true,
      );
    } finally {
      delete process.env.DMS_TRUSTED_PROXY_HOPS;
    }
  });

  it("accepts the same provider grammar for start and callback", () => {
    assert.equal(isValidOAuthProvider("github-enterprise"), true);
    for (const provider of ["GitHub", "../github", "", "a".repeat(33)])
      assert.equal(isValidOAuthProvider(provider), false);
  });
});

describe("auth adapter safety", () => {
  it("requires an account id to match the active session", () => {
    assert.doesNotThrow(() =>
      assertAccountInvariant({ accountId: "account-1" }, "account-1"),
    );
    assert.throws(() =>
      assertAccountInvariant({ accountId: "account-2" }, "account-1"),
    );
  });

  it("allows public auth keys without exposing details or stacks", () => {
    assert.equal(
      publicBackendMessage({
        message: "error.invalid_credentials",
        details: "database host",
        stack: "secret stack",
      }),
      "error.invalid_credentials",
    );
    assert.equal(publicBackendMessage({ message: "database host" }), undefined);
  });

  it("preserves safe login, signup, and 2FA errors and statuses", async () => {
    const failures = {
      "/api/auth/login": [401, "error.invalid_credentials"],
      "/api/auth/signup": [409, "error.email_already_exists"],
      "/api/auth/verify-2fa": [400, "error.invalid_2fa_code"],
    };
    const api = createServer((request, response) => {
      const [status, message] = failures[request.url];
      response.writeHead(status, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ message, details: "private", stack: "private" }),
      );
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    try {
      for (const [path, [status, message]] of Object.entries(failures)) {
        await assert.rejects(
          backend(path, { headers: {} }),
          (error) =>
            error instanceof UpstreamError &&
            error.status === status &&
            error.message === message &&
            !error.message.includes("private"),
        );
      }
    } finally {
      api.close();
    }
  });

  it("preserves allowlisted plain-text and JSON-string errors without leaking other text", async () => {
    const responses = [
      ["error.invalid_credentials", "error.invalid_credentials"],
      ['"error.invalid_2fa_code"', "error.invalid_2fa_code"],
      ["private database host", "error.500.description"],
      [
        "error.invalid_credentials\nprivate stack",
        "error.500.description",
      ],
    ];
    let payload = "";
    const api = createServer((_request, response) => {
      response.writeHead(401, { "content-type": "text/plain" });
      response.end(payload);
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    const previous = process.env.DMS_API_BASE_URL;
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    try {
      for (const [body, expected] of responses) {
        payload = body;
        await assert.rejects(
          backend("/api/auth/login", { headers: {} }),
          (error) =>
            error instanceof UpstreamError &&
            error.status === 401 &&
            error.message === expected,
        );
      }
    } finally {
      process.env.DMS_API_BASE_URL = previous;
      api.close();
    }
  });

  it("only clears a session after a terminal refresh rejection", async () => {
    let refreshStatus = 503;
    const api = createServer((_request, response) => {
      response.writeHead(refreshStatus, { "content-type": "application/json" });
      response.end('{"message":"upstream failure"}');
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.DMS_SESSION_SECRET = "dms-frontend-test-session-secret-value";
    process.env.DMS_COOKIE_SECURE = "false";
    const cookie = sessionCookie();
    try {
      const transientResponse = cookieResponse();
      await refreshSession(
        { headers: { cookie }, socket: { remoteAddress: "127.0.0.1" } },
        transientResponse,
      );
      assert.equal(transientResponse.headers.get("set-cookie"), undefined);

      refreshStatus = 401;
      const rejectedCookie = sessionCookie("rejected-refresh-token");
      const rejectedResponse = cookieResponse();
      await refreshSession(
        {
          headers: { cookie: rejectedCookie },
          socket: { remoteAddress: "127.0.0.1" },
        },
        rejectedResponse,
      );
      assert.match(
        String(rejectedResponse.headers.get("set-cookie")),
        /Max-Age=0/,
      );
    } finally {
      api.close();
      delete process.env.DMS_SESSION_SECRET;
      delete process.env.DMS_COOKIE_SECURE;
    }
  });
});

interface CapturedResponse extends CookieResponse {
  statusCode: number;
  payload: string;
  writeHead: (code: number, extra?: Record<string, string>) => void;
  end: (body?: string) => void;
}

function capturedResponse(): CapturedResponse {
  const base = cookieResponse();
  const response = base as CapturedResponse;
  response.statusCode = 0;
  response.payload = "";
  response.writeHead = (code, extra) => {
    response.statusCode = code;
    for (const [name, value] of Object.entries(extra ?? {}))
      base.setHeader(name, value);
  };
  response.end = (body) => {
    response.payload = body ?? "";
  };
  return response;
}

/** The half of an `IncomingMessage` the auth adapter actually reads. */
function establishRequest(payload: unknown) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify(payload))]), {
    method: "POST",
    headers: { origin: "http://frontend.local", host: "frontend.local" },
    socket: { remoteAddress: "127.0.0.1" },
  });
}

function accessToken(tenantId: string): string {
  const claims = Buffer.from(JSON.stringify({ tenantId })).toString(
    "base64url",
  );
  return `header.${claims}.signature`;
}

const ESTABLISH_URL = new URL("http://frontend.local/auth/establish");

describe("session establishment from a module endpoint", () => {
  it("keeps the allowlist empty when nothing is declared", () => {
    assert.deepEqual(allowedEstablishEndpoints(undefined), []);
    assert.deepEqual(allowedEstablishEndpoints(""), []);
  });

  it("allows what the modules declared, with no environment variable", () => {
    assert.deepEqual(
      allowedEstablishEndpoints(undefined, ["/api/saas/register/finalize"]),
      ["/api/saas/register/finalize"],
    );
  });

  it("unions the module declarations with the environment, without duplicates", () => {
    assert.deepEqual(
      allowedEstablishEndpoints(
        "/api/invites/redeem, /api/saas/register/finalize",
        ["/api/saas/register/finalize"],
      ),
      ["/api/saas/register/finalize", "/api/invites/redeem"],
    );
  });

  it("drops malformed module declarations as it drops malformed environment ones", () => {
    assert.deepEqual(
      allowedEstablishEndpoints("", [
        "/api/ok",
        "/auth/login",
        "/api/../secret",
        undefined,
      ]),
      ["/api/ok"],
    );
  });

  it("reads the endpoints the loader generated into the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-declared-"));
    const file = join(workspace, "generated-auth-establish.json");
    writeFileSync(
      file,
      JSON.stringify({ endpoints: ["/api/saas/register/finalize"] }),
    );
    assert.deepEqual(readDeclaredEstablishEndpoints(file), [
      "/api/saas/register/finalize",
    ]);
  });

  it("falls back to no declaration when the workspace carries no such file", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-declared-absent-"));
    assert.deepEqual(
      readDeclaredEstablishEndpoints(join(workspace, "absent.json")),
      [],
    );
  });

  it("reads a comma-separated declaration and drops malformed entries", () => {
    assert.deepEqual(
      allowedEstablishEndpoints(
        " /api/saas/register/finalize , /api/invites/redeem ,,http://evil/api/x,/auth/login,/api/../secret",
      ),
      ["/api/saas/register/finalize", "/api/invites/redeem"],
    );
  });

  it("only accepts an endpoint the deployment declared, verbatim", () => {
    const allowed = allowedEstablishEndpoints("/api/saas/register/finalize");
    assert.equal(
      isAllowedEstablishEndpoint("/api/saas/register/finalize", allowed),
      true,
    );
    for (const endpoint of [
      "/api/auth/login",
      "/api/saas/register/finalize/",
      "/api/saas/register/finalize?x=1",
      "/api/saas/register/../../secret",
      "//evil.test/api/saas/register/finalize",
      undefined,
      42,
    ])
      assert.equal(isAllowedEstablishEndpoint(endpoint, allowed), false);
  });

  it("opens the session from tokens it fetched itself, and returns none of them", async () => {
    const calls: { url: string; body: string }[] = [];
    const api = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        calls.push({
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            token_type: "Bearer",
            access_token: accessToken("tenant-1"),
            expires_in: 900,
            refresh_token: "module-refresh-token",
            user: { _id: "user-1", email: "a@b.test", name: "A" },
          }),
        );
      });
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.DMS_SESSION_SECRET = "dms-frontend-test-session-secret-value";
    process.env.DMS_COOKIE_SECURE = "false";
    process.env.DMS_AUTH_ESTABLISH_ENDPOINTS = "/api/saas/register/finalize";
    const response = capturedResponse();
    try {
      await handleAuth(
        establishRequest({
          endpoint: "/api/saas/register/finalize",
          payload: { workspaceName: "Acme" },
        }),
        response,
        ESTABLISH_URL,
      );
    } finally {
      api.close();
      delete process.env.DMS_AUTH_ESTABLISH_ENDPOINTS;
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "/api/saas/register/finalize");
    assert.deepEqual(JSON.parse(calls[0].body), { workspaceName: "Acme" });
    assert.equal(response.statusCode, 200);

    const body = JSON.parse(response.payload);
    assert.deepEqual(body.user, {
      _id: "user-1",
      email: "a@b.test",
      name: "A",
    });
    assert.equal(body.account.activeTenantId, "tenant-1");
    assert.ok(!response.payload.includes("module-refresh-token"));

    const cookies = response.headers.get("set-cookie");
    const written = Array.isArray(cookies) ? cookies : [cookies];
    assert.ok(written.some((cookie) => cookie?.startsWith("dms_session=")));
  });

  it("refuses an endpoint the deployment never declared, without calling it", async () => {
    let called = false;
    const api = createServer((_request, response) => {
      called = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
    const address = api.address();
    assert.ok(address && typeof address === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    delete process.env.DMS_AUTH_ESTABLISH_ENDPOINTS;
    const response = capturedResponse();
    try {
      await handleAuth(
        establishRequest({ endpoint: "/api/auth/login", payload: {} }),
        response,
        ESTABLISH_URL,
      );
    } finally {
      api.close();
    }

    assert.equal(called, false);
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers.get("set-cookie"), undefined);
  });
});

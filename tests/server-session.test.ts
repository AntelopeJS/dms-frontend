import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { publicBackendMessage } from "../templates/vue/server/auth/backend.mjs";
import {
  clientIp,
  isSameOrigin,
} from "../templates/vue/server/auth/client-ip.mjs";
import {
  allowedEstablishEndpoints,
  readDeclaredEstablishEndpoints,
} from "../templates/vue/server/auth/establish-endpoints.mjs";
import {
  readSession,
  scopedCookieName,
  writeSession,
} from "../templates/vue/server/auth/session.mjs";
import { requestOf, responseOf } from "./helpers/http-doubles";

void describe("client of a request", () => {
  void it("uses the socket address and never caller-forwarded headers", () => {
    assert.equal(
      clientIp(
        requestOf({
          headers: { "x-forwarded-for": "forged" },
          remoteAddress: "127.0.0.2",
        }),
      ),
      "127.0.0.2",
    );
  });

  void it("believes only the platform's client IP header, whatever the hops", () => {
    process.env.DMS_CLIENT_IP_HEADER = "X-Client-IP";
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    try {
      assert.equal(
        clientIp(
          requestOf({
            headers: {
              "x-client-ip": "2001:db8::7",
              "x-forwarded-for": "198.51.100.66, 10.0.0.1",
            },
            remoteAddress: "10.0.0.2",
          }),
        ),
        "2001:db8::7",
      );
      assert.equal(
        isSameOrigin(
          requestOf({
            headers: {
              host: "127.0.0.1:32099",
              origin: "https://dms.example.test",
              "x-client-ip": "2001:db8::7",
              "x-forwarded-host": "dms.example.test",
              "x-forwarded-proto": "https",
            },
          }),
        ),
        true,
      );
    } finally {
      delete process.env.DMS_CLIENT_IP_HEADER;
      delete process.env.DMS_TRUSTED_PROXY_HOPS;
    }
  });

  void it("uses the rightmost untrusted address behind configured proxies", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "2";
    try {
      assert.equal(
        clientIp(
          requestOf({
            headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1" },
            remoteAddress: "10.0.0.2",
          }),
        ),
        "203.0.113.7",
      );
    } finally {
      delete process.env.DMS_TRUSTED_PROXY_HOPS;
    }
  });

  void it("validates the public origin supplied by a trusted reverse proxy", () => {
    process.env.DMS_TRUSTED_PROXY_HOPS = "1";
    try {
      assert.equal(
        isSameOrigin(
          requestOf({
            headers: {
              host: "127.0.0.1:32099",
              origin: "https://dms.example.test",
              "x-forwarded-host": "dms.example.test",
              "x-forwarded-proto": "https",
            },
          }),
        ),
        true,
      );
    } finally {
      delete process.env.DMS_TRUSTED_PROXY_HOPS;
    }
  });
});

void describe("backend messages", () => {
  void it("allows public auth keys without exposing details or stacks", () => {
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
});

void describe("cookies of instances sharing a host", () => {
  /** Run `action` as the frontend of `backendUrl`, with its own secret. */
  function asInstance<T>(backendUrl: string, secret: string, action: () => T) {
    const previous = process.env.DMS_API_BASE_URL;
    process.env.DMS_API_BASE_URL = backendUrl;
    process.env.DMS_SESSION_SECRET = secret;
    try {
      return action();
    } finally {
      process.env.DMS_API_BASE_URL = previous;
      delete process.env.DMS_SESSION_SECRET;
    }
  }
  const first = ["http://localhost:5010", "a".repeat(32)] as const;
  const second = ["http://localhost:5020", "b".repeat(32)] as const;

  void it("names them after the backend, whatever its spelling", () => {
    const name = (backendUrl: string) =>
      asInstance(backendUrl, "a".repeat(32), () =>
        scopedCookieName("dms_session"),
      );
    assert.match(name(first[0]), /^dms_session_[0-9a-f]{12}$/);
    assert.equal(name(first[0]), name("HTTP://127.0.0.1:5010/"));
    assert.notEqual(name(first[0]), name(second[0]));
  });

  void it("keeps one instance's session out of another's", () => {
    const write = (backendUrl: string, secret: string, accountId: string) =>
      asInstance(backendUrl, secret, () => {
        const response = responseOf();
        writeSession(response, {
          refreshToken: "refresh",
          accountId,
          persistent: false,
        });
        return String(response.getHeader("set-cookie")).split(";", 1)[0];
      });
    const cookie = [
      write(...first, "account-1"),
      write(...second, "account-2"),
    ].join("; ");
    const read = (backendUrl: string, secret: string) =>
      asInstance(backendUrl, secret, () =>
        readSession(requestOf({ headers: { cookie } })),
      );
    assert.equal(read(...first)?.accountId, "account-1");
    assert.equal(read(...second)?.accountId, "account-2");
  });

  void it("reads a sealed session only when it holds a session", () => {
    const sealed = (accessToken: string | number) =>
      asInstance(...first, () => {
        const session = { persistent: true };
        Reflect.set(session, "accessToken", accessToken);
        const response = responseOf();
        writeSession(response, session);
        const cookie = String(response.getHeader("set-cookie")).split(";")[0];
        return readSession(requestOf({ headers: { cookie } }));
      });
    assert.deepEqual(sealed("token"), {
      accessToken: "token",
      persistent: true,
    });
    assert.equal(sealed(7), undefined);
  });
});

void describe("session establishment from a module endpoint", () => {
  void it("keeps the allowlist empty when nothing is declared", () => {
    assert.deepEqual(allowedEstablishEndpoints(undefined), []);
    assert.deepEqual(allowedEstablishEndpoints(""), []);
  });

  void it("allows what the modules declared, with no environment variable", () => {
    assert.deepEqual(
      allowedEstablishEndpoints(undefined, ["/api/saas/register/finalize"]),
      ["/api/saas/register/finalize"],
    );
  });

  void it("unions the module declarations with the environment, without duplicates", () => {
    assert.deepEqual(
      allowedEstablishEndpoints(
        "/api/invites/redeem, /api/saas/register/finalize",
        ["/api/saas/register/finalize"],
      ),
      ["/api/saas/register/finalize", "/api/invites/redeem"],
    );
  });

  void it("drops malformed module declarations as it drops malformed environment ones", () => {
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

  void it("reads the endpoints the loader generated into the workspace", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-declared-"));
    try {
      const file = join(workspace, "generated-auth-establish.json");
      writeFileSync(
        file,
        JSON.stringify({ endpoints: ["/api/saas/register/finalize"] }),
      );
      assert.deepEqual(readDeclaredEstablishEndpoints(file), [
        "/api/saas/register/finalize",
      ]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  void it("falls back to no declaration when the workspace carries no such file", () => {
    assert.deepEqual(
      readDeclaredEstablishEndpoints(join(tmpdir(), "dms-absent", "a.json")),
      [],
    );
  });

  void it("reads a comma-separated declaration and drops malformed entries", () => {
    assert.deepEqual(
      allowedEstablishEndpoints(
        " /api/saas/register/finalize , /api/invites/redeem ,,http://evil/api/x,/auth/login,/api/../secret",
      ),
      ["/api/saas/register/finalize", "/api/invites/redeem"],
    );
  });
});

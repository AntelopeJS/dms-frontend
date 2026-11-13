import * as assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, mock } from "node:test";
import {
  clearSealedCookie,
  clearSession,
  readSession,
  SESSION_COOKIE,
  scopedCookieName,
  writeSealedCookie,
  writeSession,
} from "../templates/vue/server/auth/session.mjs";
import { writeProxyHeaders } from "../templates/vue/server/proxy-headers.mjs";
import { requestOf, responseOf } from "./helpers/http-doubles";

const SECRET = "a-test-only-session-secret-of-32-characters";
const DAY_MS = 24 * 60 * 60 * 1000;

function sealedCookie(persistent: boolean) {
  const response = responseOf();
  writeSession(response, { accessToken: "token", persistent });
  return String(response.getHeader("set-cookie")).split(";", 1)[0] ?? "";
}

function cookieValue(cookie: string) {
  return cookie.slice(cookie.indexOf("=") + 1);
}

function readCookie(cookie: string) {
  return readSession(requestOf({ headers: { cookie } }));
}

void describe("sealed session lifetime", () => {
  void it("refuses a session written longer ago than its lifetime", (t) => {
    process.env.DMS_SESSION_SECRET = SECRET;
    t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
    for (const persistent of [true, false]) {
      const cookie = sealedCookie(persistent);
      t.mock.timers.setTime(1_000_000 + 30 * DAY_MS);
      assert.equal(readCookie(cookie)?.accessToken, "token");
      t.mock.timers.setTime(1_000_000 + 30 * DAY_MS + 1);
      assert.equal(readCookie(cookie), undefined);
      t.mock.timers.setTime(1_000_000);
    }
  });

  void it("stamps the time it writes a session", (t) => {
    process.env.DMS_SESSION_SECRET = SECRET;
    t.mock.timers.enable({ apis: ["Date"], now: 5_000 });
    const session = { accessToken: "token", persistent: true };
    writeSession(responseOf(), session);
    assert.deepEqual(session, {
      accessToken: "token",
      persistent: true,
      updatedAt: 5_000,
    });
  });

  void it("refuses to write a session without a boolean persistent", () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const session = { accessToken: "token", persistent: true };
    Reflect.deleteProperty(session, "persistent");
    assert.throws(() => writeSession(responseOf(), session), TypeError);
    Reflect.set(session, "persistent", "yes");
    assert.throws(() => writeSession(responseOf(), session), TypeError);
  });
});

void describe("sealed session integrity", () => {
  void it("opens no session sealed without the cookie's name", () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(SECRET).digest(),
      iv,
    );
    const sealed = Buffer.concat([
      cipher.update(
        JSON.stringify({
          accessToken: "token",
          persistent: true,
          updatedAt: Date.now(),
        }),
      ),
      cipher.final(),
    ]);
    const value = Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString(
      "base64url",
    );
    assert.equal(
      readCookie(`${scopedCookieName(SESSION_COOKIE)}=${value}`),
      undefined,
    );
  });

  void it("opens no session with any one bit flipped", () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const cookie = sealedCookie(true);
    const name = cookie.slice(0, cookie.indexOf("="));
    const bytes = Buffer.from(cookieValue(cookie), "base64url");
    const opened = [];
    for (let bit = 0; bit < bytes.length * 8; bit++) {
      const flipped = Buffer.from(bytes);
      flipped[bit >> 3] ^= 1 << (bit & 7);
      if (readCookie(`${name}=${flipped.toString("base64url")}`))
        opened.push(bit);
    }
    assert.ok(bytes.length > 28);
    assert.deepEqual(opened, []);
  });

  void it("refuses a short authentication tag without a deprecation warning", async () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const warnings = mock.fn();
    process.on("warning", warnings);
    try {
      const short = randomBytes(20).toString("base64url");
      assert.equal(
        readCookie(`${scopedCookieName(SESSION_COOKIE)}=${short}`),
        undefined,
      );
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.off("warning", warnings);
    }
    assert.deepEqual(
      warnings.mock.calls.map(({ arguments: [warning] }) => String(warning)),
      [],
    );
  });
});

void describe("a session cookie written during a request", () => {
  void it("goes out once, as its last write leaves it", () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const response = responseOf();
    writeSession(response, { accessToken: "renewed", persistent: true });
    clearSession(response);
    const name = scopedCookieName(SESSION_COOKIE);
    const lines = [response.getHeader("set-cookie") ?? []]
      .flat()
      .map(String)
      .filter((line) => line.startsWith(`${name}=`));
    assert.deepEqual(lines, [
      `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
    ]);
  });

  void it("keeps a write and a clear of one name at two paths", () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const response = responseOf();
    writeSealedCookie(response, "shop.flow", { step: 1 }, 60, "/");
    clearSealedCookie(response, "shop.flow", "/x");
    const paths = [response.getHeader("set-cookie") ?? []]
      .flat()
      .map((line) => /Path=([^;]*)/.exec(String(line))?.[1]);
    assert.deepEqual(paths, ["/x", "/"]);
  });

  void it("goes out with the cookies of a proxied backend answer", () => {
    process.env.DMS_SESSION_SECRET = SECRET;
    const response = responseOf();
    writeSession(response, { accessToken: "renewed", persistent: true });
    const renewed = String(response.getHeader("set-cookie"));
    writeProxyHeaders(
      response,
      {
        status: 200,
        headers: new Headers([["set-cookie", "csrf=1; Path=/"]]),
        url: "http://backend.test/api/items",
      },
      undefined,
    );
    assert.deepEqual(response.getHeader("set-cookie"), [
      renewed,
      "csrf=1; Path=/",
    ]);
  });
});

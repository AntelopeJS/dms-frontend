import * as assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, it, type TestContext } from "node:test";
import { SESSION_RECONFIRM_AFTER_MS } from "../templates/vue/server/auth-hooks.mjs";
import * as sessions from "../templates/vue/server/auth/session.mjs";
import type { DmsSession } from "../templates/vue/server-module";
import { type AuthServer, startAuthServer } from "./helpers/auth-server";
import { responseOf } from "./helpers/http-doubles";
import { jsonAt, responseJson } from "./helpers/json";

const SESSION_SECRET = "a-test-only-session-secret-of-32-characters";
const STALE = SESSION_RECONFIRM_AFTER_MS + 1;

const FIXTURE_ENTRY = `
import { defineDmsServer } from "#dms/server";

export default defineDmsServer((server) => {
  server.registerAuth({
    signInPath: "/login",
    async refreshSession(event, session) {
      if (session.refreshToken === "revoked") return event.session.clear();
      if (session.refreshToken === "unreachable")
        return event.session.useForRequest(undefined);
      const renewed = { ...session, accessToken: "renewed" };
      event.session.write(renewed);
      return renewed;
    },
  });
  server.registerBackendProxy("/api/items");
  server.registerRoute("GET", "/api/_fixture/session", (event) => ({
    read: event.session.read()?.refreshToken ?? null,
  }));
  server.registerRoute("DELETE", "/api/_fixture/session", async (event) => {
    const session = event.session.read();
    if (session?.refreshToken) {
      await event
        .backend("/api/auth/logout", {
          method: "POST",
          token: session.accessToken,
          body: { token: session.refreshToken },
        })
        .catch(() => {});
      event.cookies.clear("dms_account");
    }
    event.session.clear();
    return { signedOut: session?.refreshToken ?? null };
  });
});
`;

interface BackendCall {
  path: string;
  authorization: string | undefined;
}

function answerBackend(
  calls: BackendCall[],
  request: IncomingMessage,
  response: ServerResponse,
) {
  calls.push({
    path: request.url ?? "",
    authorization: request.headers.authorization,
  });
  const signedIn = (request.headers.authorization ?? "").startsWith(
    "Bearer renewed",
  );
  const ok = signedIn || request.url === "/api/auth/logout";
  response.writeHead(ok ? 200 : 401, { "content-type": "application/json" });
  response.end(
    ok
      ? JSON.stringify({ route: { hasAccess: true }, layout: {}, items: [] })
      : '{"message":"error.401"}',
  );
}

void describe("Revoking a session on the production server", () => {
  const calls: BackendCall[] = [];
  let server: AuthServer | undefined;
  const sessionName = () => sessions.scopedCookieName(sessions.SESSION_COOKIE);

  before(async () => {
    server = await startAuthServer(
      ".server-session-revocation-",
      FIXTURE_ENTRY,
      (request, response) => answerBackend(calls, request, response),
      SESSION_SECRET,
    );
  });

  after(() => server?.close());

  /** The session cookie of `session`, written at `start`, with the clock then set `age` later. */
  const aged = (t: TestContext, session: DmsSession, age: number) => {
    t.mock.timers.reset();
    const start = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: start });
    const jar = responseOf();
    sessions.writeSession(jar, session);
    t.mock.timers.setTime(start + age);
    return String(jar.getHeader("set-cookie")).split(";", 1)[0] ?? "";
  };

  const send = (path: string, cookie: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    return fetch(`${server?.url}${path}`, {
      redirect: "manual",
      ...init,
      headers,
    });
  };

  const clears = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .some((line) => line.startsWith(`${name}=;`));

  void it("signs out on the backend a session whose renewal fails", async (t) => {
    const cookie = aged(
      t,
      { accessToken: "stale", refreshToken: "unreachable", persistent: false },
      STALE,
    );
    const read = await send("/api/_fixture/session", cookie);
    assert.deepEqual(await responseJson(read), { read: null });

    calls.length = 0;
    const signOut = await send("/api/_fixture/session", cookie, {
      method: "DELETE",
      headers: { origin: server?.url ?? "" },
    });
    assert.deepEqual(await responseJson(signOut), { signedOut: "unreachable" });
    assert.deepEqual(calls, [
      { path: "/api/auth/logout", authorization: "Bearer stale" },
    ]);
    assert.ok(clears(signOut, sessionName()));
    assert.ok(clears(signOut, sessions.scopedCookieName("dms_account")));
  });

  void it("signs out a revoked session before a page or a proxied call uses it", async (t) => {
    const revoked = {
      accessToken: "renewed-before-sign-out",
      refreshToken: "revoked",
      persistent: false,
    };
    const cookie = aged(t, revoked, STALE);
    const visits: Record<string, string>[] = [{ "x-inertia": "true" }, {}];
    for (const headers of visits) {
      const page = await send("/private", cookie, { headers });
      assert.equal(page.status, 302);
      assert.equal(page.headers.get("location"), "/login?redirect=%2Fprivate");
      assert.ok(clears(page, sessionName()));
    }

    calls.length = 0;
    const proxied = await send("/api/items", cookie);
    assert.equal(proxied.status, 401);
    assert.deepEqual(calls, [{ path: "/api/items", authorization: undefined }]);
    assert.ok(clears(proxied, sessionName()));
  });

  void it("trusts a renewal that lands after the sign-out for five minutes at most", async (t) => {
    const late = {
      accessToken: "renewed-late",
      refreshToken: "revoked",
      persistent: false,
    };
    const trusted = await send(
      "/api/_fixture/session",
      aged(t, late, SESSION_RECONFIRM_AFTER_MS),
    );
    assert.deepEqual(await responseJson(trusted), { read: "revoked" });
    assert.ok(!clears(trusted, sessionName()));

    const reconfirmed = await send(
      "/api/_fixture/session",
      aged(t, late, STALE),
    );
    assert.equal(jsonAt(await responseJson(reconfirmed), "read"), null);
    assert.ok(clears(reconfirmed, sessionName()));
  });
});

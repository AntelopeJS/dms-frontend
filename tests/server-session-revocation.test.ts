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
  const read = (event) => ({ read: event.session.read()?.refreshToken ?? null });
  server.registerRoute("GET", "/api/_fixture/session", read);
  server.registerRoute("POST", "/api/_fixture/note", read);
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
  }, { signOut: true });
});
`;

const OTHER_ENTRY = `
import { defineDmsServer } from "#dms/server";

export default defineDmsServer((server) => {
  const read = (event) => ({ read: event.session.read()?.refreshToken ?? null });
  server.registerRoute("PUT", "/api/_fixture/session", read);
  server.registerRoute("POST", "/api/_other/note", read, { signOut: true });
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

/** The session cookie of `session`, written at `start`, with the clock then set `age` later. */
function aged(t: TestContext, session: DmsSession, age: number): string {
  t.mock.timers.reset();
  const start = Date.now();
  t.mock.timers.enable({ apis: ["Date"], now: start });
  const jar = responseOf();
  sessions.writeSession(jar, session);
  t.mock.timers.setTime(start + age);
  return String(jar.getHeader("set-cookie")).split(";", 1)[0] ?? "";
}

/** Whether `response` expires the cookie `name`. */
function clears(response: Response, name: string): boolean {
  return response.headers
    .getSetCookie()
    .some((line) => line.startsWith(`${name}=;`));
}

function sessionName(): string {
  return sessions.scopedCookieName(sessions.SESSION_COOKIE);
}

/** Sends a request with `cookie` alone to the server at `url()`, following no redirect. */
function sender(url: () => string) {
  return (path: string, cookie: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("cookie", cookie);
    return fetch(`${url()}${path}`, { redirect: "manual", ...init, headers });
  };
}

type Send = ReturnType<typeof sender>;

/** A renewal that answers after the sign-out sets a session the frontend trusts for 5 minutes at most. */
function registerLateRenewalTest(send: Send): void {
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
}

/** Routes the backend refused the session for, and requests no route answers. */
function registerRefusalTests(
  send: Send,
  origin: () => string,
  calls: BackendCall[],
): void {
  void it("runs a route of the sign-in module signed out after a refused renewal, the sign-out included", async (t) => {
    const revoked = aged(
      t,
      {
        accessToken: "renewed-before-sign-out",
        refreshToken: "revoked",
        persistent: false,
      },
      STALE,
    );
    const headers = { origin: origin() };
    const note = await send("/api/_fixture/note", revoked, {
      method: "POST",
      headers,
    });
    assert.deepEqual(await responseJson(note), { read: null });
    assert.ok(clears(note, sessionName()));

    calls.length = 0;
    const signOut = await send("/api/_fixture/session", revoked, {
      method: "DELETE",
      headers,
    });
    assert.deepEqual(await responseJson(signOut), { signedOut: null });
    assert.deepEqual(calls, []);
    assert.ok(clears(signOut, sessionName()));
  });

  void it("renews no session for a request no route answers", async (t) => {
    const revoked = aged(
      t,
      { accessToken: "stale", refreshToken: "revoked", persistent: false },
      STALE,
    );
    const answers = [];
    for (const [path, method] of [
      ["/private", "POST"],
      ["/private", "OPTIONS"],
      ["/api/_fixture/session", "PATCH"],
    ]) {
      const response = await send(path, revoked, {
        method,
        headers: { origin: origin() },
      });
      answers.push([response.status, clears(response, sessionName())]);
    }
    assert.deepEqual(answers, [
      [404, false],
      [404, false],
      [405, false],
    ]);
  });
}

void describe("Revoking a session on the production server", () => {
  const calls: BackendCall[] = [];
  let server: AuthServer | undefined;

  before(async () => {
    server = await startAuthServer(
      ".server-session-revocation-",
      [
        { packageName: "@acme/auth-frontend", entry: FIXTURE_ENTRY },
        { packageName: "@acme/other", priority: 10, entry: OTHER_ENTRY },
      ],
      (request, response) => answerBackend(calls, request, response),
      SESSION_SECRET,
    );
  });

  after(() => server?.close());

  const send = sender(() => server?.url ?? "");

  void it("signs out on the backend with a renewed token, or the sealed one when the renewal fails", async (t) => {
    for (const [refreshToken, token] of [
      ["unreachable", "Bearer stale"],
      ["live", "Bearer renewed"],
    ]) {
      const session = { accessToken: "stale", refreshToken, persistent: false };
      const cookie = aged(t, session, STALE);
      calls.length = 0;
      const signOut = await send("/api/_fixture/session", cookie, {
        method: "DELETE",
        headers: { origin: server?.url ?? "" },
      });
      assert.deepEqual(await responseJson(signOut), {
        signedOut: refreshToken,
      });
      assert.deepEqual(calls, [
        { path: "/api/auth/logout", authorization: token },
      ]);
      assert.ok(clears(signOut, sessionName()));
      assert.ok(clears(signOut, sessions.scopedCookieName("dms_account")));
    }
    const read = await send(
      "/api/_fixture/session",
      aged(
        t,
        {
          accessToken: "stale",
          refreshToken: "unreachable",
          persistent: false,
        },
        STALE,
      ),
    );
    assert.deepEqual(await responseJson(read), { read: null });
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

  registerRefusalTests(send, () => server?.url ?? "", calls);

  void it("reconfirms what every route but the sign-out and the backend answer, whatever the method", async (t) => {
    const write = (path: string, cookie: string, method: string) =>
      send(path, cookie, { method, headers: { origin: server?.url ?? "" } });
    const unreachable = aged(
      t,
      { accessToken: "stale", refreshToken: "unreachable", persistent: false },
      STALE,
    );
    for (const [path, method] of [
      ["/api/_fixture/note", "POST"],
      ["/api/_other/note", "POST"],
      ["/api/_fixture/session", "PUT"],
    ])
      assert.deepEqual(
        await responseJson(await write(path, unreachable, method)),
        {
          read: null,
        },
      );

    const revoked = aged(
      t,
      {
        accessToken: "renewed-before-sign-out",
        refreshToken: "revoked",
        persistent: false,
      },
      STALE,
    );
    calls.length = 0;
    const proxied = await write("/api/items", revoked, "POST");
    assert.deepEqual(calls, [{ path: "/api/items", authorization: undefined }]);
    assert.ok(clears(proxied, sessionName()));
    const head = await send("/api/_fixture/session", revoked, {
      method: "HEAD",
    });
    assert.ok(clears(head, sessionName()));
  });

  registerLateRenewalTest(send);
});

import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SESSION_RECONFIRM_AFTER_MS,
  serverAuth,
} from "../templates/vue/server/auth-hooks.mjs";
import * as sessions from "../templates/vue/server/auth/session.mjs";
import type { DmsSession } from "../templates/vue/server-module";
import { serverRequestOf, responseOf } from "./helpers/http-doubles";

const START = 1_000_000_000;

type Renewal = (session: DmsSession) => Promise<DmsSession | undefined>;

function reconfirmedAt(
  offset: number,
  renew: Renewal | undefined,
  clock: { setTime(time: number): void },
) {
  process.env.DMS_SESSION_SECRET =
    "a-test-only-session-secret-of-32-characters";
  const renewals: DmsSession[] = [];
  const auth = serverAuth(
    {
      id: "dms",
      priority: 0,
      refreshSession: renew
        ? (_event, session) => {
            renewals.push(session);
            return renew(session);
          }
        : undefined,
      publicSession: undefined,
    },
    (id) => ({
      module: { id, options: undefined, privateOptions: undefined },
      app: { authEstablishEndpoints: [] },
      authOwner: id,
    }),
  );
  clock.setTime(START);
  const jar = responseOf();
  sessions.writeSession(jar, { accessToken: "sealed", persistent: true });
  const request = serverRequestOf({
    method: "GET",
    url: "/private",
    headers: { cookie: String(jar.getHeader("set-cookie")).split(";", 1)[0] },
  });
  clock.setTime(START + offset);
  const response = responseOf(request);
  return auth.reconfirm(request, response, undefined).then(() => ({
    renewals: renewals.length,
    session: sessions.readSession(request)?.accessToken,
    setCookie: response.getHeader("set-cookie"),
  }));
}

void describe("reconfirming a session", () => {
  void it("runs the request signed out and keeps the cookie when the renewal throws", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: START });
    const renew: Renewal = () => Promise.reject(new Error("backend down"));
    assert.deepEqual(
      await reconfirmedAt(SESSION_RECONFIRM_AFTER_MS + 1, renew, t.mock.timers),
      { renewals: 1, session: undefined, setCookie: undefined },
    );
  });

  void it("keeps the session when no module registers refreshSession", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: START });
    assert.deepEqual(
      await reconfirmedAt(
        SESSION_RECONFIRM_AFTER_MS + 1,
        undefined,
        t.mock.timers,
      ),
      { renewals: 0, session: "sealed", setCookie: undefined },
    );
  });
});

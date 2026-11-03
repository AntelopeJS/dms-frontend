import { exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { fakeAuthBackend, signIn } from "./proxy-signin.mjs";

const NONE_PROXY = JSON.stringify([{ path: "/hook/**", auth: "none" }]);

const CLIENT_HEADERS = {
  "user-agent": "verify-agent/1",
  "x-content-language": "fr",
  "x-realtime-session": "session-1",
  "x-realtime-connection": "connection-1",
  accept: "application/x-test",
  "content-type": "application/x-test",
  "if-match": '"v1"',
  origin: "https://origin.example",
  referer: "https://origin.example/page",
};

const FOREIGN_HEADERS = {
  cookie: "tracking=1",
  authorization: "Bearer client-token",
  "x-other": "kept-from-the-backend",
  "x-dms-bootstrap": "stolen",
  "x-forwarded-for": "9.9.9.9",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "evil.example",
  "x-client-ip": "8.8.8.8",
  "cf-ipcountry": "XX",
};

/**
 * @param {import("./proxy-satellite.mjs").Seen} seen A request the backend received
 * @param {string[]} names Header names
 * @returns {Record<string, unknown>} Those headers as the backend saw them, `null` when absent
 */
function seenHeaders(seen, names) {
  return Object.fromEntries(names.map((name) => [name, seen.headers[name] ?? null]));
}

/**
 * Sends the client and foreign headers to `/hook/relay`, with `extra` on top.
 *
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {Record<string, string>} [extra] More request headers
 * @param {string[]} [drop] Foreign headers to leave out, by name
 * @returns {Promise<import("./proxy-satellite.mjs").Seen>} What the backend received
 */
async function relayRequest(server, extra = {}, drop = []) {
  const foreign = Object.fromEntries(Object.entries(FOREIGN_HEADERS).filter(([name]) => !drop.includes(name)));
  const before = server.backend.to("/hook/relay").length;
  const answer = await exchange(server.url, { method: "GET", path: "/hook/relay", headers: { ...CLIENT_HEADERS, ...foreign, ...extra } });
  if (answer.status !== 200) throw new Error(`/hook/relay answered ${answer.status}`);
  return server.backend.to("/hook/relay")[before];
}

const RELAYED = ["user-agent", "x-content-language", "x-realtime-session", "x-realtime-connection", "accept", "content-type", "if-match", "origin", "referer"];
const NEVER = ["cookie", "authorization", "x-other", "x-dms-bootstrap"];

export const journeys = [
  {
    id: "proxy-relay",
    title: "the proxy relays the documented client headers, sets X-Forwarded-*, and never relays Cookie or Authorization",
    entryPoint: "GET through a backend proxy of a second `ajs dms start` (auth none and session), with the headers of a browser",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: NONE_PROXY } }, async (server) => {
        const seen = await relayRequest(server);
        const expected = { ...CLIENT_HEADERS };
        observe(ctx, "default deployment: an auth none proxy", { received: seenHeaders(seen, [...RELAYED, ...NEVER, "x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "accept-encoding", "x-client-ip", "cf-ipcountry"]) }, [
          ctx.equal("the relayed client headers arrive unchanged", seenHeaders(seen, RELAYED), expected),
          ctx.equal("Cookie, Authorization, x-other and x-dms-bootstrap never arrive", seenHeaders(seen, NEVER), { cookie: null, authorization: null, "x-other": null, "x-dms-bootstrap": null }),
          ctx.equal("X-Forwarded-For is the socket's address, not the client's own", seen.headers["x-forwarded-for"], "127.0.0.1"),
          ctx.equal("X-Forwarded-Proto is http, not the client's", seen.headers["x-forwarded-proto"], "http"),
          ctx.equal("X-Forwarded-Host is the Host the client asked", seen.headers["x-forwarded-host"], `127.0.0.1:${server.port}`),
          ctx.equal("the backend is asked for an uncompressed answer", seen.headers["accept-encoding"], "identity"),
          ctx.equal("without DMS_CLIENT_IP_HEADER no x-client-ip reaches the backend", seen.headers["x-client-ip"] ?? null, null),
          ctx.equal("a country header from an untrusted client is dropped", seen.headers["cf-ipcountry"] ?? null, null),
        ]);

        const optional = await relayRequest(server, {}, ["cookie"]);
        const absent = await exchange(server.url, { path: "/hook/relay", headers: { "user-agent": "only-agent" } });
        const bare = server.backend.to("/hook/relay").at(-1);
        observe(ctx, "a header the client did not send is not invented", { status: absent.status, received: seenHeaders(bare, RELAYED) }, [
          ctx.equal("only the user-agent reaches the backend of the listed headers, Accept being fetch's own default", seenHeaders(bare, RELAYED), Object.fromEntries(RELAYED.map((name) => [name, name === "user-agent" ? "only-agent" : name === "accept" ? "*/*" : null]))),
          ctx.equal("a request with the foreign headers but no Cookie also relays no cookie", optional.headers.cookie ?? null, null),
        ]);
      });

      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: NONE_PROXY, DMS_TRUSTED_PROXY_HOPS: "2" } }, async (server) => {
        const chained = await relayRequest(server, { "x-forwarded-for": "1.1.1.1, 2.2.2.2", "x-forwarded-proto": "https", "x-forwarded-host": "dms.example.com", "cf-ipcountry": "BE" });
        const single = await relayRequest(server, { "x-forwarded-for": "5.5.5.5", "x-forwarded-proto": "ftp, http", "cf-ipcountry": "FR" });
        observe(ctx, "DMS_TRUSTED_PROXY_HOPS=2", { chained: seenHeaders(chained, ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "cf-ipcountry"]), single: seenHeaders(single, ["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host", "cf-ipcountry"]) }, [
          ctx.equal("the client's X-Forwarded-For is extended with the socket's address", chained.headers["x-forwarded-for"], "1.1.1.1, 2.2.2.2, 127.0.0.1"),
          ctx.equal("a trusted X-Forwarded-Proto is taken", chained.headers["x-forwarded-proto"], "https"),
          ctx.equal("a trusted X-Forwarded-Host is taken", chained.headers["x-forwarded-host"], "dms.example.com"),
          ctx.equal("the country header of a trusted proxy is relayed", chained.headers["cf-ipcountry"], "BE"),
          ctx.equal("a one-entry chain is extended too", single.headers["x-forwarded-for"], "5.5.5.5, 127.0.0.1"),
          ctx.equal("the last valid X-Forwarded-Proto wins", single.headers["x-forwarded-proto"], "http"),
          ctx.equal("the client's X-Forwarded-Host is trusted behind trusted hops", single.headers["x-forwarded-host"], "evil.example"),
        ]);
      });

      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: NONE_PROXY, DMS_CLIENT_IP_HEADER: "X-Client-IP", DMS_COUNTRY_HEADER: "X-Country" } }, async (server) => {
        const platform = await relayRequest(server, { "x-client-ip": "203.0.113.9", "x-country": "NL", "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com", "x-forwarded-for": "7.7.7.7" });
        const private_ = await relayRequest(server, { "x-country": "NL" }, ["x-client-ip", "x-forwarded-proto", "x-forwarded-host"]);
        const defaultCountry = await relayRequest(server, { "x-client-ip": "203.0.113.9", "cf-ipcountry": "DE" });
        observe(ctx, "DMS_CLIENT_IP_HEADER=X-Client-IP, DMS_COUNTRY_HEADER=X-Country", { platform: seenHeaders(platform, ["x-forwarded-for", "x-client-ip", "x-forwarded-proto", "x-forwarded-host", "x-country"]), private: seenHeaders(private_, ["x-forwarded-for", "x-client-ip", "x-forwarded-proto", "x-forwarded-host", "x-country"]) }, [
          ctx.equal("X-Forwarded-For is the platform's header, whatever the client sent", platform.headers["x-forwarded-for"], "203.0.113.9"),
          ctx.equal("the platform header is set to the resolved address", platform.headers["x-client-ip"], "203.0.113.9"),
          ctx.equal("scheme and host come from the platform's X-Forwarded-*", seenHeaders(platform, ["x-forwarded-proto", "x-forwarded-host"]), { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" }),
          ctx.equal("the country header named by DMS_COUNTRY_HEADER is relayed", platform.headers["x-country"], "NL"),
          ctx.equal("without the platform header the socket's address is used", private_.headers["x-forwarded-for"], "127.0.0.1"),
          ctx.equal("the platform header is then set to the socket's address", private_.headers["x-client-ip"], "127.0.0.1"),
          ctx.equal("a country header is not relayed when the proxy is not trusted", private_.headers["x-country"] ?? null, null),
          ctx.equal("a client's X-Forwarded-Proto is ignored without the platform header", seenHeaders(private_, ["x-forwarded-proto", "x-forwarded-host"]), { "x-forwarded-proto": "http", "x-forwarded-host": `127.0.0.1:${server.port}` }),
          ctx.equal("the default country header is no longer relayed", defaultCountry.headers["cf-ipcountry"] ?? null, null),
        ]);
      });

      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: NONE_PROXY, DMS_TRUSTED_PROXY_HOPS: "1", DMS_COUNTRY_HEADER: "" } }, async (server) => {
        const emptied = await relayRequest(server, { "cf-ipcountry": "BE", "x-forwarded-for": "4.4.4.4" });
        observe(ctx, "an empty DMS_COUNTRY_HEADER relays none", { received: seenHeaders(emptied, ["cf-ipcountry", "x-forwarded-for"]) }, [
          ctx.equal("no country header is relayed", emptied.headers["cf-ipcountry"] ?? null, null),
          ctx.equal("the chain is still extended", emptied.headers["x-forwarded-for"], "4.4.4.4, 127.0.0.1"),
        ]);
      });

      const { handler, auth } = fakeAuthBackend();
      await withSatellite(ctx, { backend: handler, env: { DMS_COOKIE_SECURE: "false" } }, async (server) => {
        const login = await signIn(server);
        const answer = await exchange(server.url, { path: "/api/relay", headers: { ...CLIENT_HEADERS, cookie: login.cookie, authorization: "Bearer client-token", origin: server.url } });
        const seen = server.backend.to("/api/relay")[0];
        observe(ctx, "auth session: the session's token is the only credential", { login: login.body, status: answer.status, received: seenHeaders(seen, [...RELAYED, ...NEVER, "x-forwarded-for"]) }, [
          ctx.equal("the sign-in answered", login.answer.status, 200),
          ctx.equal("Authorization is the session's access token", seen.headers.authorization, `Bearer ${auth.current}`),
          ctx.equal("the client's own Authorization is replaced, not forwarded", seen.headers.authorization === "Bearer client-token", false),
          ctx.equal("no Cookie reaches the backend although the browser sent the session cookies", seen.headers.cookie ?? null, null),
          ctx.equal("Origin and Referer arrive as received", seenHeaders(seen, ["origin", "referer"]), { origin: server.url, referer: "https://origin.example/page" }),
        ]);
      });
    },
  },
];

import { exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";

const NONE_PROXY = JSON.stringify([{ path: "/hook/**", auth: "none" }]);
const STATUSES = [301, 302, 303, 307, 308];
const COOKIES = ["bk=1; Path=/; HttpOnly", "bk2=two; Path=/api; Max-Age=60"];

/**
 * @param {string} backend The backend's origin
 * @returns {[string, string, string][]} Label, the backend's Location and the Location the client must get
 */
function locations(backend) {
  return [
    ["backend origin, proxied path", `${backend}/api/files/1`, "/api/files/1"],
    ["backend origin, proxied path with query and hash", `${backend}/api/files/1?x=1&y=2#part`, "/api/files/1?x=1&y=2#part"],
    ["backend origin, path outside every proxy", `${backend}/exports/report.pdf?token=abc`, `${backend}/exports/report.pdf?token=abc`],
    ["backend origin, path a module route answers first", `${backend}/api/_auth/session`, `${backend}/api/_auth/session`],
    ["backend origin, path the renderer answers first", `${backend}/assets/app.js`, `${backend}/assets/app.js`],
    ["backend origin, path under the dms proxy", `${backend}/dms/page?path=%2Fx`, "/dms/page?path=%2Fx"],
    ["backend origin, path under an auth none proxy", `${backend}/hook/done`, "/hook/done"],
    ["relative, proxied path", "/api/files/2", "/api/files/2"],
    ["relative to the fetched path", "files/3", "/api/files/3"],
    ["relative, outside every proxy", "/exports/x.csv", `${backend}/exports/x.csv`],
    ["another site", "https://elsewhere.example/page?x=1#frag", "https://elsewhere.example/page?x=1#frag"],
    ["another port of the same host", `http://127.0.0.1:1/api/files/4`, "http://127.0.0.1:1/api/files/4"],
  ];
}

export const journeys = [
  {
    id: "proxy-redirects",
    title: "a backend redirect is never followed: its status, Location and cookies reach the browser, and a Location on a proxied backend path becomes a frontend path",
    entryPoint: "GET through /api/** and an auth none proxy of a second `ajs dms start` whose backend answers redirects",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /** @type {import("./proxy-satellite.mjs").BackendHandler} */
      const handler = (request, response) => {
        const url = new URL(request.url ?? "", "http://backend.local");
        const status = Number(url.searchParams.get("status") ?? 200);
        const to = url.searchParams.get("to");
        if (to && /^(?:\/api\/redirect|\/hook\/redirect)$/.test(url.pathname)) {
          response.writeHead(status, { location: to, "set-cookie": COOKIES, "content-type": "text/plain" });
          response.end(`redirecting ${status}`);
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("target reached");
      };
      await withSatellite(ctx, { backend: handler, env: { DMS_BACKEND_PROXIES: NONE_PROXY } }, async (server) => {
        const backend = server.backend.url;
        for (const path of ["/api/redirect", "/hook/redirect"]) {
          const results = [];
          for (const status of STATUSES) {
            const answer = await exchange(server.url, { path: `${path}?status=${status}&to=${encodeURIComponent(`${backend}/api/files/1`)}`, headers: { cookie: "client=1" } });
            results.push({ status: answer.status, location: answer.headers.location, cookies: answer.headers["set-cookie"], body: answer.text });
          }
          observe(ctx, `${path}: each redirect status reaches the client as it is`, results, [
            ctx.equal("the five statuses are relayed as they are", results.map((entry) => entry.status), STATUSES),
            ctx.equal("each Location is the frontend path", results.map((entry) => entry.location), STATUSES.map(() => "/api/files/1")),
            ctx.equal("the backend's own cookies reach the browser, in order", results.map((entry) => entry.cookies), STATUSES.map(() => COOKIES)),
            ctx.equal("the redirect's body is relayed", results.map((entry) => entry.body), STATUSES.map((status) => `redirecting ${status}`)),
          ]);
          const followed = server.backend.requests.filter((seen) => seen.url.startsWith("/api/files")).length;
          ctx.record(ctx.step(`${path}: nothing followed`), [ctx.equal("the proxy never fetched a redirect's target", followed, 0)]);
        }

        const rows = [];
        for (const [label, location, expected] of locations(backend)) {
          const answer = await exchange(server.url, { path: `/api/redirect?status=302&to=${encodeURIComponent(location)}` });
          rows.push({ label, location, expected, status: answer.status, got: answer.headers.location });
        }
        observe(ctx, "the Location rules", rows, rows.map((row) => ctx.equal(`${row.label}: ${row.location}`, [row.status, row.got], [302, row.expected])));
      });
    },
  },
];

export const iconJourneys = [
  {
    id: "proxy-redirect-icons",
    title: "a Location on a backend path that the renderer's icon endpoint answers first stays an absolute backend URL",
    entryPoint: "GET /api/redirect of a second `ajs dms start` whose backend redirects to its own /api/_dms/icons",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /** @type {import("./proxy-satellite.mjs").BackendHandler} */
      const handler = (request, response) => {
        const target = new URL(request.url ?? "", "http://backend.local").searchParams.get("to");
        response.writeHead(302, { location: target });
        response.end();
      };
      await withSatellite(ctx, { backend: handler }, async (server) => {
        const location = `${server.backend.url}/api/_dms/icons`;
        const answer = await exchange(server.url, { path: `/api/redirect?to=${encodeURIComponent(location)}` });
        observe(ctx, "the Location of a path the renderer answers first", { status: answer.status, location: answer.headers.location }, [
          ctx.equal("the Location stays the backend's absolute URL", [answer.status, answer.headers.location], [302, location]),
        ]);
      });
    },
  },
];

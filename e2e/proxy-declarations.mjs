import { bodyJson, exchange, rawExchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { standalone } from "./standalone.mjs";

const CROSS_ORIGIN = { error: "Forbidden", reason: "missing or untrusted Origin header" };
const PROXIES = [
  { path: "/spec/**", auth: "none" },
  { path: "/spec/*", auth: "session" },
  { path: "/spec/fixed", auth: "none" },
  { path: "/hook/**", auth: "none" },
  { path: "/hook/**", auth: "session" },
  { path: "/api/**", auth: "none" },
  { path: "/a/b*", auth: "none" },
  { path: "/*/x", auth: "none" },
  { path: "/**", auth: "none" },
  { path: "/api/_dms/**", auth: "none" },
  { path: "/assets/**", auth: "none" },
  { path: "/node_modules/**", auth: "none" },
  { path: "/@vite/**", auth: "none" },
  { path: "/dots/../x", auth: "none" },
  { path: "no-slash", auth: "none" },
];

/**
 * @param {[string, string, string][]} declared Declared patterns, their auth and their declarer
 * @returns {string[]} The report lines for them and the build's own proxies, as the server prints them
 */
function expectedReport(declared) {
  /** @type {[string, string, string][]} */
  const own = [
    ["/file-storage/upload/**", "none", "antelopejs__dms-frontend-vue"],
    ["/file-storage/files/**", "none", "antelopejs__dms-frontend-vue"],
    ["/api/**", "session", "antelopejs__dms-frontend-vue"],
    ["/dms/**", "session", "antelopejs__dms-frontend-vue"],
  ];
  const all = [...own, ...declared];
  const width = Math.max(...all.map((entry) => entry[0].length));
  return all.map(([path, auth, owner]) => `  ${path.padEnd(width)}  -> backend (${auth}), declared by ${owner}`);
}

export const journeys = [
  {
    id: "proxy-declarations",
    title: "backend proxy declarations: the most specific pattern wins, bad ones are ignored with a warning, the startup report lists them, and the proxied path is the normalized one",
    entryPoint: "DMS_BACKEND_PROXIES on a second `ajs dms start`, then requests with exact and malicious targets",
    ...standalone,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: JSON.stringify(PROXIES) } }, async (server) => {
        const log = server.log();
        const warnings = log.split("\n").filter((line) => line.includes("declares the backend proxy"));
        /**
         * @param {string} pattern The declared pattern
         * @param {string} reason Why it is ignored
         */
        const warn = (pattern, reason) => `Backend module DMS_BACKEND_PROXIES declares the backend proxy "${pattern}", which is ignored: ${reason}.`;
        const kinds = "the pattern is not /x, /x/* or /x/**";
        observe(ctx, "declarations that are ignored are reported", { warnings }, [
          ctx.equal("each rejected declaration gets its exact warning", warnings, [
            warn("/hook/**", "Backend module DMS_BACKEND_PROXIES declares it"),
            warn("/api/**", "Frontend module antelopejs__dms-frontend-vue declares it"),
            warn("/a/b*", kinds),
            warn("/*/x", kinds),
            warn("/**", "its first segment is not literal: it would take every page"),
            warn("/api/_dms/**", "/api/_dms, /@, /assets, /node_modules are the renderer's own paths"),
            warn("/assets/**", "/api/_dms, /@, /assets, /node_modules are the renderer's own paths"),
            warn("/node_modules/**", "/api/_dms, /@, /assets, /node_modules are the renderer's own paths"),
            warn("/@vite/**", kinds),
            warn("/dots/../x", kinds),
            warn("no-slash", kinds),
          ]),
        ]);

        const report = log.split("\n");
        const start = report.findIndex((line) => line.startsWith("Routing:"));
        const reported = report.slice(start + 1).filter((line) => line.includes("-> backend"));
        /** @type {[string, string, string][]} */
        const accepted = [
          ["/spec/fixed", "none", "DMS_BACKEND_PROXIES"],
          ["/spec/*", "session", "DMS_BACKEND_PROXIES"],
          ["/spec/**", "none", "DMS_BACKEND_PROXIES"],
          ["/hook/**", "none", "DMS_BACKEND_PROXIES"],
        ];
        const lines = expectedReport(accepted);
        const order = [
          lines[4],
          lines[0],
          lines[1],
          lines[5],
          lines[2],
          lines[3],
          lines[6],
          lines[7],
        ];
        observe(ctx, "the startup report lists each prefix, its auth and its declarer, most specific first", { header: report[start], reported }, [
          ctx.equal("the header line counts the module routes", report[start], "Routing: renderer files, then 35 module routes, then the backend proxies below, then the pages"),
          ctx.equal("the proxies, most specific first, ties in declaration order", reported, order),
        ]);

        /**
         * @param {string} path The target
         * @param {Record<string, string>} [extra] Request headers
         */
        const post = (path, extra = {}) => exchange(server.url, { method: "POST", path, headers: extra, body: "{}" });
        const rows = {
          exact: await post("/spec/fixed"),
          oneBelow: await post("/spec/other"),
          twoBelow: await post("/spec/other/deeper"),
          itself: await post("/spec"),
          trailing: await post("/spec/other/"),
          hook: await post("/hook/x"),
          api: await post("/api/x"),
        };
        observe(ctx, "the most specific covering pattern decides", Object.fromEntries(Object.entries(rows).map(([name, answer]) => [name, { status: answer.status, body: bodyJson(answer) }])), [
          ctx.equal("/spec/fixed (none) beats /spec/* (session)", rows.exact.status, 200),
          ctx.equal("/spec/* (session) beats /spec/** (none) one segment below: Origin required", [rows.oneBelow.status, bodyJson(rows.oneBelow)], [403, CROSS_ORIGIN]),
          ctx.equal("two segments below only /spec/** covers: no Origin needed", rows.twoBelow.status, 200),
          ctx.equal("/spec/** covers the path itself", rows.itself.status, 200),
          ctx.equal("a trailing slash is the same path", [rows.trailing.status, bodyJson(rows.trailing)], [403, CROSS_ORIGIN]),
          ctx.equal("the first declaration of a duplicated pattern stands", rows.hook.status, 200),
          ctx.equal("the build's own /api/** (session) stands against the operator's", [rows.api.status, bodyJson(rows.api)], [403, CROSS_ORIGIN]),
        ]);

        /** @param {string} path The target */
        const reached = async (path) => {
          const before = server.backend.requests.length;
          const answer = await exchange(server.url, { path });
          return { status: answer.status, backend: server.backend.requests.slice(before).map((seen) => seen.url) };
        };
        const outcomes = {
          dotDot: await reached("/api/a/../ok"),
          encoded: await reached("/api/%2e%2e/dms/page"),
          encodedUpper: await reached("/api/a/%2E%2E/ok2"),
          backslash: await reached("/api/a\\..\\ok3"),
          climbOut: await reached("/spec/../auth/x"),
          doubleSlash: await reached("/api/x/..//host"),
          outsidePrefix: await reached("/auth/pagelayout"),
          examples: await reached("/exports/report.pdf"),
        };
        observe(ctx, "the proxy matches and sends the normalized path", outcomes, [
          ctx.equal("/api/a/../ok reaches /api/ok", outcomes.dotDot.backend, ["/api/ok"]),
          ctx.equal("%2e%2e is a dot segment too: /api/%2e%2e/dms/page reaches /dms/page", outcomes.encoded.backend, ["/dms/page"]),
          ctx.equal("%2E%2E in capitals as well", outcomes.encodedUpper.backend, ["/api/ok2"]),
          ctx.equal("a backslash is a slash", outcomes.backslash.backend, ["/api/ok3"]),
          ctx.equal("a path climbing out of a prefix reaches no backend route of it", outcomes.climbOut.backend.some((url) => url.startsWith("/spec")), false),
          ctx.equal("/api/x/..//host stays a page: no proxied request to //host", outcomes.doubleSlash.backend.some((url) => url.startsWith("//")), false),
          ctx.equal("a path outside every prefix never reaches the backend route", outcomes.outsidePrefix.backend.some((url) => url.startsWith("/auth/pagelayout")), false),
          ctx.equal("an undeclared backend path is a page: the backend is not asked for /exports", outcomes.examples.backend.some((url) => url.startsWith("/exports")), false),
        ]);

        const forms = {
          authority: await rawExchange(server.url, "GET http://evil.example/api/x HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n"),
          protocolRelative: await rawExchange(server.url, "GET //evil.example/api/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
          backslashHost: await rawExchange(server.url, "GET /\\evil.example/api/x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
          asterisk: await rawExchange(server.url, "OPTIONS * HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"),
        };
        observe(ctx, "a request target that is not origin-form is refused with 400", Object.fromEntries(Object.entries(forms).map(([name, answer]) => [name, answer.text])), [
          ctx.equal("absolute, protocol-relative, backslash-host and * targets answer 400", Object.values(forms).map((answer) => answer.status), [400, 400, 400, 400]),
          ctx.equal("the body is the plain Bad Request", Object.values(forms).map((answer) => /Bad Request/.test(answer.text.split("\r\n\r\n")[1] ?? "")), [true, true, true, true]),
          ctx.equal("none reached the backend", server.backend.requests.some((seen) => /evil/.test(seen.url) || seen.headers.host === "evil.example"), false),
        ]);
      });

      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: "not json" } }, async (server) => {
        const proxies = server.log().split("\n").filter((line) => line.startsWith("Ignoring DMS_BACKEND_PROXIES"));
        const object = await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: '{"path":"/x/**"}' } }, async (other) => other.log().split("\n").filter((line) => line.startsWith("Ignoring DMS_BACKEND_PROXIES")));
        observe(ctx, "DMS_BACKEND_PROXIES that is not a JSON array is reported and ignored", { text: proxies, object }, [
          ctx.equal("a value that is not JSON", proxies, ["Ignoring DMS_BACKEND_PROXIES: not a JSON array"]),
          ctx.equal("a JSON object is not an array either", object, ["Ignoring DMS_BACKEND_PROXIES: not a JSON array"]),
        ]);
      });
    },
  },
];

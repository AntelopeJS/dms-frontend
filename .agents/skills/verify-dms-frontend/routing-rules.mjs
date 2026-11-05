import { readFileSync } from "node:fs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";

const SOURCE = readFileSync(new URL("./routing-fixture-rules.mjs", import.meta.url), "utf8");
const PUBLIC_CACHE = "public, max-age=300, stale-while-revalidate=3600";
const PRIVATE_CACHE = "private, no-cache";
const SHARED_VARY = "X-Inertia, Cookie, Accept-Encoding";
const SHELL = /<script data-page="app" type="application\/json">.*<\/script><div id="app"><\/div>/s;

/**
 * @param {import("node:http").IncomingMessage} request The request
 * @param {import("node:http").ServerResponse} response The response
 */
function backend(request, response) {
  request.resume();
  const url = new URL(request.url, "http://backend.local");
  const send = (/** @type {number} */ status, /** @type {unknown} */ body) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (url.pathname === "/dms/page") {
    const path = url.searchParams.get("path");
    if (path === "/area/missing") return send(404, { message: "error.page_not_found" });
    const route = { fullSlug: path, fullId: path.slice(1), hasAccess: true };
    if (path !== "/area/unknown") route.publicAccess = path !== "/area/closed";
    return send(200, { componentName: path, route, layout: { layout: { componentName: "DefaultLayout" } } });
  }
  return send(200, {});
}

const inertia = { "x-inertia": "true", accept: "text/html, application/xhtml+xml" };
const document = { accept: "text/html" };

export const journeys = [
  {
    id: "routing-rules",
    title: "route rules: public cache only under the narrow conditions, ssr: false, headers, merging by specificity, and every rejected rule warned about",
    entryPoint: "document and Inertia requests to a second `ajs dms start` whose server modules declare route rules",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { backend, modules: { source: SOURCE, keepOriginal: true } }, async (server) => {
        const lines = server.log().split("\n");
        const rule = (id, pattern, reason) => `Frontend module ${id} declares the route rule "${pattern}", which is ignored: ${reason}.`;
        const cacheReason = "cache is neither false nor { public: true, maxAge, staleWhileRevalidate? } in seconds";
        const own = (name) => `the server sets "${name}" itself (use cache for cache-control)`;
        const text = (name) => `"${name}" is not a header with a text value`;
        const expected = [
          rule("rules/low", "/dup", "rules/mod (priority 3) declares it"),
          rule("rules/mod", "/bad-public", cacheReason),
          rule("rules/mod", "/bad-age", cacheReason),
          rule("rules/mod", "/bad-fraction", cacheReason),
          rule("rules/mod", "/bad-swr", cacheReason),
          rule("rules/mod", "/bad-ssr", "ssr is either left out or false"),
          rule("rules/mod", "/bad-cache-control", own("Cache-Control")),
          rule("rules/mod", "/bad-set-cookie", own("set-cookie")),
          rule("rules/mod", "/bad-vary", own("vary")),
          rule("rules/mod", "/bad-type", own("content-type")),
          rule("rules/mod", "/bad-length", own("content-length")),
          rule("rules/mod", "/bad-inertia", own("x-inertia")),
          rule("rules/mod", "/bad-version", own("x-inertia-version")),
          rule("rules/mod", "/bad-name", text("bad name")),
          rule("rules/mod", "/bad-value", text("x-a")),
          rule("rules/mod", "/bad-text", text("x-a")),
          rule("rules/mod", "/bad-object", "it is not an object"),
        ];
        observe(ctx, "every rejected rule is warned about with its reason", { warnings: lines.filter((line) => line.includes("route rule")) }, [
          ctx.equal("each warning appears exactly once", expected.map((line) => lines.filter((candidate) => candidate === line).length), expected.map(() => 1)),
          ctx.equal("and there is no other route rule warning", lines.filter((line) => line.includes("route rule")).length, expected.length),
        ]);

        const get = (/** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}, method = "GET") => exchange(server.url, { method, path, headers });
        const table = {
          document: await get("/terms", document),
          inertia: await get("/terms", inertia),
          noSwr: await get("/no-swr", inertia),
          zero: await get("/zero", inertia),
          cookie: await get("/terms", { ...inertia, cookie: "a=b" }),
          language: await get("/terms", { ...inertia, "x-content-language": "fr" }),
          head: await get("/terms", document, "HEAD"),
          areaOpen: await get("/area/open", inertia),
          areaClosed: await get("/area/closed", inertia),
          areaUnknown: await get("/area/unknown", inertia),
          areaPrivate: await get("/area/private", inertia),
          areaMissing: await get("/area/missing", inertia),
          plain: await get("/not-ruled", inertia),
        };
        const cacheOf = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.headers["cache-control"] ?? null];
        observe(ctx, "a public cache rule applies to an anonymous GET of a public page, and only then", Object.fromEntries(Object.entries(table).map(([name, answer]) => [name, { status: answer.status, cache: answer.headers["cache-control"], vary: answer.headers.vary }])), [
          ctx.equal("a document: public, max-age and stale-while-revalidate, Vary on X-Inertia and Cookie", [table.document.status, table.document.headers["cache-control"], table.document.headers.vary], [200, PUBLIC_CACHE, SHARED_VARY]),
          ctx.equal("an Inertia answer: the same", [table.inertia.status, table.inertia.headers["cache-control"], table.inertia.headers.vary], [200, PUBLIC_CACHE, SHARED_VARY]),
          ctx.equal("without staleWhileRevalidate the directive is left out", cacheOf(table.noSwr), [200, "public, max-age=60"]),
          ctx.equal("a maxAge of 0 is valid", cacheOf(table.zero), [200, "public, max-age=0"]),
          ctx.equal("with any Cookie the private default stays", [cacheOf(table.cookie), table.cookie.headers.vary], [[200, PRIVATE_CACHE], "X-Inertia, Accept-Encoding"]),
          ctx.equal("with x-content-language the private default stays", cacheOf(table.language), [200, PRIVATE_CACHE]),
          ctx.equal("a HEAD keeps the private default", cacheOf(table.head), [200, PRIVATE_CACHE]),
          ctx.equal("under a rule for a whole area, a public page is cached", cacheOf(table.areaOpen), [200, PUBLIC_CACHE]),
          ctx.equal("a page that is not public to anyone keeps the private default", cacheOf(table.areaClosed), [200, PRIVATE_CACHE]),
          ctx.equal("a page whose route says nothing about publicAccess keeps it", cacheOf(table.areaUnknown), [200, PRIVATE_CACHE]),
          ctx.equal("cache: false keeps the default under a broader rule", cacheOf(table.areaPrivate), [200, PRIVATE_CACHE]),
          ctx.equal("an answer that is not a 200 is never cached", cacheOf(table.areaMissing), [404, PRIVATE_CACHE]),
          ctx.equal("a page without any rule is private", cacheOf(table.plain), [200, PRIVATE_CACHE]),
        ]);

        const shell = await get("/terms", document);
        const page = bodyJson(table.inertia);
        observe(ctx, "ssr: false serves the client-rendered shell and leaves Inertia visits unchanged", { shell: shell.text.slice(0, 1500), page }, [
          ctx.holds("a document request gets the shell: the page object and an empty app element", SHELL.test(shell.text), shell.text.slice(0, 200)),
          ctx.equal("an Inertia visit gets the page object", [page.component, page.props.path, page.props.page.route.publicAccess], ["DmsDynamicPage", "/terms", true]),
        ]);

        const headers = {
          reportDocument: await get("/reports/a", document),
          reportInertia: await get("/reports/a", inertia),
          other: await get("/other", inertia),
          x: await get("/m/x", inertia),
          y: await get("/m/y", inertia),
          deep: await get("/m/x/y", inertia),
          dup: await get("/dup", inertia),
          low: await get("/only-low", inertia),
          bad: await Promise.all(["/bad-cache-control", "/bad-set-cookie", "/bad-vary", "/bad-type", "/bad-name", "/bad-value", "/bad-text", "/bad-public", "/bad-age"].map((path) => get(path, inertia))),
        };
        const pick = (/** @type {import("./proxy-http.mjs").Exchange} */ answer, /** @type {string[]} */ names) => names.map((name) => answer.headers[name] ?? null);
        observe(ctx, "headers are added to documents and Inertia answers and merge from the least to the most specific pattern", Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "bad").map(([name, answer]) => [name, answer.headers])), [
          ctx.equal("a document carries the rule's headers, names in lower case", pick(headers.reportDocument, ["x-robots-tag", "x-mixed-case"]), ["noindex", "kept"]),
          ctx.equal("an Inertia answer carries them", pick(headers.reportInertia, ["x-robots-tag", "x-mixed-case"]), ["noindex", "kept"]),
          ctx.equal("a page outside the pattern carries none", pick(headers.other, ["x-robots-tag"]), [null]),
          ctx.equal("/m/x: ** then /m/* then /m/x each override what they set", pick(headers.x, ["x-a", "x-b", "x-c"]), ["1", "2", "3"]),
          ctx.equal("/m/y: the /m/* rule sets x-b and x-c", pick(headers.y, ["x-a", "x-b", "x-c"]), ["1", "2", "2"]),
          ctx.equal("/m/x/y: only /m/** covers it", pick(headers.deep, ["x-a", "x-b", "x-c"]), ["1", "1", null]),
          ctx.equal("of one pattern declared twice the higher-priority module's rule stands", pick(headers.dup, ["x-owner"]), ["mod"]),
          ctx.equal("a rule of a lower-priority module on another pattern works", pick(headers.low, ["x-owner"]), ["low"]),
          ctx.equal("a rejected rule is rejected whole: it changes nothing", headers.bad.map((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.headers["x-a"] ?? null, answer.headers["x-inertia"], answer.headers.vary, answer.headers["cache-control"]]), headers.bad.map(() => [200, null, "true", "X-Inertia, Accept-Encoding", PRIVATE_CACHE])),
        ]);
      });

      const web = ctx.state.webUrl;
      const preview = await exchange(web, { path: "/dms-preview", headers: document });
      const auth = await exchange(web, { path: "/auth", headers: document });
      observe(ctx, "the run's own ssr: false rule (/dms-preview) against a server-rendered page", { preview: preview.text.slice(0, 800), auth: auth.text.slice(0, 800) }, [
        ctx.holds("/dms-preview is the client-rendered shell", SHELL.test(preview.text), preview.text.slice(0, 300)),
        ctx.holds("/auth is rendered on the server: its head carries the page's own title and its body is no shell", !SHELL.test(auth.text) && auth.text.includes("<title>Connect to your account | "), auth.text.slice(0, 300)),
        ctx.holds("the shell carries no server-rendered title", !preview.text.includes("<title>Connect to your account"), preview.text.slice(0, 200)),
        ctx.equal("both carry the private default", [preview.headers["cache-control"], auth.headers["cache-control"]], [PRIVATE_CACHE, PRIVATE_CACHE]),
      ]);
    },
  },
];

import { keysOf, textAt } from "./json.mjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { exchange, rawExchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { cookieHeader, setCookies } from "./proxy-signin.mjs";

const HEADER_LIMIT = 16384;

export const journeys = [
  {
    id: "static-files-document",
    title: "the production document links its stylesheet before the entry script, preloads the page's language catalog and carries the runtime options",
    entryPoint: "GET /auth of the run's `ajs dms start`, signed out",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const answer = await exchange(ctx.state.webUrl, { path: "/auth", headers: { accept: "text/html" } });
      const client = join(ctx.state.runPlayground, ".dms-frontend", "dist", "client");
      /** @type {unknown} */
      const manifest = JSON.parse(readFileSync(join(client, ".vite", "manifest.json"), "utf8"));
      const catalog = textAt(manifest, "locales.generated/en.ts", "file");
      const html = answer.text;
      const styleAt = html.search(/<link rel="stylesheet"/);
      const scriptAt = html.search(/<script[^>]*type="module"/);
      const script = /<script[^>]*type="module"[^>]*>/.exec(html)?.[0] ?? "";
      const options = /<script id="dms-public-options" type="application\/json">(.*?)<\/script>/s.exec(html)?.[1];
      /** @type {unknown} */
      const parsed = options ? JSON.parse(options) : undefined;
      observe(ctx, "the signed-out document", { status: answer.status, styleAt, scriptAt, script, catalog, options: options?.slice(0, 300) }, [
        ctx.equal("the page is served", answer.status, 200),
        ctx.holds("the stylesheet link comes before the entry script", styleAt >= 0 && scriptAt > styleAt, `${styleAt} before ${scriptAt}`),
        ctx.holds("the entry script is fetched with a low priority", script.includes('fetchpriority="low"'), script),
        ctx.holds("a signed-out visitor's page preloads no catalog: it carries the messages it read", !html.includes(`href="/${catalog}"`) && html.includes('id="dms-ssr-messages"'), String(catalog)),
        ctx.holds("the runtime options are a JSON object by module id", keysOf(parsed).includes("playground-frontend") && keysOf(parsed).includes("antelopejs__dms-frontend-vue"), options?.slice(0, 200)),
        ctx.holds("a < in the options is escaped, so they cannot close the script", !(options ?? "").includes("<"), "checked"),
      ]);
      const credentials = ctx.adminCredentials();
      const login = await exchange(ctx.state.webUrl, { method: "POST", path: "/auth/login", headers: { origin: ctx.state.webUrl, "content-type": "application/json" }, body: JSON.stringify({ email: credentials.email, password: credentials.password }) });
      const cookie = cookieHeader(setCookies(login));
      const signedIn = await exchange(ctx.state.webUrl, { path: "/settings", headers: { accept: "text/html", cookie } });
      observe(ctx, "the signed-in document", { status: signedIn.status, catalog }, [
        ctx.equal("the page is served", signedIn.status, 200),
        ctx.holds("the catalog of the page's language is preloaded: the file the client manifest names for English", Boolean(catalog) && signedIn.text.includes(`<link rel="modulepreload" crossorigin href="/${catalog}">`), String(catalog)),
      ]);
    },
  },
  {
    id: "static-files-client-errors",
    title: "a request Node refuses before any route runs gets a status and, for oversized headers, a hint in the server output",
    entryPoint: "raw requests to a second `ajs dms start`",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, {}, async (server) => {
        /** @type {Record<number, number>} */
        const sizes = {};
        for (const size of [8000, HEADER_LIMIT - 1000, HEADER_LIMIT + 2000, 60_000]) {
          const answer = await rawExchange(server.url, `GET /dms-preview HTTP/1.1\r\nHost: x\r\nConnection: close\r\nX-Pad: ${"a".repeat(size)}\r\n\r\n`);
          sizes[size] = answer.status;
        }
        const malformed = await rawExchange(server.url, "GET /dms-preview HTTP/1.1\r\nHost x\r\n\r\n");
        const garbage = await rawExchange(server.url, "NOT AN HTTP REQUEST\r\n\r\n");
        const after = await exchange(server.url, { path: "/dms-preview" });
        const log = server.log();
        const hints = log.split("\n").filter((line) => line.startsWith("DMS refused a request with 431"));
        observe(ctx, "oversized and malformed requests", { sizes, malformed: malformed.text.slice(0, 80), garbage: garbage.text.slice(0, 80), hints }, [
          ctx.equal("headers well under the limit are served", sizes[8000], 200),
          ctx.equal("headers just under the limit are served", sizes[HEADER_LIMIT - 1000], 200),
          ctx.equal("headers over the limit answer 431", [sizes[HEADER_LIMIT + 2000], sizes[60_000]], [431, 431]),
          ctx.equal("a malformed header line answers 400", malformed.status, 400),
          ctx.equal("a request that is not HTTP answers 400", garbage.status, 400),
          ctx.equal("the server keeps serving", after.status, 200),
          ctx.equal("one hint per minute explains the 431s, naming the limit", hints, [`DMS refused a request with 431: its headers exceed the ${HEADER_LIMIT}-byte limit. This is most often cookies accumulated on this host (browsers share localhost cookies across ports); clear this site's cookies and reload.`]),
        ]);
      });
    },
  },
];

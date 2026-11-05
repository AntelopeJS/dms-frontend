import { keysOf, parseJson, rowAt } from "../json.mjs";
import { signIn } from "../signin.mjs";
import { cookieOf, get } from "../web.mjs";

/** @typedef {import("../control.d.ts").JourneyContext} Ctx */

const PUBLIC_OPTIONS = /<script id="dms-public-options" type="application\/json">([\s\S]*?)<\/script>/;
const DMS_MODULE = "antelopejs__dms-frontend-vue";
const TOKEN_LIFETIME_SECONDS = 3600;

export const journeys = [
  {
    id: "the-modules-public-options-reach-every-page-and-no-secret-does",
    title: "each module's public options are written into the page by module id, and none of the run's secrets appears in a rendered page",
    entryPoint: "GET /auth, /settings, /dms-preview and /examples/features, and the client entry",
    async run(/** @type {Ctx} */ ctx) {
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      const cookie = await cookieOf(tab);
      const signedOut = await get(ctx, "/auth", { headers: { accept: "text/html" } });
      const options = parseJson(PUBLIC_OPTIONS.exec(signedOut.text)?.[1] ?? "");
      const dms = rowAt(options, DMS_MODULE, "dms");
      await ctx.verify("the options are keyed by module id and hold the manifest's public values", [
        ctx.equal("module ids", keysOf(options).sort(), [DMS_MODULE, "playground-frontend"]),
        ctx.equal("the playground module's option", rowAt(options, "playground-frontend"), { dmsI18nAppLayer: true }),
        ctx.equal("the dashboard's origin", dms?.clientBaseUrl, ctx.state.webUrl),
        ctx.equal("the API is reached through the dashboard's origin", dms?.baseURL, ctx.state.webUrl),
        ctx.equal("the homepage", dms?.homepage, "/examples/overview"),
        ctx.equal("no OAuth provider", dms?.oauthProviders, []),
        ctx.equal("token lifetime", dms?.token, { maxAgeInSeconds: TOKEN_LIFETIME_SECONDS }),
      ]);
      const secrets = Object.entries(ctx.state.secrets);
      const paths = ["/auth", "/settings", "/dms-preview", "/examples/features"];
      const answers = await Promise.all(paths.map(async (path) => ({ path, answer: await get(ctx, path, { cookie: path === "/auth" ? undefined : cookie, headers: { accept: "text/html" } }) })));
      const leaks = answers.flatMap(({ path, answer }) => secrets.filter(([, value]) => answer.text.includes(value)).map(([name]) => `${name} in ${path}`));
      await ctx.verify("no secret of the run is written into a rendered page", [ctx.equal("secrets found in pages", leaks, [])]);
      const entry = /<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+)"/.exec(signedOut.text)?.[1] ?? "/assets/missing.js";
      const asset = await get(ctx, entry);
      await ctx.verify("nor in the client entry", [
        ctx.equal("the entry is served", asset.status, 200),
        ctx.equal("secrets found in the entry", secrets.filter(([, value]) => asset.text.includes(value)).map(([name]) => name), []),
      ]);
    },
  },
];

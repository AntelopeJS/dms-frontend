import { exchange } from "./proxy-http.mjs";
import { observe } from "./proxy-satellite.mjs";
import { signIn } from "./signin.mjs";
import { cookieOf } from "./web.mjs";

const TITLES = { en: "Connect to your account", fr: "Connectez-vous" };

/**
 * @param {import("./proxy-http.mjs").Exchange} answer A document
 * @returns {{ lang: string | undefined, title: string | undefined }} The language and title of the page
 */
function describe(answer) {
  return { lang: /<html[^>]*\slang="([^"]*)"/.exec(answer.text)?.[1], title: /<title>([^<]*)<\/title>/.exec(answer.text)?.[1] };
}

export const journeys = [
  {
    id: "sessions-language",
    title: "the dms_locale cookie sets the language of a page without a user language, and an unknown value is ignored",
    entryPoint: "GET /auth with dms_locale cookies, then the language switcher of the sign-in page",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const web = ctx.state.webUrl;
      const page = (/** @type {string | undefined} */ cookie) => exchange(web, { path: "/auth", headers: cookie === undefined ? { accept: "text/html" } : { accept: "text/html", cookie } });
      const none = await page();
      const french = await page("dms_locale=fr");
      const json = await page("dms_locale=%22fr%22");
      const unknown = await page("dms_locale=xx");
      const malformed = await page("dms_locale=%E0%A4%A");
      const english = await page("dms_locale=en");
      const rows = { none: describe(none), french: describe(french), json: describe(json), unknown: describe(unknown), malformed: describe(malformed), english: describe(english) };
      observe(ctx, "the language of a signed-out page follows the cookie", rows, [
        ctx.equal("with no cookie the page is English", rows.none.lang, "en"),
        ctx.equal("dms_locale=fr renders the page in French", rows.french.lang, "fr"),
        ctx.equal("a JSON-encoded value is read the same way", rows.json.lang, "fr"),
        ctx.equal("the html tag carries one lang attribute, not two", [french, none].map((answer) => (/<html[^>]*>/.exec(answer.text)?.[0].match(/\slang=/g) ?? []).length), [1, 1]),
        ctx.equal("a language the application does not support is ignored", rows.unknown.lang, "en"),
        ctx.equal("a value that is not URI-encoded is ignored", [malformed.status, rows.malformed.lang], [200, "en"]),
        ctx.equal("the French page has a French title, the English page an English one", [rows.french.title === rows.none.title, rows.none.title?.startsWith(TITLES.en)], [false, true]),
      ]);

      const tab = await ctx.tab("anon");
      await tab.goto("/auth");
      const select = tab.page.getByRole("combobox", { name: "Language" });
      await select.first().waitFor({ state: "visible", timeout: 30_000 });
      await tab.snapshot("the sign-in page with its language switcher");
      let chosen = false;
      for (let attempt = 0; attempt < 15 && !chosen; attempt += 1) {
        await select.first().click({ timeout: 3000 }).catch(() => undefined);
        chosen = await tab.page.getByRole("option", { name: "français", exact: true }).first().click({ timeout: 2000 }).then(() => true, () => false);
      }
      await tab.snapshot("after choosing");
      await tab.page.waitForFunction(() => document.cookie.includes("dms_locale"), undefined, { timeout: 15_000 }).catch(() => undefined);
      const cookies = (await tab.page.context().cookies()).filter((entry) => entry.name === "dms_locale");
      const lang = await tab.page.evaluate(() => document.documentElement.lang);
      await tab.reload();
      const afterReload = await tab.page.evaluate(() => document.documentElement.lang);
      const entry = cookies[0];
      const lifetime = entry ? Math.round(entry.expires - Date.now() / 1000) : 0;
      observe(ctx, "choosing a language in the footer", { chosen, cookies, lang, afterReload, lifetime }, [
        ctx.holds("the French option was chosen", chosen, chosen),
        ctx.equal("the page switches to French", lang, "fr"),
        ctx.equal("the cookie is dms_locale, for the whole site, SameSite=Lax", [entry?.name, entry?.path, entry?.sameSite], ["dms_locale", "/", "Lax"]),
        ctx.holds("it lasts one year (365 days, within a minute)", Math.abs(lifetime - 31536000) <= 60, lifetime),
        ctx.equal("the visitor's choice survives a reload", afterReload, "fr"),
      ]);
    },
  },
  {
    id: "sessions-language-order",
    title: "a signed-in user's language decides the page, whatever the dms_locale cookie says",
    entryPoint: "POST /dms/pages/settings/user/region/preferences, then GET /settings with a dms_locale cookie",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const saved = await ctx.api("choose French", { method: "POST", path: "/dms/pages/settings/user/region/preferences", body: { language: "fr" } });
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      const cookie = await cookieOf(tab);
      const web = ctx.state.webUrl;
      const page = (/** @type {string} */ extra) => exchange(web, { path: "/settings", headers: { accept: "text/html", cookie: `${cookie}; ${extra}` } });
      const withEnglishCookie = describe(await page("dms_locale=en"));
      const withoutCookie = describe(await page("dms_locale=xx"));
      const reset = await ctx.api("choose English", { method: "POST", path: "/dms/pages/settings/user/region/preferences", body: { language: "en" } });
      await tab.goto("/auth");
      await tab.page.context().clearCookies();
      await signIn(ctx, tab);
      const english = describe(await exchange(web, { path: "/settings", headers: { accept: "text/html", cookie: `${await cookieOf(tab)}; dms_locale=fr` } }));
      await ctx.verify("the user's language wins over the cookie", [
        ctx.equal("French is saved", saved.status, 200),
        ctx.equal("a French user with an English cookie gets French", withEnglishCookie.lang, "fr"),
        ctx.equal("an unknown cookie changes nothing", withoutCookie.lang, "fr"),
        ctx.equal("English is saved", reset.status, 200),
        ctx.equal("an English user with a French cookie gets English", english.lang, "en"),
      ]);
    },
  },
];

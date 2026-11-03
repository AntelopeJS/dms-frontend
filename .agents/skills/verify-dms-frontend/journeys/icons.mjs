import { keysOf, listAt, numberAt, parseJson, rowAt, textAt } from "../json.mjs";
import { signIn } from "../signin.mjs";
import { cookieOf, get, header } from "../web.mjs";

/**
 * @typedef {import("../control.d.ts").JourneyContext} Ctx
 * @typedef {import("../control.d.ts").Request} Request
 */

const ICON_API = "/api/_dms/icons";
const CACHED = "public, max-age=604800, stale-while-revalidate=86400";
const MIN_ICONS_ON_A_TABLE_PAGE = 20;
const SETTLE_MS = 3000;

/**
 * @param {string} html A rendered document
 * @returns {{ symbols: string[], uses: string[] }} The sprite's symbol ids and the targets of the page's uses
 */
function spriteOf(html) {
  const sprite = /<svg id="dms-icon-sprite"[\s\S]*?<\/svg>/.exec(html)?.[0] ?? "";
  const symbols = [...sprite.matchAll(/<symbol[^>]*\sid="([^"]+)"/g)].map((match) => match[1]);
  const uses = [...html.matchAll(/<use href="#([^"]+)"/g)].map((match) => match[1]);
  return { symbols, uses };
}

/**
 * @param {Ctx} ctx The journey context
 * @param {string} path A path below the icon route
 * @param {{ method?: string, body?: string }} [options] Request options
 * @returns {Promise<import("../web.mjs").Answer>} The answer
 */
function icons(ctx, path, options = {}) {
  return get(ctx, `${ICON_API}/${path}`, options);
}

export const journeys = [
  {
    id: "the-icon-route-answers-iconify-json-from-the-installed-collections",
    title: "GET /api/_dms/icons/<prefix>.json answers Iconify JSON with the documented cache header, and refuses what it cannot serve",
    entryPoint: "GET /api/_dms/icons/lucide.json?icons=house",
    async run(/** @type {Ctx} */ ctx) {
      const lucide = await icons(ctx, "lucide.json?icons=house,nonexistent-zzz");
      const body = parseJson(lucide.text);
      await ctx.verify("lucide answers the icon it holds and names the one it lacks", [
        ctx.equal("status", lucide.status, 200),
        ctx.equal("content-type", header(lucide, "content-type"), "application/json"),
        ctx.equal("cache-control", header(lucide, "cache-control"), CACHED),
        ctx.equal("prefix", textAt(body, "prefix"), "lucide"),
        ctx.equal("icons", keysOf(rowAt(body, "icons")), ["house"]),
        ctx.holds("the icon has an SVG body", (textAt(body, "icons", "house", "body") ?? "").includes("<path"), textAt(body, "icons", "house", "body")?.slice(0, 60)),
        ctx.equal("not_found", listAt(body, "not_found"), ["nonexistent-zzz"]),
        ctx.equal("the collection's size", [numberAt(body, "width"), numberAt(body, "height")], [24, 24]),
      ]);
      const ph = parseJson((await icons(ctx, "ph.json?icons=house")).text);
      await ctx.verify("the phosphor collection is installed too", [
        ctx.equal("prefix", textAt(ph, "prefix"), "ph"),
        ctx.equal("icons", keysOf(rowAt(ph, "icons")), ["house"]),
        ctx.equal("its size", [numberAt(ph, "width"), numberAt(ph, "height")], [256, 256]),
      ]);
      const head = await icons(ctx, "lucide.json?icons=house", { method: "HEAD" });
      await ctx.verify("HEAD is answered with the same headers and no body", [
        ctx.equal("status", head.status, 200),
        ctx.equal("cache-control", header(head, "cache-control"), CACHED),
        ctx.equal("body", head.text, ""),
      ]);
      const post = await icons(ctx, "lucide.json?icons=house", { method: "POST", body: "{}" });
      await ctx.verify("a write is refused", [ctx.equal("status", post.status, 405)]);
    },
  },
  {
    id: "the-icon-route-refuses-unknown-collections-and-bad-names",
    title: "an unknown collection answers 404 and a name outside Iconify's rule answers 400, never cached",
    entryPoint: "GET /api/_dms/icons/<prefix>.json?icons=<names>",
    async run(/** @type {Ctx} */ ctx) {
      const unknown = await icons(ctx, "nope.json?icons=house");
      await ctx.verify("an unknown collection answers 404", [
        ctx.equal("status", unknown.status, 404),
        ctx.equal("body", parseJson(unknown.text), { message: "Unknown icon collection" }),
        ctx.equal("cache-control", header(unknown, "cache-control"), "no-store"),
      ]);
      const invalid = [
        ["an upper-case name", "lucide.json?icons=House"],
        ["an underscore", "lucide.json?icons=a_b"],
        ["a leading hyphen", "lucide.json?icons=-a"],
        ["a double hyphen", "lucide.json?icons=a--b"],
        ["a trailing hyphen", "lucide.json?icons=a-"],
        ["one bad name among good ones", "lucide.json?icons=house,Bad"],
        ["an empty list", "lucide.json?icons="],
        ["no icons parameter", "lucide.json"],
        ["an upper-case collection", "Lucide.json?icons=house"],
        ["a path as the collection", "..%2Flucide.json?icons=house"],
      ];
      const answers = await Promise.all(invalid.map(async ([label, path]) => ({ label, answer: await icons(ctx, path) })));
      await ctx.verify(
        "each invalid request is refused and not cached",
        answers.flatMap(({ label, answer }) => [
          ctx.holds(`${label} answers 400 or 404`, answer.status === 400 || answer.status === 404, answer.status),
          ctx.equal(`${label} is not cached`, header(answer, "cache-control"), "no-store"),
        ]),
      );
      await ctx.verify("a name outside the rule is a 400 with the documented message", [
        ctx.equal("status", answers[0].answer.status, 400),
        ctx.equal("body", parseJson(answers[0].answer.text), { message: "Invalid icon request" }),
        ctx.equal("an empty list is a 400", answers[6].answer.status, 400),
        ctx.equal("a missing list is a 400", answers[7].answer.status, 400),
      ]);
      const good = await icons(ctx, "lucide.json?icons=house,star");
      await ctx.verify("several valid names are answered together", [ctx.equal("icons", keysOf(rowAt(parseJson(good.text), "icons")).sort(), ["house", "star"])]);
    },
  },
  {
    id: "one-sprite-draws-each-icon-once-and-no-third-party-is-asked",
    title: "a signed-in page carries one hidden sprite of symbols that every icon uses, and loads icons from no other origin",
    entryPoint: "GET /examples/features and the same page in the browser",
    async run(/** @type {Ctx} */ ctx) {
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      const cookie = await cookieOf(tab);
      const page = await get(ctx, "/examples/features", { cookie, headers: { accept: "text/html" } });
      const { symbols, uses } = spriteOf(page.text);
      const unique = new Set(uses);
      await ctx.verify("every use points at a symbol of the sprite, and each symbol is drawn once", [
        ctx.equal("sprite elements", (page.text.match(/<svg id="dms-icon-sprite"/g) ?? []).length, 1),
        ctx.holds("the page draws icons", uses.length > MIN_ICONS_ON_A_TABLE_PAGE, uses.length),
        ctx.equal("every use has its symbol", [...unique].filter((id) => !symbols.includes(id)), []),
        ctx.equal("symbols are unique", new Set(symbols).size, symbols.length),
        ctx.holds("an icon repeated on the page is sent once", uses.length > unique.size, `${uses.length} uses, ${unique.size} symbols`),
      ]);
      /** @type {Set<string>} */
      const origins = new Set();
      tab.page.on("request", (/** @type {Request} */ request) => origins.add(new URL(request.url()).origin));
      await tab.goto("/examples/features");
      await ctx.verify("the sidebar is on screen", [tab.visible({ role: "link", name: "Feature index" })]);
      await tab.page.waitForTimeout(SETTLE_MS);
      const own = new Set([ctx.state.webUrl, ctx.state.apiUrl]);
      await ctx.verify("the browser asked only the frontend and the backend", [ctx.equal("origins other than the run's", [...origins].filter((origin) => !own.has(origin)), [])]);
      const live = await tab.page.evaluate(() => ({
        sprites: document.querySelectorAll("svg#dms-icon-sprite").length,
        broken: [...document.querySelectorAll("svg use")].filter((use) => !document.getElementById((use.getAttribute("href") ?? "").slice(1))).length,
      }));
      await ctx.verify("the hydrated page keeps one sprite and every use resolves", [
        ctx.equal("sprites", live.sprites, 1),
        ctx.equal("uses without a symbol", live.broken, 0),
      ]);
    },
  },
];

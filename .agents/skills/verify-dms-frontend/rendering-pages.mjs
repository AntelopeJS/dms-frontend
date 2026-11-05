import { keysOf, listAt, parseJson, rowAt } from "./json.mjs";
import { signIn } from "./signin.mjs";
import { get, header, payloadText, visibleText } from "./web.mjs";
import { PRIVATE, HTML, CLICKS, CLICK_WAIT_MS, HYDRATION_WAIT_MS, signedIn } from "./rendering-protocol.mjs";

/**
 * @typedef {import("./control.d.ts").JourneyContext} Ctx
 * @typedef {import("./control.d.ts").Request} Request
 */

export const journeys = [
  {
    id: "the-data-a-page-read-is-drawn-by-the-server-and-handed-over",
    title: "the server waits for a page's data, draws it, carries it in the payload, and the browser does not read it again",
    entryPoint: "GET /table-view/table-view-users, then the same page in the browser",
    async run(/** @type {Ctx} */ ctx) {
      const { tab, cookie } = await signedIn(ctx);
      const answer = await get(ctx, "/table-view/table-view-users", { cookie, headers: HTML });
      const payload = listAt({ payload: parseJson(payloadText(answer.text) ?? "") }, "payload");
      const head = rowAt({ head: payload[0] }, "head");
      const dataIndex = Number(head?.data);
      await ctx.verify("the HTML already holds the row the page lists", [
        ctx.equal("status", answer.status, 200),
        ctx.holds("the first user of the list is in the drawn page", visibleText(answer.text).includes("ada.lovelace@example.com"), "ada.lovelace@example.com"),
      ]);
      await ctx.verify("the payload is a devalue document of data, errors and state", [
        ctx.equal("its root keys", keysOf(head), ["data", "errors", "state"]),
        ctx.holds("the page's list count is among the data keys", keysOf(payload[dataIndex]).some((key) => key.endsWith("table-view.table-view-users-tab-counts")), keysOf(payload[dataIndex]).join(" | ")),
      ]);
      /** @type {string[]} */
      const reads = [];
      tab.page.on("request", (/** @type {Request} */ request) => {
        if (["fetch", "xhr"].includes(request.resourceType())) reads.push(new URL(request.url()).pathname);
      });
      await tab.goto("/table-view/table-view-users");
      await ctx.verify("the table is on screen", [tab.visible({ role: "cell", name: "Ada Lovelace" })]);
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      await ctx.verify("the browser reads no list of users on hydration", [
        ctx.equal("requests for the users' data", reads.filter((path) => path.startsWith("/api/user") || path.startsWith("/api/tables")), []),
        ctx.holds("it did open its realtime session", reads.includes("/api/realtime/session"), reads.join(" ")),
      ]);
    },
  },
  {
    id: "an-unknown-page-renders-the-error-page-with-its-status",
    title: "a path no module owns answers a rendered error page with the 404 status, and a page without an icon gets the empty one",
    entryPoint: "GET /nonexistent-page, GET /dms-preview",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const missing = await get(ctx, "/nonexistent-page", { cookie, headers: HTML });
      await ctx.verify("the error page is rendered with the 404 status", [
        ctx.equal("status", missing.status, 404),
        ctx.equal("content-type", header(missing, "content-type"), "text/html"),
        ctx.equal("cache-control", header(missing, "cache-control"), PRIVATE),
        ctx.holds("the app root is server-rendered", missing.text.includes('data-server-rendered="true"'), "data-server-rendered"),
        ctx.holds("a payload is carried", payloadText(missing.text) !== undefined, "dms-payload"),
      ]);
      const preview = await get(ctx, "/dms-preview", { cookie, headers: HTML });
      await ctx.verify("a page that declares no icon gets one empty icon link", [
        ctx.equal("icon links", preview.text.match(/<link rel="icon"[^>]*>/g), ['<link rel="icon" href="data:," />']),
      ]);
      const dashboard = await get(ctx, "/settings", { cookie, headers: HTML });
      await ctx.verify("a page that declares its icon keeps only that one", [
        ctx.equal("icon links", dashboard.text.match(/<link rel="icon"[^>]*>/g), ['<link rel="icon" href="/images/antelope-logo/icon.svg" type="image/svg+xml">']),
      ]);
    },
  },
  {
    id: "key-hints-are-drawn-for-the-keyboard-the-server-was-told",
    title: "the server draws the search hint with the platform of the keyboard cookie, and the browser then prints its own",
    entryPoint: "GET /settings with the dms-keyboard-platform cookie, then the page in a browser",
    async run(/** @type {Ctx} */ ctx) {
      const { tab, cookie } = await signedIn(ctx);
      /**
       * @param {string} platform The cookie's value
       * @returns {Promise<string>} The text of the search button's key hint
       */
      const hint = async (platform) => {
        const answer = await get(ctx, "/settings", { cookie: `${cookie}; dms-keyboard-platform=${platform}`, headers: HTML });
        return /Search…<\/span>[\s\S]*?<kbd[^>]*>(?:<!--\[-->)?([^<]*)/.exec(answer.text)?.[1] ?? "no hint found";
      };
      await ctx.verify("a Mac cookie draws the command key and any other draws Ctrl", [
        ctx.equal("mac hint", await hint("mac"), "⌘K"),
        ctx.equal("other hint", await hint("other"), "Ctrl K"),
      ]);
      await tab.goto("/settings");
      await ctx.verify("the browser then prints its own keyboard's hint", [tab.visible({ role: "button", name: /Search…\s*Ctrl K/i })]);
    },
  },
  {
    id: "the-payload-is-escaped-so-data-cannot-close-its-script",
    title: "a stored value holding a closing script tag reaches the page only with its slashes and angle brackets escaped",
    entryPoint: "POST /api/user/new, then GET /table-view/table-view-users",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const name = "a</script><b>x/y";
      const created = await ctx.api("create a user whose name closes a script tag", { method: "POST", path: "/api/user/new", body: { name, email: ctx.email("payload") } });
      await ctx.verify("the user is stored", [ctx.equal("status", created.status, 200)]);
      const answer = await get(ctx, "/table-view/table-view-users", { cookie, headers: HTML });
      const payload = payloadText(answer.text) ?? "";
      await ctx.verify("the payload holds the name with the slash as \\/ and the bracket escaped", [
        ctx.holds("the escaped name is in the payload", payload.includes("a\\u003C\\/script>\\u003Cb>x\\/y"), payload.slice(0, 120)),
        ctx.equal("the payload holds no raw angle bracket", payload.includes("<"), false),
        ctx.equal("every slash of the payload is escaped", /(?<!\\)\//.test(payload), false),
      ]);
      await ctx.verify("the document has no script closed early by the name", [
        ctx.equal("no literal closing tag followed by the injected element", answer.text.includes("</script><b>x"), false),
      ]);
    },
  },
  {
    id: "choosing-a-tab-changes-only-the-query-in-the-browser",
    title: "choosing a tab of the page on screen changes the URL's query and sends the frontend server no page request, keeping the page mounted",
    entryPoint: "the tabs of /table-view/table-view-tabs",
    async run(/** @type {Ctx} */ ctx) {
      const PAGE = "/table-view/table-view-tabs";
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      await tab.goto(PAGE);
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      await tab.page.evaluate(() => {
        document.documentElement.dataset.verifyMounted = "kept";
        return true;
      });
      /** @type {string[]} */
      const pageRequests = [];
      tab.page.on("request", (/** @type {Request} */ request) => {
        if (new URL(request.url()).pathname === PAGE) pageRequests.push(request.resourceType());
      });
      const target = "Pending";
      let clicks = 0;
      while (!new URL(tab.page.url()).search && clicks < CLICKS) {
        clicks += 1;
        await tab.page.getByRole("button", { name: new RegExp(`^${target} \\d+$`) }).first().click();
        await tab.page.waitForTimeout(CLICK_WAIT_MS);
      }
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      await ctx.verify("the query changed, the page stayed and no page request was made", [
        ctx.holds("the URL has a query now", new URL(tab.page.url()).search !== "", tab.page.url()),
        ctx.equal("the path is the same", new URL(tab.page.url()).pathname, PAGE),
        ctx.equal("the document was not reloaded", await tab.page.evaluate(() => document.documentElement.dataset.verifyMounted ?? ""), "kept"),
        ctx.equal("requests for the page path", pageRequests, []),
      ]);
    },
  },
];

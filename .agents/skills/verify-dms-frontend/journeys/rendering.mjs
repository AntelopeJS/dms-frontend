import { at, isRow, keysOf, listAt, parseJson, rowAt, textAt } from "../json.mjs";
import { signIn } from "../signin.mjs";
import { cookieOf, get, header, pageObject, payloadText, varies, visibleText } from "../web.mjs";

/**
 * @typedef {import("../control.d.ts").JourneyContext} Ctx
 * @typedef {import("../control.d.ts").Tab} Tab
 * @typedef {import("../control.d.ts").Request} Request
 * @typedef {import("../control.d.ts").Response} Response
 */

const ONCE_KEY = /^shared:[A-Za-z0-9_-]{16}$/;
const FIVE_MINUTES_MS = 5 * 60 * 1000;
const PRIVATE = "private, no-cache";
const HTML = { accept: "text/html" };
const OTHER_ACCOUNT_KEY = "shared:AAAAAAAAAAAAAAAA";
const SLACK_MS = 30_000;
const CLICKS = 10;
const CLICK_WAIT_MS = 500;
const HYDRATION_WAIT_MS = 3000;

/**
 * @param {Ctx} ctx The journey context
 * @returns {Promise<{ cookie: string, tab: Tab }>} A signed-in administrator
 */
async function signedIn(ctx) {
  const tab = await ctx.tab("admin");
  await signIn(ctx, tab);
  return { tab, cookie: await cookieOf(tab) };
}

/**
 * @param {Ctx} ctx The journey context
 * @param {string} cookie The session cookie
 * @param {string} path A page path
 * @param {Record<string, string>} [headers] More request headers
 * @returns {Promise<{ status: number, text: string, headers: Headers, page: Record<string, unknown> | undefined }>} The answer to an Inertia visit and its page object
 */
async function visit(ctx, cookie, path, headers = {}) {
  const version = textAt(pageObject((await get(ctx, "/auth", { headers: HTML })).text), "version") ?? "";
  const answer = await get(ctx, path, { cookie, headers: { "x-inertia": "true", "x-inertia-version": version, ...headers } });
  const parsed = answer.status === 200 ? parseJson(answer.text) : undefined;
  return { ...answer, page: isRow(parsed) ? parsed : undefined };
}

/**
 * @param {Record<string, unknown> | undefined} page An Inertia page object
 * @returns {string[]} The sorted names of its props
 */
function propNames(page) {
  return keysOf(rowAt(page, "props")).sort();
}

/**
 * @param {Record<string, unknown> | undefined} page An Inertia page object
 * @returns {string} The key of its first once prop
 */
function onceKey(page) {
  return keysOf(rowAt(page, "onceProps"))[0] ?? "";
}

export const journeys = [
  {
    id: "a-first-load-is-rendered-on-the-server",
    title: "a document request answers rendered HTML, the page object, the data payload and private caching",
    entryPoint: "GET /settings with a session cookie",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const answer = await get(ctx, "/settings", { cookie, headers: HTML });
      const page = pageObject(answer.text);
      await ctx.verify("the document is HTML with private, no-cache and Vary: X-Inertia", [
        ctx.equal("status", answer.status, 200),
        ctx.equal("content-type", header(answer, "content-type"), "text/html"),
        ctx.equal("cache-control", header(answer, "cache-control"), PRIVATE),
        ctx.holds("Vary names X-Inertia", varies(answer, "X-Inertia"), header(answer, "vary")),
      ]);
      await ctx.verify("the Inertia page object holds the page, the session and the site layout", [
        ctx.equal("component", textAt(page, "component"), "DmsDynamicPage"),
        ctx.equal("url", textAt(page, "url"), "/settings"),
        ctx.equal("path prop", textAt(page, "props", "path"), "/settings"),
        ctx.equal("the user is the administrator", textAt(page, "props", "user", "email"), ctx.adminCredentials().email),
        ctx.holds("a session is present", rowAt(page, "props", "session") !== undefined, keysOf(rowAt(page, "props")).join(",")),
        ctx.holds("the page holds its route", rowAt(page, "props", "page", "route") !== undefined, keysOf(rowAt(page, "props", "page")).join(",")),
        ctx.holds("the site layout is sent", rowAt(page, "props", "shared") !== undefined, keysOf(rowAt(page, "props")).join(",")),
        ctx.equal("errors is an empty object", keysOf(rowAt(page, "props", "errors")), []),
      ]);
      const payload = payloadText(answer.text);
      await ctx.verify("the HTML carries the data payload and a server-rendered app root", [
        ctx.holds("one dms-payload element", payload !== undefined, "dms-payload"),
        ctx.holds("the payload is a JSON array", Array.isArray(parseJson(payload ?? "")), (payload ?? "").slice(0, 80)),
        ctx.holds("the app root is marked server-rendered", answer.text.includes('<div data-server-rendered="true" id="app">'), "data-server-rendered"),
        ctx.holds("the server drew the sidebar widget", visibleText(answer.text).includes("Sidebar widget demo"), "Sidebar widget demo"),
      ]);
    },
  },
  {
    id: "an-inertia-visit-answers-a-json-page-object",
    title: "an X-Inertia visit answers the page object as JSON with the version and private caching",
    entryPoint: "GET /settings with X-Inertia: true",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const document = pageObject((await get(ctx, "/settings", { cookie, headers: HTML })).text);
      const answer = await visit(ctx, cookie, "/settings");
      await ctx.verify("the answer is JSON, flagged X-Inertia, versioned, private and varied", [
        ctx.equal("status", answer.status, 200),
        ctx.equal("content-type", header(answer, "content-type"), "application/json"),
        ctx.equal("x-inertia", header(answer, "x-inertia"), "true"),
        ctx.equal("x-inertia-version names the document's version", header(answer, "x-inertia-version"), textAt(document, "version")),
        ctx.equal("cache-control", header(answer, "cache-control"), PRIVATE),
        ctx.holds("Vary names X-Inertia", varies(answer, "X-Inertia"), header(answer, "vary")),
      ]);
      await ctx.verify("the page object matches the document's", [
        ctx.equal("component", textAt(answer.page, "component"), "DmsDynamicPage"),
        ctx.equal("url", textAt(answer.page, "url"), "/settings"),
        ctx.equal("version", textAt(answer.page, "version"), textAt(document, "version")),
        ctx.equal("the same prop names as the document", propNames(answer.page), propNames(document)),
        ctx.equal("the same user", textAt(answer.page, "props", "user", "email"), textAt(document, "props", "user", "email")),
      ]);
    },
  },
  {
    id: "a-stale-asset-version-answers-409-with-the-location",
    title: "an X-Inertia visit with another asset version answers 409 and names the URL to load in full",
    entryPoint: "GET /settings?tab=1 with X-Inertia-Version: stale",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const answer = await get(ctx, "/settings?tab=1", { cookie, headers: { "x-inertia": "true", "x-inertia-version": "stale-version" } });
      await ctx.verify("the answer is a 409 with the location and the current version", [
        ctx.equal("status", answer.status, 409),
        ctx.equal("x-inertia-location is the requested URL", header(answer, "x-inertia-location"), "/settings?tab=1"),
        ctx.holds("Vary names X-Inertia", varies(answer, "X-Inertia"), header(answer, "vary")),
        ctx.holds("x-inertia-version is the current version, not the stale one", header(answer, "x-inertia-version") !== "" && header(answer, "x-inertia-version") !== "stale-version", header(answer, "x-inertia-version")),
        ctx.equal("the body is empty", answer.text, ""),
      ]);
      const none = await get(ctx, "/settings", { cookie, headers: { "x-inertia": "true" } });
      await ctx.verify("a visit that names no version is answered", [ctx.equal("status", none.status, 200)]);
    },
  },
  {
    id: "the-site-layout-travels-once-per-account-and-workspace",
    title: "the site layout is sent with a five-minute once prop, and withheld while the browser holds it",
    entryPoint: "GET /settings with X-Inertia and X-Inertia-Except-Once-Props",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const before = Date.now();
      const first = await visit(ctx, cookie, "/settings");
      const after = Date.now();
      const key = onceKey(first.page);
      const expiresAt = Number(at(first.page, "onceProps", key, "expiresAt"));
      await ctx.verify("a first visit sends the layout and declares it for five minutes", [
        ctx.holds("the layout is sent", rowAt(first.page, "props", "shared") !== undefined, propNames(first.page).join(",")),
        ctx.equal("one once prop", keysOf(rowAt(first.page, "onceProps")).length, 1),
        ctx.holds("its key is shared:<16 characters>", ONCE_KEY.test(key), key),
        ctx.equal("it stands for the shared prop", textAt(first.page, "onceProps", key, "prop"), "shared"),
        ctx.holds("it expires five minutes from now", expiresAt >= before + FIVE_MINUTES_MS && expiresAt <= after + FIVE_MINUTES_MS, `${expiresAt - before} ms after the request began`),
      ]);
      const held = await visit(ctx, cookie, "/settings", { "x-inertia-except-once-props": key });
      await ctx.verify("a browser holding the layout is not sent it again", [
        ctx.equal("no shared prop", propNames(held.page).includes("shared"), false),
        ctx.equal("the key stays declared, with no expiry", rowAt(held.page, "onceProps"), { [key]: { prop: "shared", expiresAt: null } }),
        ctx.equal("the page, user and session still come", ["page", "path", "session", "user"].every((name) => propNames(held.page).includes(name)), true),
      ]);
      const other = await visit(ctx, cookie, "/settings", { "x-inertia-except-once-props": OTHER_ACCOUNT_KEY });
      await ctx.verify("a layout held for another account is not this one's", [
        ctx.holds("the layout is sent", rowAt(other.page, "props", "shared") !== undefined, propNames(other.page).join(",")),
        ctx.equal("this session's key is declared", keysOf(rowAt(other.page, "onceProps")), [key]),
      ]);
      const both = await visit(ctx, cookie, "/settings", { "x-inertia-except-once-props": `${key}, ${OTHER_ACCOUNT_KEY}` });
      await ctx.verify("holding this layout and another's sends this one again", [
        ctx.holds("the layout is sent", rowAt(both.page, "props", "shared") !== undefined, propNames(both.page).join(",")),
      ]);
    },
  },
  {
    id: "following-a-link-is-an-inertia-visit-without-the-layout",
    title: "after hydration a link click is an X-Inertia request that holds the layout and loads no document",
    entryPoint: "the sidebar's Feature index link on /examples/overview",
    async run(/** @type {Ctx} */ ctx) {
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      await tab.goto("/examples/overview");
      /** @type {{ url: string, type: string, headers: Record<string, string> }[]} */
      const requests = [];
      tab.page.on("request", (/** @type {Request} */ request) => {
        requests.push({ url: new URL(request.url()).pathname, type: request.resourceType(), headers: request.headers() });
      });
      /** @type {unknown[]} */
      const answered = [];
      tab.page.on("response", (/** @type {Response} */ response) => {
        if (new URL(response.url()).pathname === "/examples/features") answered.push(response.json());
      });
      let clicks = 0;
      while (!requests.some((request) => request.url === "/examples/features") && clicks < CLICKS) {
        clicks += 1;
        await tab.page.getByRole("link", { name: "Feature index" }).first().click();
        await tab.page.waitForTimeout(CLICK_WAIT_MS);
      }
      const visited = requests.find((request) => request.url === "/examples/features");
      const body = await Promise.resolve(answered[0]);
      await ctx.verify("the click moves to the page without loading a document", [
        tab.at(/^\/examples\/features$/),
        ctx.equal("document requests after the click", requests.filter((request) => request.type === "document").length, 0),
      ]);
      await ctx.verify("the request is an Inertia visit that names the layout it holds", [
        ctx.equal("x-inertia", visited?.headers["x-inertia"], "true"),
        ctx.holds("x-inertia-except-once-props holds a shared key", ONCE_KEY.test(visited?.headers["x-inertia-except-once-props"] ?? ""), visited?.headers["x-inertia-except-once-props"]),
      ]);
      await ctx.verify("the answer leaves the layout out and keeps the key declared", [
        ctx.equal("answers", answered.length, 1),
        ctx.equal("no shared prop", propNames(isRow(body) ? body : undefined).includes("shared"), false),
        ctx.equal("the page prop is sent", propNames(isRow(body) ? body : undefined).includes("page"), true),
        ctx.equal("the layout key has no expiry", rowAt(body, "onceProps"), { [visited?.headers["x-inertia-except-once-props"] ?? ""]: { prop: "shared", expiresAt: null } }),
      ]);
    },
  },
  {
    id: "partial-reloads-send-only-the-props-they-name",
    title: "only and except pick the top-level props, and a held layout stays withheld",
    entryPoint: "GET /settings with X-Inertia-Partial-Component, -Data and -Except",
    async run(/** @type {Ctx} */ ctx) {
      const { cookie } = await signedIn(ctx);
      const first = await visit(ctx, cookie, "/settings");
      const key = onceKey(first.page);
      const partial = { "x-inertia-partial-component": "DmsDynamicPage", "x-inertia-except-once-props": key };
      const only = await visit(ctx, cookie, "/settings", { ...partial, "x-inertia-partial-data": "user" });
      await ctx.verify("only=user sends the user and the errors", [
        ctx.equal("prop names", propNames(only.page), ["errors", "user"]),
        ctx.equal("the administrator", textAt(only.page, "props", "user", "email"), ctx.adminCredentials().email),
      ]);
      const nested = await visit(ctx, cookie, "/settings", { ...partial, "x-inertia-partial-data": "session.accountId" });
      await ctx.verify("a nested path selects its whole top-level prop", [ctx.equal("prop names", propNames(nested.page), ["errors", "session"])]);
      const except = await visit(ctx, cookie, "/settings", { ...partial, "x-inertia-partial-except": "page,user" });
      await ctx.verify("except leaves out the named props and asks for the rest, the layout included", [
        ctx.equal("prop names", propNames(except.page), ["errors", "path", "session", "shared"]),
      ]);
      const shared = await visit(ctx, cookie, "/settings", { ...partial, "x-inertia-partial-data": "shared" });
      await ctx.verify("only=shared sends the layout even though the browser holds it", [
        ctx.equal("prop names", propNames(shared.page), ["errors", "shared"]),
        ctx.holds("it expires in five minutes", Number(at(shared.page, "onceProps", key, "expiresAt")) > Date.now() + FIVE_MINUTES_MS - SLACK_MS, JSON.stringify(rowAt(shared.page, "onceProps"))),
      ]);
      const ignored = await visit(ctx, cookie, "/settings", { "x-inertia-partial-component": "Other", "x-inertia-partial-data": "user" });
      await ctx.verify("a partial reload for another component is a full visit", [ctx.equal("it carries the page", propNames(ignored.page).includes("page"), true)]);
    },
  },
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
];

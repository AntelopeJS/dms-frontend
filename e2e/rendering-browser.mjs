import { CLICK_WAIT_MS, CLICKS, HYDRATION_WAIT_MS, signedIn } from "./rendering-protocol.mjs";

/**
 * @typedef {import("./control.d.ts").JourneyContext} Ctx
 * @typedef {import("./control.d.ts").Tab} Tab
 * @typedef {import("./control.d.ts").Request} Request
 */

const MAIN_PAGES = ["/", "/settings", "/settings/workspace/members", "/settings/user/appearance", "/examples/overview", "/examples/features", "/table-view/table-view-tabs"];
const MISSING = "/no-such-page";

/**
 * Marks the document on screen, so a later check tells a page swapped in place from a document loaded again.
 *
 * @param {Tab} tab The tab
 * @returns {Promise<void>}
 */
async function markDocument(tab) {
  await tab.page.evaluate(() => {
    document.documentElement.dataset.verifyMounted = "kept";
    return true;
  });
}

/**
 * @param {Tab} tab The tab
 * @returns {Promise<string>} `kept` while the marked document is still the one on screen
 */
function documentMark(tab) {
  return tab.page.evaluate(() => document.documentElement.dataset.verifyMounted ?? "");
}

/**
 * Clicks a control until the tab reaches `path`, since a click that lands before hydration does nothing.
 *
 * @param {Tab} tab The tab
 * @param {string} role The control's role
 * @param {string} name The control's name
 * @param {string} path The path the click leads to
 * @returns {Promise<void>}
 */
async function clickUntilAt(tab, role, name, path) {
  for (let clicks = 0; new URL(tab.page.url()).pathname !== path && clicks < CLICKS; clicks += 1) {
    await tab.page.getByRole(role, { name }).first().click();
    await tab.page.waitForTimeout(CLICK_WAIT_MS);
  }
}

export const journeys = [
  {
    id: "back-and-forward-move-between-visited-pages-without-a-document-load",
    title: "after a link visit, the browser's back and forward buttons show the previous and the next page in place, with no document load",
    entryPoint: "the sidebar's Feature index link on /examples/overview, then history back and forward",
    async run(/** @type {Ctx} */ ctx) {
      const { tab } = await signedIn(ctx);
      await tab.goto("/examples/overview");
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      await markDocument(tab);
      /** @type {string[]} */
      const documents = [];
      tab.page.on("request", (/** @type {Request} */ request) => {
        if (request.resourceType() === "document") documents.push(new URL(request.url()).pathname);
      });
      await clickUntilAt(tab, "link", "Feature index", "/examples/features");
      await ctx.verify("the link leads to the feature index", [tab.at(/^\/examples\/features$/)]);
      await tab.page.goBack();
      await ctx.verify("back shows the overview again", [tab.at(/^\/examples\/overview$/), tab.visible({ role: "link", name: "Feature index" })]);
      await tab.page.goForward();
      await ctx.verify("forward shows the feature index again, in the same document", [
        tab.at(/^\/examples\/features$/),
        ctx.equal("the document was not reloaded", await documentMark(tab), "kept"),
        ctx.equal("document requests", documents, []),
      ]);
    },
  },
  {
    id: "the-main-pages-hydrate-without-a-script-error",
    title: "the home page, the settings, the members list, the appearance settings and the example pages load and hydrate in the browser with no uncaught error and no error in the console",
    entryPoint: "a document load of each main page of the playground, signed in",
    async run(/** @type {Ctx} */ ctx) {
      const { tab } = await signedIn(ctx);
      /** @type {string[]} */
      const errors = [];
      tab.page.on("pageerror", (/** @type {Error} */ error) => errors.push(`${new URL(tab.page.url()).pathname}: uncaught ${error.message}`));
      tab.page.on("console", (/** @type {import("./control.d.ts").ConsoleMessage} */ message) => {
        if (message.type() === "error") errors.push(`${new URL(tab.page.url()).pathname}: console ${message.text()}`);
      });
      /** @type {string[]} */
      const reached = [];
      for (const path of MAIN_PAGES) {
        await tab.goto(path);
        await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
        reached.push(new URL(tab.page.url()).pathname);
      }
      await ctx.verify("every page loaded signed in and hydrated without an error", [
        ctx.holds("no page sent the browser to sign-in", reached.every((path) => !path.startsWith("/auth")), reached.join(", ")),
        ctx.equal("errors", errors, []),
      ]);
    },
  },
  {
    id: "the-error-page-leads-back-and-home",
    title: "the 404 page of an unknown path offers Go back, which returns to the page before it, and Go to home, which opens the dashboard still signed in",
    entryPoint: "a link to /no-such-page from /settings, then the error page's Go back and Go to home",
    async run(/** @type {Ctx} */ ctx) {
      const { tab } = await signedIn(ctx);
      await tab.goto("/settings");
      await tab.goto(MISSING);
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      await ctx.verify("the unknown path shows the error page", [tab.at(/^\/no-such-page$/), tab.shows(/Page not found/), tab.visible({ role: "button", name: "Go back" })]);
      await clickUntilAt(tab, "button", "Go back", "/settings");
      await ctx.verify("Go back returns to the settings", [tab.at(/^\/settings$/), tab.visible({ role: "textbox", name: "Search settings" })]);
      await tab.goto(MISSING);
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      for (let clicks = 0; new URL(tab.page.url()).pathname === MISSING && clicks < CLICKS; clicks += 1) {
        await tab.page.getByRole("button", { name: "Go to home" }).first().click();
        await tab.page.waitForTimeout(CLICK_WAIT_MS);
      }
      await ctx.verify("Go to home opens the dashboard, still signed in", [
        ctx.holds("left the error page", new URL(tab.page.url()).pathname !== MISSING, tab.page.url()),
        ctx.holds("not sent to sign-in", !new URL(tab.page.url()).pathname.startsWith("/auth"), tab.page.url()),
        tab.visible({ role: "button", name: /Verify Admin/ }),
      ]);
    },
  },
  {
    id: "the-chosen-theme-is-drawn-again-after-a-reload",
    title: "choosing the dark theme in the account menu darkens the dashboard at once, and a reload draws it dark again",
    entryPoint: "the account menu's Interface theme > Dark on /settings, then a reload",
    async run(/** @type {Ctx} */ ctx) {
      const { tab } = await signedIn(ctx);
      await tab.goto("/settings");
      await tab.page.waitForTimeout(HYDRATION_WAIT_MS);
      const isDark = () => tab.page.evaluate(() => document.documentElement.classList.contains("dark"));
      await ctx.verify("the dashboard starts in the light theme of a light system", [ctx.equal("dark", await isDark(), false)]);
      for (let clicks = 0; !(await isDark()) && clicks < CLICKS; clicks += 1) {
        await tab.page.keyboard.press("Escape");
        await tab.page.getByRole("button", { name: /Verify Admin/ }).first().click();
        await tab.page.getByRole("menuitem", { name: "Interface theme" }).first().click();
        await tab.page.getByRole("menuitemcheckbox", { name: "Dark" }).first().click();
        await tab.page.waitForTimeout(CLICK_WAIT_MS);
      }
      await ctx.verify("choosing Dark darkens the page at once", [ctx.equal("dark", await isDark(), true)]);
      await tab.reload();
      await ctx.verify("a reload draws the page dark again", [tab.at(/^\/settings$/), ctx.equal("dark", await isDark(), true)]);
    },
  },
];

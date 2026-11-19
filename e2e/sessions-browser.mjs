import { signIn } from "./signin.mjs";

/**
 * @typedef {import("./control.d.ts").JourneyContext} Ctx
 * @typedef {import("./control.d.ts").Tab} Tab
 */

const ATTEMPTS = 4;
const LEFT_SIGN_IN_MS = 10_000;
const MENU_WAIT_MS = 2500;
const PRIVATE_PAGE = "/settings/workspace/members";
const SESSION_COOKIE = /^dms_session_[0-9a-f]{12}$/;

/**
 * @param {Tab} tab A tab
 * @returns {Promise<string[]>} The names of its session cookies
 */
async function sessionCookies(tab) {
  const cookies = await tab.page.context().cookies();
  return cookies.filter((cookie) => SESSION_COOKIE.test(cookie.name) && cookie.value !== "").map((cookie) => cookie.name);
}

export const journeys = [
  {
    id: "a-signed-out-visit-signs-in-and-returns-to-the-page-it-asked-for",
    title: "a visitor without a session who opens a private page lands on the sign-in form, signs in and is taken to the page they asked for, still signed in after a reload",
    entryPoint: "a signed-out browser on /settings/workspace/members?from=link, then the rendered sign-in form",
    async run(/** @type {Ctx} */ ctx) {
      const tab = await ctx.tab("anon", "visitor");
      const credentials = ctx.adminCredentials();
      await tab.goto(`${PRIVATE_PAGE}?from=link`);
      await ctx.verify("the private page sends the visitor to sign-in with the page to come back to", [
        tab.at(/^\/auth$/),
        ctx.equal("redirect", new URL(tab.page.url()).searchParams.get("redirect"), `${PRIVATE_PAGE}?from=link`),
        tab.visible({ role: "textbox", name: "Email address" }),
      ]);
      await tab.page.waitForLoadState("networkidle");
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        await tab.fill({ role: "textbox", name: "Email address" }, credentials.email);
        await tab.fill({ role: "textbox", name: "Password", exact: true }, credentials.password);
        await tab.click({ role: "button", name: "Login", exact: true });
        const left = await tab.page.waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: LEFT_SIGN_IN_MS }).then(
          () => true,
          () => false,
        );
        if (left) break;
      }
      await ctx.verify("signing in lands on the page the visitor asked for, query included", [
        ctx.equal("path and query", `${new URL(tab.page.url()).pathname}${new URL(tab.page.url()).search}`, `${PRIVATE_PAGE}?from=link`),
        tab.visible({ role: "link", name: /^Members/ }),
      ]);
      await tab.reload();
      await ctx.verify("a reload keeps the visitor on the page, signed in", [tab.at(/^\/settings\/workspace\/members$/)]);
    },
  },
  {
    id: "logging-out-from-the-account-menu-ends-the-session",
    title: "Logout in the account menu takes the user to the sign-in form, clears the session cookie, and a private page then asks for sign-in again",
    entryPoint: "the account menu's Logout on /settings",
    async run(/** @type {Ctx} */ ctx) {
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      await tab.goto("/settings");
      await ctx.verify("the signed-in browser holds a session cookie", [ctx.equal("session cookies", (await sessionCookies(tab)).length, 1)]);
      const account = tab.page.getByRole("button", { name: /Verify Admin/ }).first();
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        await account.click();
        const open = await tab.page
          .getByRole("menuitem", { name: "Logout" })
          .waitFor({ timeout: MENU_WAIT_MS })
          .then(
            () => true,
            () => false,
          );
        if (open) break;
      }
      await tab.click({ role: "menuitem", name: "Logout" });
      await tab.page.waitForURL((url) => url.pathname.startsWith("/auth"), { timeout: LEFT_SIGN_IN_MS }).catch(() => undefined);
      await ctx.verify("logging out shows the sign-in form and drops the session cookie", [
        tab.at(/^\/auth/),
        tab.visible({ role: "textbox", name: "Email address" }),
        ctx.equal("session cookies", await sessionCookies(tab), []),
      ]);
      await tab.goto("/settings");
      await ctx.verify("a private page asks for sign-in again", [tab.at(/^\/auth$/), ctx.equal("redirect", new URL(tab.page.url()).searchParams.get("redirect"), "/settings")]);
    },
  },
];

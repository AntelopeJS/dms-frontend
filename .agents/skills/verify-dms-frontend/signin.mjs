/** @typedef {import("./control.d.ts").JourneyContext} Ctx */
/** @typedef {import("./control.d.ts").Tab} Tab */

const ATTEMPTS = 4;
const LEFT_SIGN_IN_MS = 10_000;

/**
 * Signs an account in through the form once the page has hydrated, trying
 * again when a click lands before hydration and the form stays on `/auth`.
 *
 * @param {Ctx} ctx The journey context
 * @param {Tab} tab The account's tab
 * @param {string} [account] The account name
 * @returns {Promise<void>}
 */
export async function signIn(ctx, tab, account = "admin") {
  const credentials = ctx.state.accounts[account];
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    await tab.goto("/auth");
    await tab.page.waitForLoadState("networkidle");
    await tab.fill({ role: "textbox", name: "Email address" }, credentials.email);
    await tab.fill({ role: "textbox", name: "Password", exact: true }, credentials.password);
    await tab.click({ role: "button", name: "Login", exact: true });
    const left = await tab.page
      .waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: LEFT_SIGN_IN_MS })
      .then(() => true, () => false);
    if (left) break;
  }
  const at = new URL(tab.page.url()).pathname;
  await ctx.verify(`${account} is signed in`, [ctx.holds(`${account} left /auth`, !at.startsWith("/auth"), at)]);
}

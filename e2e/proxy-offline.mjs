export const journeys = [
  {
    id: "proxy-offline",
    title: "a navigation that never reaches the server shows the Connection lost toast and keeps the page",
    entryPoint: "the dashboard's Settings page with the browser offline, then online again",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const tab = await ctx.tab("admin");
      await tab.signIn("admin");
      await tab.goto("/settings");
      await ctx.verify("Settings is open", [tab.at(/^\/settings$/)], { critical: true });
      const links = tab.page.locator('a[href^="/settings/"]');
      await links.first().waitFor({ state: "visible", timeout: 20_000 });
      const target = await links.first().getAttribute("href");
      await tab.page.context().setOffline(true);
      let toast = false;
      for (let attempt = 0; attempt < 10 && !toast; attempt += 1) {
        await links.first().click();
        toast = await tab.page.getByText("Connection lost", { exact: true }).first().waitFor({ state: "visible", timeout: 2000 }).then(() => true, () => false);
      }
      const description = await tab.page.getByText("The server could not be reached. Check your connection and try again.", { exact: true }).count();
      const toasts = await tab.page.getByText("Connection lost", { exact: true }).count();
      await tab.snapshot("offline toast");
      await ctx.verify("offline: the toast names the failure", [
        ctx.holds("the Connection lost toast shows", toast, toast),
        ctx.equal("its description is the documented text", description, 1),
        ctx.equal("however many visits failed, one toast", toasts, 1),
        ctx.equal("the page stays where it was", new URL(tab.page.url()).pathname, "/settings"),
      ]);
      await tab.page.context().setOffline(false);
      await links.first().click();
      await ctx.verify("back online the same link navigates", [tab.at(new RegExp(`^${target}$`))]);
    },
  },
];

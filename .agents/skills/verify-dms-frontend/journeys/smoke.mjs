import { signIn } from "../signin.mjs";

/** @typedef {import("../control.d.ts").JourneyContext} Ctx */

export const journeys = [
  {
    id: "smoke",
    title: "the renderer serves onboarding, the admin signs in, reloads and stays signed in",
    entryPoint: "POST /api/onboarding/register, then the sign-in form served by `ajs dms start`",
    async run(/** @type {Ctx} */ ctx) {
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      await tab.goto("/settings");
      await ctx.verify("the settings overview opens signed in", [tab.at(/^\/settings$/)]);
      await tab.reload();
      await ctx.verify("a reload keeps the session", [tab.at(/^\/settings$/), tab.visible({ role: "textbox", name: "Search settings" })]);
    },
  },
];

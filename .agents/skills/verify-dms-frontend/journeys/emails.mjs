import { readFileSync } from "node:fs";
import { parseJson } from "../json.mjs";
import { signIn } from "../signin.mjs";
import { get, header } from "../web.mjs";

/** @typedef {import("../control.d.ts").JourneyContext} Ctx */

const OPEN_ATTEMPTS = 6;
const OPEN_WAIT_MS = 2500;
const HYDRATION_COMMENTS = /<!--\[-->|<!--\]-->|<!---->/g;
const RENDER_ROUTE = "/api/html/render";

/**
 * @param {string} file A raw message the sink captured
 * @returns {string} Its quoted-printable body, decoded
 */
function decoded(file) {
  const joined = readFileSync(file, "latin1").replace(/=\r?\n/g, "");
  return decodeURIComponent(joined.replace(/%/g, "%25").replace(/=([0-9A-F]{2})/g, "%$1"));
}

export const journeys = [
  {
    id: "a-rendered-email-carries-no-hydration-markers-and-links-to-the-dashboard",
    title: "the password-reset and invitation emails are rendered by the frontend server: complete HTML, no Vue comments, links on the dashboard's origin",
    entryPoint: "POST /api/auth/forgot-password and Settings > Members > Invite members, then the messages the sink captured",
    async run(/** @type {Ctx} */ ctx) {
      const admin = ctx.adminCredentials();
      const asked = await ctx.api("ask for a reset code", { method: "POST", path: "/api/auth/forgot-password", body: { email: admin.email }, as: "anon" });
      await ctx.verify("the request is accepted", [ctx.holds("status is 2xx", (asked.status ?? 0) >= 200 && (asked.status ?? 0) < 300, asked.status)]);
      const reset = await ctx.mail((message) => message.to.some((to) => to.includes(admin.email)));
      const resetHtml = reset.match ? decoded(reset.match.file) : "";
      await ctx.verify("the reset message is a rendered HTML document with its code", [
        ctx.holds("a message arrived", reset.match !== undefined, `${reset.messages.length} captured`),
        ctx.equal("subject", reset.match?.subject, "Reset Your Password"),
        ctx.holds("it holds an html element", /<html[\s>]/i.test(resetHtml), "html element"),
        ctx.holds("it holds the reset code the user needs", /verification code is: [A-Z0-9]{6}/.test(reset.match?.text ?? ""), reset.match?.text.slice(0, 160)),
      ]);
      await ctx.verify("the HTML carries no Vue hydration comments", [
        ctx.equal("fragment start comments", (resetHtml.match(/<!--\[-->/g) ?? []).length, 0),
        ctx.equal("fragment end comments", (resetHtml.match(/<!--\]-->/g) ?? []).length, 0),
        ctx.equal("empty placeholder comments", (resetHtml.match(/<!---->/g) ?? []).length, 0),
        ctx.equal("server-rendered markers", (resetHtml.match(/data-server-rendered/g) ?? []).length, 0),
        ctx.equal("teleport anchors", (resetHtml.match(/teleport (start|end)/g) ?? []).length, 0),
      ]);
      const tab = await ctx.tab("admin");
      await signIn(ctx, tab);
      const invitee = ctx.email("invitee");
      await tab.goto("/settings/workspace/members");
      for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt += 1) {
        await tab.click({ role: "button", name: "Invite members" });
        const open = await tab.page
          .getByRole("textbox", { name: "Email addresses" })
          .waitFor({ timeout: OPEN_WAIT_MS })
          .then(() => true, () => false);
        if (open) break;
      }
      await tab.fill({ role: "textbox", name: "Email addresses" }, invitee);
      await tab.press("Enter", { role: "textbox", name: "Email addresses" });
      await tab.click({ role: "combobox", name: "Team" });
      await tab.click({ role: "option", name: "Sales" });
      await tab.click({ role: "switch", name: "Make workspace owner" });
      await tab.click({ role: "button", name: "Send invitations" });
      await ctx.verify("the invitation is sent", [tab.shows(/Invitations sent/)]);
      const invitation = await ctx.mail((message) => message.to.some((to) => to.includes(invitee)));
      const invitationHtml = invitation.match ? decoded(invitation.match.file) : "";
      const signup = (invitation.match?.links ?? []).filter((link) => link.startsWith(`${ctx.state.webUrl}/auth/signup?token=`));
      await ctx.verify("the invitation links to the dashboard's own origin and is free of hydration comments", [
        ctx.holds("an invitation arrived", invitation.match !== undefined, `${invitation.messages.length} captured`),
        ctx.equal("signup links on the client base URL", signup.length, 1),
        ctx.equal("hydration comments", (invitationHtml.match(HYDRATION_COMMENTS) ?? []).length, 0),
      ]);
      const body = JSON.stringify({ templateName: "x", props: {} });
      const unsigned = await get(ctx, RENDER_ROUTE, { method: "POST", body, headers: { "content-type": "application/json" } });
      const forged = await get(ctx, RENDER_ROUTE, { method: "POST", body, headers: { "content-type": "application/json", "x-dms-service-token": "a.b.c" } });
      await ctx.verify("the render route refuses a caller without a valid service token", [
        ctx.equal("no token", unsigned.status, 401),
        ctx.equal("a forged token", forged.status, 401),
        ctx.equal("message", parseJson(unsigned.text), { message: "Invalid service token" }),
        ctx.equal("content-type", header(unsigned, "content-type"), "application/json"),
      ]);
    },
  },
];

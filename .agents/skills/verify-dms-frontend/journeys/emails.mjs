import { readFileSync } from "node:fs";
import { journeys as logo } from "../emails-logo.mjs";
import { parseJson, textAt } from "../json.mjs";
import { signIn } from "../signin.mjs";
import { withSatellite } from "../proxy-satellite.mjs";
import { get, header, serviceToken } from "../web.mjs";
import { standalone } from "../standalone.mjs";

/** @typedef {import("../control.d.ts").JourneyContext} Ctx */

const OPEN_ATTEMPTS = 6;
const OPEN_WAIT_MS = 2500;
const HYDRATION_COMMENTS = /<!--\[-->|<!--\]-->|<!---->/g;
const RENDER_ROUTE = "/api/html/render";

/**
 * @param {Ctx} ctx The journey context
 * @param {string} url The frontend server to ask
 * @param {{ token?: string, templateName?: string, props?: object, locale?: string }} [options] What differs from a valid request
 * @returns {Promise<{ status: number, body: unknown, html: string }>} The answer
 */
async function render(ctx, url, options = {}) {
  const props = options.props ?? { email: "x@verify.local", signupLink: `${url}/auth/signup?token=t`, expiresInDays: 7 };
  const headers = new Headers({ "content-type": "application/json", "x-dms-service-token": options.token ?? serviceToken(ctx.state.secrets.DMS_HTML_RENDER_SECRET) });
  if (options.locale) headers.set("x-content-language", options.locale);
  const response = await fetch(`${url}${RENDER_ROUTE}`, { method: "POST", headers, body: JSON.stringify({ templateName: options.templateName ?? "EmailAdminInvite", props }) });
  const body = parseJson(await response.text());
  return { status: response.status, body, html: textAt(body, "html") ?? "" };
}

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
  {
    id: "the-render-route-takes-one-signed-single-use-token-per-render",
    title: "a render with a valid service token answers the template's HTML; a replayed, forged, mis-addressed or expired token, an unknown template and a bad body are refused",
    entryPoint: "POST /api/html/render on a second frontend server",
    ...standalone,
    async run(/** @type {Ctx} */ ctx) {
      await withSatellite(ctx, {}, async (server) => {
        const secret = ctx.state.secrets.DMS_HTML_RENDER_SECRET;
        const token = serviceToken(secret);
        const first = await render(ctx, server.url, { token });
        const replay = await render(ctx, server.url, { token });
        const wrongSecret = await render(ctx, server.url, { token: serviceToken("not-the-secret") });
        const unknown = await render(ctx, server.url, { templateName: "EmailDoesNotExist" });
        const noName = await render(ctx, server.url, { templateName: "" });
        const french = await render(ctx, server.url, { locale: "fr" });
        const english = await render(ctx, server.url, { locale: "en" });
        const unsupported = await render(ctx, server.url, { locale: "xx" });
        await ctx.verify("a valid token renders the template once", [
          ctx.equal("status", first.status, 200),
          ctx.holds("the HTML is a document with the signup link given", first.html.startsWith("<!doctype html><html") && first.html.includes(`${server.url}/auth/signup?token=t`), first.html.slice(0, 160)),
          ctx.equal("the same token again", [replay.status, replay.body], [401, { message: "Invalid service token" }]),
          ctx.equal("a token signed with another secret", [wrongSecret.status, wrongSecret.body], [401, { message: "Invalid service token" }]),
        ]);
        await ctx.verify("a template that does not exist and a body with no name are refused", [
          ctx.equal("unknown template", [unknown.status, unknown.body], [404, { message: 'Template "EmailDoesNotExist" not found or render failed' }]),
          ctx.equal("empty name", [noName.status, noName.body], [400, { message: "Invalid request body" }]),
        ]);
        await ctx.verify("the language header picks the catalog and an unknown language falls back to English", [
          ctx.holds("French differs from English", french.html !== english.html, french.html.length),
          ctx.equal("an unknown language renders the English text", unsupported.html.replace(/lang="[^"]*"/g, ""), english.html.replace(/lang="[^"]*"/g, "")),
        ]);
      });
    },
  },
  ...logo,
];

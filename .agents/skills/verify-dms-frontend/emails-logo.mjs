import { join } from "node:path";
import { runCli, scratch, observe } from "./cli-run.mjs";
import { buildProjectFolder, writeBuildProject } from "./build-project.mjs";
import { RENDER_SECRET, serve, whileServing } from "./build-server.mjs";
import { parseJson, textAt } from "./json.mjs";
import { startFakeBackend } from "./proxy-satellite.mjs";
import { fakeAuthBackend } from "./proxy-signin.mjs";
import { serviceToken } from "./web.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const BUILD_TIMEOUT_MS = 900_000;
const MANIFEST_ORIGIN = "https://dashboard.example.test";
const OVERRIDE_ORIGIN = "https://mail.example.test";
const EMAIL_ENTRY = `export const serverEmailTemplates = {};
export const appConfig = { branding: { logo: { email: { light: "/branding/mail-logo.png" } } } };
`;

/**
 * @param {string} url The frontend server
 * @returns {Promise<string>} The `src` of the images in an invitation e-mail it renders
 */
async function logoSources(url) {
  const props = { email: "x@verify.local", signupLink: `${url}/auth/signup?token=t`, expiresInDays: 7 };
  const response = await fetch(`${url}/api/html/render`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dms-service-token": serviceToken(RENDER_SECRET) },
    body: JSON.stringify({ templateName: "EmailAdminInvite", props }),
  });
  const html = textAt(parseJson(await response.text()), "html") ?? "";
  return (html.match(/<img[^>]*\ssrc="([^"]+)"/g) ?? []).join(" ");
}

export const journeys = [
  {
    id: "an-email-logo-is-on-the-public-dashboard-url-the-variable-names",
    title: "the logo of a rendered e-mail starts with DMS_CLIENT_BASE_URL when it is set, and with the project's public clientBaseUrl when it is not (the documented override of public.dms.clientBaseUrl)",
    entryPoint: "POST /api/html/render on a built module whose e-mail config sets a logo and a project whose dms config sets another clientBaseUrl",
    async run(/** @type {Context} */ ctx) {
      const project = writeBuildProject(buildProjectFolder(ctx, "email-logo"), {
        files: { "dms.email.ts": EMAIL_ENTRY },
        dmsConfig: JSON.stringify({ clientBaseUrl: MANIFEST_ORIGIN }),
      });
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const built = await runCli(ctx, ["build", "--project", project.project, "--workspace", workspace], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      const { handler } = fakeAuthBackend();
      const backend = await startFakeBackend(handler);
      try {
        const options = { project: false, cwd: project.project, args: ["--workspace", workspace] };
        const overridden = await whileServing(await serve(ctx, backend.url, { ...options, env: { DMS_CLIENT_BASE_URL: OVERRIDE_ORIGIN } }), (server) => logoSources(server.url.replace(/\/$/, "")));
        const configured = await whileServing(await serve(ctx, backend.url, { ...options, env: { DMS_CLIENT_BASE_URL: undefined } }), (server) => logoSources(server.url.replace(/\/$/, "")));
        observe(ctx, "the logo's origin", { built: built.code, overridden, configured }, [
          ctx.equal("the module builds", built.code, 0),
          ctx.holds("with the variable, the logo is on its origin", overridden.includes(`src="${OVERRIDE_ORIGIN}/branding/mail-logo.png"`), overridden),
          ctx.holds("without it, the logo is on the public clientBaseUrl the project configures", configured.includes(`src="${MANIFEST_ORIGIN}/branding/mail-logo.png"`), configured),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
];

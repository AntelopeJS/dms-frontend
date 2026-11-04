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
const EMAIL_ENTRY = `export const serverEmailTemplates = { "./emails/Probe.vue": () => import("./emails/Probe.vue") };
export const appConfig = { branding: { logo: { email: { light: "/branding/mail-logo.png" } } }, dmsMail: { tone: "email" } };
`;
const LAYER_CONFIG = `export default defineDmsAppConfig({ dmsMail: { tone: "layer", only: "layer" } });
`;
const HIGHER_CONFIG = `export default defineDmsAppConfig({ dmsMail: { tone: "high" } });
`;
const PROBE = `<script setup lang="ts">
const config = useDmsAppConfig();
const comments = "<!--[if mso]><table><tr><td><![endif]--><!-- keep me --><!--[if mso]></td></tr></table><![endif]-->";
</script>

<template>
  <EBody>
    <p>tone={{ config.dmsMail.tone }} only={{ config.dmsMail.only }}</p>
    <div v-html="comments" />
  </EBody>
</template>
`;
const OUTLOOK = "<!--[if mso]><table><tr><td><![endif]--><!-- keep me --><!--[if mso]></td></tr></table><![endif]-->";

/**
 * @param {string} url The frontend server
 * @returns {Promise<string>} The HTML of the Probe e-mail template it renders
 */
async function renderProbe(url) {
  const response = await fetch(`${url}/api/html/render`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dms-service-token": serviceToken(RENDER_SECRET) },
    body: JSON.stringify({ templateName: "Probe", props: {} }),
  });
  return textAt(parseJson(await response.text()), "html") ?? "";
}

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
        files: { "dms.email.ts": EMAIL_ENTRY, "app/app.config.ts": LAYER_CONFIG, "emails/Probe.vue": PROBE },
        dmsConfig: JSON.stringify({ clientBaseUrl: MANIFEST_ORIGIN }),
        higher: { appConfig: HIGHER_CONFIG },
      });
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const built = await runCli(ctx, ["build", "--project", project.project, "--workspace", workspace], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      const { handler } = fakeAuthBackend();
      const backend = await startFakeBackend(handler);
      try {
        const options = { project: false, cwd: project.project, args: ["--workspace", workspace] };
        const overridden = await whileServing(await serve(ctx, backend.url, { ...options, env: { DMS_CLIENT_BASE_URL: OVERRIDE_ORIGIN } }), (server) => logoSources(server.url.replace(/\/$/, "")));
        const configured = await whileServing(await serve(ctx, backend.url, { ...options, env: { DMS_CLIENT_BASE_URL: undefined } }), (server) => logoSources(server.url.replace(/\/$/, "")));
        const probe = await whileServing(await serve(ctx, backend.url, { ...options, env: { DMS_CLIENT_BASE_URL: undefined } }), (server) => renderProbe(server.url.replace(/\/$/, "")));
        observe(ctx, "a module's e-mail template", { probe }, [
          ctx.holds("Outlook's conditional comments and a plain comment are kept byte for byte", probe.includes(OUTLOOK), probe),
          ctx.equal("no Vue hydration comment is left", /<!--\[-->|<!--\]-->|<!---->/.test(probe), false),
          ctx.holds("a higher-priority module's layer config overrides a lower module's e-mail appConfig and layers, and the lower module's other keys stay", probe.includes("<p>tone=high only=layer</p>"), probe.slice(probe.indexOf("<p>"), probe.indexOf("<p>") + 80)),
        ]);
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

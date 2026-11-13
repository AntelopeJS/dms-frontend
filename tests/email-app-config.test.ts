import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
} from "../src/common";
import { temporaryWorkspaceParent } from "../src/temporary-workspace";
import { isFunction, isObjectLike, isText } from "./helpers/guards";
import { copyEmailRendererFiles } from "./helpers/templates";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Builds a layer e-mail that reads the app configs in a workspace under `parent`, and renders it. */
async function renderBrandingEmail(parent: string): Promise<string> {
  mkdirSync(parent, { recursive: true });
  const workspace = mkdtempSync(join(parent, ".email-app-config-"));
  try {
    const project: ResolvedLayer = {
      path: join(workspace, "sources", "project"),
      packageName: "@fixture/project",
      priority: 10,
    };
    const dms: ResolvedLayer = {
      path: join(workspace, "sources", "dms"),
      packageName: "@fixture/dms",
      priority: 1,
    };
    for (const layer of [project, dms])
      writeFile(
        join(layer.path, "package.json"),
        JSON.stringify({ name: layer.packageName, type: "module" }),
      );
    writeFile(
      join(project.path, "i18n", "locales", "project-en-GB.json"),
      "{}",
    );
    writeFile(
      join(project.path, "app", "app.config.ts"),
      'export default defineDmsAppConfig({ branding: { logo: { email: "/project-email.png" } } });\n',
    );
    writeFile(
      join(dms.path, "layers", "dms-layout", "app", "app.config.ts"),
      'export default { branding: { name: "DMS", logo: { email: "/dms-email.png", light: "/dms.svg" } } };\n',
    );
    writeFile(
      join(dms.path, "dms.email.ts"),
      'export const serverEmailTemplates = import.meta.glob("./Branding.vue");\nexport const appConfig = { branding: { name: "DMS mail" } };\n',
    );
    writeFile(
      join(dms.path, "Branding.vue"),
      `<script setup lang="ts">
const branding = useDmsAppConfig().branding as Record<string, any>;
</script>
<template><p>{{ branding.name }}|{{ branding.logo.email }}|{{ branding.logo.light }}</p></template>`,
    );
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    materializeLayers(workspace, [project, dms]);
    writeFrontendModuleRegistry(workspace, [project, dms]);
    copyEmailRendererFiles(workspace);
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "vite.email.config.ts",
        "--logLevel",
        "error",
      ],
      { cwd: workspace, stdio: "pipe" },
    );

    const emailRenderer: unknown = await import(
      pathToFileURL(join(workspace, "dist", "server", "email-renderer.js")).href
    );
    assert.ok(
      isObjectLike(emailRenderer) &&
        "renderEmail" in emailRenderer &&
        isFunction(emailRenderer.renderEmail),
      "the build exports renderEmail",
    );
    const { renderEmail } = emailRenderer;
    const html: unknown = await renderEmail("Branding", {});
    assert.ok(isText(html), "the email renders to text");
    return html;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const BRANDING = /<p>DMS mail\|\/project-email\.png\|\/dms\.svg<\/p>/;

void it("gives emails the layers' app configs, module by module, after each module's email config", async () => {
  assert.match(await renderBrandingEmail(resolve(".")), BRANDING);
});

void it("auto-imports into layer emails built where verify-source works when TEMP is on another drive", async () => {
  const segments = win32
    .relative(
      "D:\\site",
      temporaryWorkspaceParent("D:\\site", "C:\\Temp", win32),
    )
    .split(win32.sep);
  const top = resolve(segments[0] ?? ".");
  const createdTop = !existsSync(top);
  try {
    assert.match(await renderBrandingEmail(resolve(...segments)), BRANDING);
  } finally {
    rmSync(createdTop ? top : resolve(...segments), {
      recursive: true,
      force: true,
    });
  }
});

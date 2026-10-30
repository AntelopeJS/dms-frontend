import * as assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

/** The props of the fixture's `Welcome.vue`. */
interface WelcomeProps {
  footer?: boolean;
}

interface EmailTemplate {
  renderEmailTemplate: (
    template: string,
    props: WelcomeProps,
  ) => Promise<string>;
  watchEmailBundle: () => ChildProcess;
}

function writeTemplate(moduleRoot: string, text: string): void {
  writeFileSync(
    join(moduleRoot, "emails", "Welcome.vue"),
    `<template><p>${text}</p></template>\n`,
  );
}

/**
 * A copy of the template inside the repository, so the builder resolves Vite
 * and Vue from it, with one module whose `emails/` holds `templates`.
 */
async function emailWorkspace(templates: Record<string, string>): Promise<{
  workspace: string;
  moduleRoot: string;
  email: EmailTemplate;
}> {
  const workspace = mkdtempSync(resolve(".email-bundle-watch-"));
  const moduleRoot = join(workspace, "frontend-modules", "fixture");
  cpSync("templates/vue", workspace, { recursive: true });
  writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
  writeFileSync(join(workspace, "frontend-paths.generated.json"), "{}");
  writeFileSync(
    join(workspace, "generated-frontend-modules.json"),
    JSON.stringify({
      modules: [{ id: "fixture", root: moduleRoot, options: {} }],
    }),
  );
  writeFileSync(join(workspace, "email-locales.generated.json"), '["en"]');
  writeFileSync(
    join(workspace, "app-configs.generated.ts"),
    "export const appConfigs = [];\n",
  );
  mkdirSync(join(workspace, "locales.generated"));
  writeFileSync(join(workspace, "locales.generated", "en.json"), "{}");
  mkdirSync(join(moduleRoot, "emails"), { recursive: true });
  writeFileSync(
    join(moduleRoot, "dms.email.ts"),
    `export const serverEmailTemplates = { "./emails/Welcome.vue": () => import("./emails/Welcome.vue") };\n`,
  );
  for (const [name, source] of Object.entries(templates)) {
    writeFileSync(join(moduleRoot, "emails", name), source);
  }
  const email = (await import(
    pathToFileURL(join(workspace, "server", "email.mjs")).href
  )) as EmailTemplate;
  return { workspace, moduleRoot, email };
}

it("builds the email bundle in development and rebuilds it when a template changes", async () => {
  const { workspace, moduleRoot, email } = await emailWorkspace({
    "Welcome.vue": "<template><p>Welcome, first edition</p></template>\n",
  });
  let builder: ChildProcess | undefined;
  try {
    const render = () => email.renderEmailTemplate("Welcome", {});

    builder = email.watchEmailBundle();
    assert.match(await render(), /Welcome, first edition/);

    writeTemplate(moduleRoot, "Welcome, second edition");
    const deadline = Date.now() + 60_000;
    let second = await render();
    while (!second.includes("second edition") && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 200));
      second = await render();
    }
    assert.match(second, /Welcome, second edition/);
  } finally {
    builder?.kill();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it("lets a render in progress finish before a rebuild replaces the bundle", async () => {
  const { workspace, moduleRoot, email } = await emailWorkspace({
    "Welcome.vue": `<script setup lang="ts">
const props = defineProps<{ footer?: boolean }>();
let Footer: unknown;
if (props.footer) {
  await (globalThis as { emailRenderGate?: Promise<void> }).emailRenderGate;
  Footer = (await import("./Footer.vue")).default;
}
</script>
<template><p>Welcome</p><component :is="Footer" v-if="Footer" /></template>
`,
    "Footer.vue": "<template><p>Footer, first edition</p></template>\n",
  });
  let builder: ChildProcess | undefined;
  let openGate = () => {};
  try {
    builder = email.watchEmailBundle();
    assert.match(await email.renderEmailTemplate("Welcome", {}), /Welcome/);

    Reflect.set(
      globalThis,
      "emailRenderGate",
      new Promise<void>((open) => {
        openGate = open;
      }),
    );
    const held = email.renderEmailTemplate("Welcome", { footer: true });
    const rebuild = once(builder, "message");
    writeFileSync(
      join(moduleRoot, "emails", "Footer.vue"),
      "<template><p>Footer, second edition</p></template>\n",
    );
    assert.deepEqual((await rebuild)[0], { state: "building" });
    const ready = once(builder, "message");
    let newRenderFinished = false;
    const queued = email.renderEmailTemplate("Welcome", {}).then((html) => {
      newRenderFinished = true;
      return html;
    });
    const replaced = await Promise.race([
      ready.then(() => true),
      new Promise((settle) => setTimeout(() => settle(false), 1_000)),
    ]);
    assert.equal(newRenderFinished, false, "new renders wait for the build");
    openGate();
    assert.match(await held, /Footer, first edition/);
    assert.equal(replaced, false, "the rebuild waited for the render");
    assert.deepEqual((await ready)[0], { state: "ready" });
    assert.match(await queued, /Welcome/);
    assert.match(
      await email.renderEmailTemplate("Welcome", { footer: true }),
      /Footer, second edition/,
    );
  } finally {
    openGate();
    Reflect.deleteProperty(globalThis, "emailRenderGate");
    builder?.kill();
    rmSync(workspace, { recursive: true, force: true });
  }
});

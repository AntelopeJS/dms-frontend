import * as assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

interface EmailTemplate {
  renderEmailTemplate: (
    template: string,
    props: Record<string, unknown>,
  ) => Promise<string>;
  watchEmailBundle: () => ChildProcess;
}

function writeTemplate(moduleRoot: string, text: string): void {
  writeFileSync(
    join(moduleRoot, "emails", "Welcome.vue"),
    `<template><p>${text}</p></template>\n`,
  );
}

it("builds the email bundle in development and rebuilds it when a template changes", async () => {
  // Inside the repository, so the builder resolves Vite and Vue from it.
  const workspace = mkdtempSync(resolve(".email-bundle-watch-"));
  const moduleRoot = join(workspace, "frontend-modules", "fixture");
  let builder: ChildProcess | undefined;
  try {
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
    mkdirSync(join(workspace, "locales.generated"));
    writeFileSync(join(workspace, "locales.generated", "en.json"), "{}");
    mkdirSync(join(moduleRoot, "emails"), { recursive: true });
    writeFileSync(
      join(moduleRoot, "dms.email.ts"),
      'export const serverEmailTemplates = { "./emails/Welcome.vue": () => import("./emails/Welcome.vue") };\n',
    );
    writeTemplate(moduleRoot, "Welcome, first edition");

    const email = (await import(
      pathToFileURL(join(workspace, "server", "email.mjs")).href
    )) as EmailTemplate;
    const render = () => email.renderEmailTemplate("Welcome", {});

    // No bundle exists yet: the render waits for the build started here.
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

import * as assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

interface EmailTemplate {
  handleEmailRender: RequestListener;
  watchEmailBundle: () => ChildProcess;
}

const RENDER_SECRET = "email-bundle-watch-secret";

function serviceToken(): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      namespace: "html-render-service",
      purpose: "html-render",
      aud: "dms-frontend",
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", RENDER_SECRET)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
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
  const previousSecret = process.env.DMS_HTML_RENDER_SECRET;
  process.env.DMS_HTML_RENDER_SECRET = RENDER_SECRET;
  let builder: ChildProcess | undefined;
  let frontend: ReturnType<typeof createServer> | undefined;
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
    frontend = createServer(email.handleEmailRender);
    await new Promise<void>((settle) =>
      frontend!.listen(0, "127.0.0.1", settle),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const render = async () => {
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dms-service-token": serviceToken(),
        },
        body: '{"templateName":"Welcome","props":{}}',
      });
      return { status: response.status, text: await response.text() };
    };

    // No bundle exists yet: the render waits for the build started here.
    builder = email.watchEmailBundle();
    const first = await render();
    assert.equal(first.status, 200);
    assert.match(first.text, /Welcome, first edition/);

    writeTemplate(moduleRoot, "Welcome, second edition");
    const deadline = Date.now() + 60_000;
    let second = await render();
    while (!second.text.includes("second edition") && Date.now() < deadline) {
      await new Promise((settle) => setTimeout(settle, 200));
      second = await render();
    }
    assert.equal(second.status, 200);
    assert.match(second.text, /Welcome, second edition/);
  } finally {
    builder?.kill();
    frontend?.close();
    if (previousSecret === undefined) delete process.env.DMS_HTML_RENDER_SECRET;
    else process.env.DMS_HTML_RENDER_SECRET = previousSecret;
    rmSync(workspace, { recursive: true, force: true });
  }
});

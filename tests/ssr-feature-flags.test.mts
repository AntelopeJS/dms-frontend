import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

const SERVER_URL = pathToFileURL(
  join(process.cwd(), "templates", "vue", "server.mjs"),
).href;

function installVueI18n(loadServerFirst: boolean) {
  const script = `
    ${loadServerFirst ? `await import(${JSON.stringify(SERVER_URL)});` : ""}
    const { createSSRApp } = await import("vue");
    const { createI18n } = await import("vue-i18n");
    createSSRApp({ render: () => null }).use(createI18n({ legacy: false, locale: "en" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production" },
  });
}

it("installs the external vue-i18n build under NODE_ENV=production once the server is loaded", () => {
  const withoutServer = installVueI18n(false);
  assert.match(withoutServer.stderr, /__VUE_PROD_DEVTOOLS__ is not defined/);

  const withServer = installVueI18n(true);
  assert.equal(withServer.status, 0, withServer.stderr);
  assert.doesNotMatch(withServer.stderr, /ReferenceError/);
});

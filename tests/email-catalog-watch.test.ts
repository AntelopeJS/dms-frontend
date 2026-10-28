import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import {
  createFrontendModuleRegistry,
  getLayerWorkspacePath,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
  writeLocaleMessages,
} from "../src/common";
import { readText } from "./helpers/files";
import { copyEmailRendererFiles } from "./helpers/templates";

const TIMEOUT_MS = 60_000;

async function eventually(done: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail("the email bundle was not rebuilt with the new catalog");
}

it("rebuilds the email catalogs when they are regenerated during a watch-mode build", async () => {
  const workspace = mkdtempSync(resolve(".email-catalog-watch-"));
  const layer: ResolvedLayer = {
    path: join(workspace, "source"),
    packageName: "@fixture/mail",
  };
  const emitted = join(workspace, "dist", "server", "locales", "en.json");
  const subject = (): string | undefined => {
    try {
      return JSON.parse(readText(emitted)).subject;
    } catch {
      return undefined;
    }
  };
  try {
    mkdirSync(join(layer.path, "i18n", "locales"), { recursive: true });
    writeFileSync(
      join(layer.path, "package.json"),
      JSON.stringify({ name: layer.packageName }),
    );
    writeFileSync(
      join(layer.path, "i18n", "locales", "mail-en-GB.json"),
      JSON.stringify({ subject: "Welcome" }),
    );
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    materializeLayers(workspace, [layer]);
    writeFrontendModuleRegistry(workspace, [layer]);
    copyEmailRendererFiles(workspace);

    const { build } = await import("vite");
    const watcher = await build({
      root: workspace,
      configFile: join(workspace, "vite.email.config.ts"),
      logLevel: "silent",
      build: { watch: {} },
    });
    assert.ok("close" in watcher, "a watch-mode build returns its watcher");
    try {
      await eventually(() => subject() === "Welcome");
      writeFileSync(
        join(
          getLayerWorkspacePath(workspace, layer),
          "i18n",
          "locales",
          "mail-en-GB.json",
        ),
        JSON.stringify({ subject: "Welcome back" }),
      );
      writeLocaleMessages(
        workspace,
        createFrontendModuleRegistry(workspace, [layer]),
      );
      await eventually(() => subject() === "Welcome back");
    } finally {
      await watcher.close();
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

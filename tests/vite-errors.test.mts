import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import {
  captureViteErrors,
  runViteMiddlewares,
  writeViteError,
} from "../templates/vue/server/vite-errors.mjs";

const PAGE_FALLBACK_STATUS = 404;

describe("the dev server's answer to a module Vite cannot transform", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-vite-errors-"));
  const overlayErrors: unknown[] = [];
  let vite: ViteDevServer;
  let server: Server;
  let base: string;

  before(async () => {
    writeFileSync(join(root, "ok.ts"), "export const ok = 1;\n");
    writeFileSync(
      join(root, "broken.ts"),
      'import { missing } from "#dms-demo/app/utils/x";\nexport default missing;\n',
    );
    vite = await createViteServer({
      root,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      server: { middlewareMode: true, hmr: false },
      plugins: [captureViteErrors()],
    });
    const send = vite.ws.send.bind(vite.ws);
    vite.ws.send = ((payload: { type: string; err?: unknown }) => {
      if (payload.type === "error") overlayErrors.push(payload.err);
      return send(payload as never);
    }) as typeof vite.ws.send;
    server = createServer(async (request, response) => {
      const result = await runViteMiddlewares(vite, request, response);
      if (result.status === "handled") return;
      if (result.status === "failed")
        return writeViteError(response, result.error);
      response.statusCode = PAGE_FALLBACK_STATUS;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address() as { port: number };
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await vite.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("answers 500 with Vite's error instead of falling through to a 404", async () => {
    const response = await fetch(`${base}/broken.ts`);
    assert.equal(response.status, 500);
    assert.match(await response.text(), /#dms-demo\/app\/utils\/x/);
  });

  it("hands the error to the client overlay", async () => {
    await fetch(`${base}/broken.ts`);
    assert.ok(overlayErrors.length > 0);
    assert.match(
      (overlayErrors.at(-1) as { message: string }).message,
      /#dms-demo\/app\/utils\/x/,
    );
  });

  it("still serves a module that transforms", async () => {
    const response = await fetch(`${base}/ok.ts`);
    assert.equal(response.status, 200);
  });

  it("still passes on a request Vite does not handle", async () => {
    const response = await fetch(`${base}/not-a-module`);
    assert.equal(response.status, PAGE_FALLBACK_STATUS);
  });
});

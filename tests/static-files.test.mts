import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

interface StaticFiles {
  serveStaticFile: (
    file: string,
    request: unknown,
    response: unknown,
    options: { immutable: boolean },
  ) => void;
}
interface BuiltFiles {
  publicBuildFile: (root: string, pathname: string) => string | undefined;
}

const FONT = Buffer.from("wOF2 font bytes");
const SCRIPT = "export const probe = 1;\n".repeat(64);
const SCRIPT_BROTLI = Buffer.from("brotli bytes");
const ONE_DAY_MS = 86_400_000;

describe("the files of the build", () => {
  let root = "";
  let server: Server | undefined;
  let base = "";

  before(async () => {
    const { serveStaticFile } =
      (await import("../templates/vue/server/static-files.mjs")) as StaticFiles;
    const { publicBuildFile } =
      (await import("../templates/vue/server/built-files.mjs")) as BuiltFiles;
    root = await mkdtemp(join(tmpdir(), "dms-static-files-"));
    await mkdir(join(root, "fonts"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "fonts", "Face.woff2"), FONT);
    await writeFile(join(root, "assets", "app-abc123.js"), SCRIPT);
    await writeFile(join(root, "assets", "app-abc123.js.br"), SCRIPT_BROTLI);
    await mkdir(join(root, ".vite"));
    await writeFile(join(root, ".vite", "manifest.json"), "{}");
    server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://frontend").pathname;
      const file = publicBuildFile(root, pathname);
      if (file) {
        serveStaticFile(file, request, response, {
          immutable: pathname.startsWith("/assets/"),
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it("sends a font with its type, revalidated rather than downloaded again", async () => {
    const first = await fetch(`${base}/fonts/Face.woff2`);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("content-type"), "font/woff2");
    assert.equal(first.headers.get("cache-control"), "no-cache");
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), FONT);
    const tag = first.headers.get("etag");
    const modified = first.headers.get("last-modified");
    assert.match(tag ?? "", /^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    assert.ok(modified);

    const byTag = await fetch(`${base}/fonts/Face.woff2`, {
      headers: { "if-none-match": tag! },
    });
    assert.equal(byTag.status, 304);
    assert.equal(byTag.headers.get("etag"), tag);
    assert.equal(await byTag.text(), "");

    const byDate = await fetch(`${base}/fonts/Face.woff2`, {
      headers: { "if-modified-since": modified! },
    });
    assert.equal(byDate.status, 304);
    await byDate.body?.cancel();
  });

  it("sends the file again once it changed", async () => {
    const before = await fetch(`${base}/fonts/Face.woff2`);
    const tag = before.headers.get("etag")!;
    await before.body?.cancel();
    const later = new Date(Date.now() + ONE_DAY_MS);
    await utimes(join(root, "fonts", "Face.woff2"), later, later);

    const changed = await fetch(`${base}/fonts/Face.woff2`, {
      headers: { "if-none-match": tag },
    });
    assert.equal(changed.status, 200);
    assert.notEqual(changed.headers.get("etag"), tag);
    assert.deepEqual(Buffer.from(await changed.arrayBuffer()), FONT);
  });

  it("tags each encoding of a built asset apart", async () => {
    const brotli = await fetch(`${base}/assets/app-abc123.js`, {
      headers: { "accept-encoding": "br" },
    });
    assert.equal(brotli.headers.get("content-encoding"), "br");
    assert.equal(
      brotli.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal(brotli.headers.get("content-type"), "text/javascript");
    await brotli.body?.cancel();
    const identity = await fetch(`${base}/assets/app-abc123.js`, {
      headers: { "accept-encoding": "identity" },
    });
    assert.equal(identity.headers.get("content-encoding"), null);
    assert.equal(await identity.text(), SCRIPT);
    assert.notEqual(brotli.headers.get("etag"), identity.headers.get("etag"));

    const crossed = await fetch(`${base}/assets/app-abc123.js`, {
      headers: {
        "accept-encoding": "identity",
        "if-none-match": brotli.headers.get("etag")!,
      },
    });
    assert.equal(crossed.status, 200);
    await crossed.body?.cancel();
  });

  it("answers a HEAD request without a body", async () => {
    const head = await fetch(`${base}/fonts/Face.woff2`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(FONT.length));
    assert.equal(await head.text(), "");
  });

  it("still serves only the files publicBuildFile names", async () => {
    const metadata = await fetch(`${base}/.vite/manifest.json`);
    assert.equal(metadata.status, 404);
    await metadata.body?.cancel();
  });
});

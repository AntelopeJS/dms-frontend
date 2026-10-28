import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

interface BuiltFiles {
  isPublicBuildPath: (relativePath: string) => boolean;
}

const builtFiles = import(
  pathToFileURL(
    join(process.cwd(), "templates", "vue", "server", "built-files.mjs"),
  ).href
) as Promise<BuiltFiles>;

const PAGE_COMPONENT = "ArticleList";
const PAGE_MODULE = "frontend-modules/fixture/components/ArticleList.vue";
const PAGE_STYLESHEET = "assets/ArticleList-c3d4.css";
const ENTRY_SCRIPT = "export const entry = 1;\n".repeat(64);
const CLIENT_MANIFEST = `${JSON.stringify(
  {
    "main.ts": { file: "assets/main-a1b2.js", isEntry: true },
    [PAGE_MODULE]: {
      file: "assets/ArticleList-c3d4.js",
      isDynamicEntry: true,
      css: [PAGE_STYLESHEET],
    },
  },
  null,
  2,
)}\n`;

function writeBuiltFile(
  root: string,
  path: string,
  content: string | Buffer,
): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/**
 * A production workspace: the server template, a client build as `ajs dms
 * build` lays it out (the manifest and its compressed copies included), and
 * an SSR renderer that renders the page shell and reports the component it
 * rendered, as the real one does from `ssrContext.modules`.
 */
function writeProductionWorkspace(workspace: string): void {
  cpSync("templates/vue", workspace, { recursive: true });
  writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
  const client = join(workspace, "dist", "client");
  writeBuiltFile(
    client,
    "index.html",
    '<html><head><title>Antelope DMS</title><script type="module" src="/assets/main-a1b2.js"></script></head><body>__DMS_APP__<div id="dms-overlays" class="isolate"></div></body></html>',
  );
  writeBuiltFile(client, ".vite/manifest.json", CLIENT_MANIFEST);
  writeBuiltFile(
    client,
    ".vite/manifest.json.br",
    brotliCompressSync(CLIENT_MANIFEST),
  );
  writeBuiltFile(client, ".vite/manifest.json.gz", gzipSync(CLIENT_MANIFEST));
  writeBuiltFile(client, "assets/main-a1b2.js", ENTRY_SCRIPT);
  writeBuiltFile(
    client,
    "assets/main-a1b2.js.br",
    brotliCompressSync(ENTRY_SCRIPT),
  );
  writeBuiltFile(client, PAGE_STYLESHEET, "main{color:red}\n");
  writeBuiltFile(client, "assets/.hidden.js", "export const hidden = 1;\n");
  writeBuiltFile(client, ".hidden.txt", "hidden\n");
  writeBuiltFile(client, ".well-known/security.txt", "Contact: test\n");
  writeBuiltFile(client, "images/logo light.svg", "<svg></svg>\n");
  writeBuiltFile(
    join(workspace, "dist", "ssr"),
    "ssr-renderer.js",
    `export async function renderDmsPage(page) {
  const name = page.props.page.componentName;
  return { body: '<div id="app">' + (name ?? "error") + "</div>", head: { headTags: "", htmlAttrs: "", bodyAttrs: "" }, overlays: "", modules: name === ${JSON.stringify(PAGE_COMPONENT)} ? [${JSON.stringify(PAGE_MODULE)}] : [] };
}
export function isDmsFrontendPage() {
  return false;
}
export function accessRedirect() {
  return undefined;
}
export function registerDmsIconCollections() {}\n`,
  );
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

describe("built files the production server serves", () => {
  it("serves no path with a dot segment but /.well-known/, whatever the separator", async () => {
    const { isPublicBuildPath } = await builtFiles;
    for (const path of [
      "index.html",
      "assets/main-a1b2.js",
      "assets\\main-a1b2.js",
      ".well-known/security.txt",
      ".well-known\\security.txt",
    ])
      assert.equal(isPublicBuildPath(path), true, path);
    for (const path of [
      ".vite/manifest.json",
      ".vite\\manifest.json",
      ".vite/manifest.json.br",
      ".DS_Store",
      "assets/.hidden.js",
      "assets\\.vite\\manifest.json",
      "assets/.well-known/security.txt",
      ".well-known-not/security.txt",
    ])
      assert.equal(isPublicBuildPath(path), false, path);
  });

  it("keeps the build manifest private while the pages and assets it describes are served", async () => {
    const workspace = mkdtempSync(resolve(".built-files-"));
    const previousBackend = process.env.DMS_API_BASE_URL;
    const backend = createServer((request, response) => {
      const path = new URL(
        request.url ?? "/",
        "http://fixture",
      ).searchParams.get("path");
      response.setHeader("content-type", "application/json");
      if (path !== "/articles") {
        response.statusCode = 404;
        response.end('{"message":"Not found"}');
        return;
      }
      response.end(JSON.stringify({ componentName: PAGE_COMPONENT }));
    });
    let frontend: Server | undefined;
    try {
      writeProductionWorkspace(workspace);
      process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
      const { handleRequestSafely } = await import(
        pathToFileURL(join(workspace, "server.mjs")).href
      );
      frontend = createServer(handleRequestSafely);
      const base = `http://127.0.0.1:${await listen(frontend)}`;
      const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(`${base}${path}`, {
          headers: { accept: "text/html", ...headers },
          redirect: "manual",
        });

      const missing = await get("/missing-file.json");
      assert.equal(missing.status, 404);
      await missing.body?.cancel();
      for (const [path, headers] of [
        ["/.vite/manifest.json", {}],
        ["/.vite/manifest.json", { "accept-encoding": "br, gzip" }],
        ["/.vite/manifest.json", { "accept-encoding": "gzip" }],
        ["/.vite/manifest.json.br", {}],
        ["/.vite/manifest.json.gz", {}],
        ["/%2Evite/manifest.json", {}],
        ["/%2evite%2fmanifest.json", {}],
        ["/assets/..%2F.vite/manifest.json", {}],
        ["/assets/..%2F..%2Fserver.mjs", {}],
        ["/assets/%2e%2e/.vite/manifest.json", {}],
        ["/assets/.hidden.js", {}],
        ["/.hidden.txt", {}],
      ] as const) {
        const response = await get(path, headers);
        const body = await response.text();
        assert.equal(
          response.status,
          404,
          `${path} ${JSON.stringify(headers)}`,
        );
        assert.doesNotMatch(
          body,
          /ArticleList\.vue|isDynamicEntry|hidden/,
          path,
        );
      }

      const entry = await get("/assets/main-a1b2.js");
      assert.equal(entry.status, 200);
      assert.equal(await entry.text(), ENTRY_SCRIPT);
      assert.equal(
        entry.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assert.equal(entry.headers.get("content-type"), "text/javascript");
      assert.equal(entry.headers.get("vary"), "Accept-Encoding");
      const compressed = await fetch(`${base}/assets/main-a1b2.js`, {
        headers: { "accept-encoding": "br" },
      });
      assert.equal(compressed.status, 200);
      assert.equal(compressed.headers.get("content-encoding"), "br");
      assert.equal(await compressed.text(), ENTRY_SCRIPT);
      const encoded = await get("/images/logo%20light.svg");
      assert.equal(encoded.status, 200);
      assert.equal(encoded.headers.get("content-type"), "image/svg+xml");
      assert.equal(await encoded.text(), "<svg></svg>\n");
      const wellKnown = await get("/.well-known/security.txt");
      assert.equal(wellKnown.status, 200);
      assert.equal(wellKnown.headers.get("cache-control"), "no-cache");
      assert.equal(await wellKnown.text(), "Contact: test\n");

      const page = await get("/articles");
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<div id="app">ArticleList<\/div>/);
      assert.ok(
        html.includes(`<link rel="stylesheet" href="/${PAGE_STYLESHEET}">`),
        html,
      );
      const visit = await get("/articles", { "x-inertia": "true" });
      assert.equal(visit.status, 200);
      assert.equal(
        ((await visit.json()) as { version: string }).version,
        createHash("sha256").update(CLIENT_MANIFEST).digest("hex"),
      );
    } finally {
      frontend?.close();
      backend.close();
      if (previousBackend === undefined) delete process.env.DMS_API_BASE_URL;
      else process.env.DMS_API_BASE_URL = previousBackend;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

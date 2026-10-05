import assert from "node:assert/strict";
import {
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { _api, addAPIProvider, loadIcon } from "@iconify/vue";
import {
  ICON_API_PATH,
  sameOriginIconProvider,
} from "../templates/vue/icon-api.mjs";
import { iconScanGlobs } from "../templates/vue/icon-scan.mjs";
import {
  iconResponse,
  installedCollections,
  isIconRequest,
} from "../templates/vue/server/icons.mjs";

const ORIGIN = "http://frontend.local";
const CHECK_ICON = { body: '<path d="M1 1h2"/>' };
const COLLECTION = {
  prefix: "demo",
  width: 256,
  height: 256,
  icons: { check: CHECK_ICON, gear: { body: '<path d="M2 2h4"/>' } },
  aliases: { tick: { parent: "check" } },
};

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function iconUrl(path: string): URL {
  return new URL(`${ICON_API_PATH}${path}`, ORIGIN);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

describe("the same-origin Iconify API", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-icons-"));

  before(() => {
    writeFixture(root, "package.json", '{"name":"workspace"}');
    writeFixture(
      root,
      "node_modules/@iconify-json/demo/package.json",
      '{"name":"@iconify-json/demo"}',
    );
    writeFixture(
      root,
      "node_modules/@iconify-json/demo/icons.json",
      JSON.stringify(COLLECTION),
    );
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("answers the requested subset of an installed collection", async () => {
    const response = await iconResponse(
      root,
      "GET",
      iconUrl("demo.json?icons=check,tick,missing"),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], "application/json");
    assert.match(response.headers["cache-control"], /public, max-age=\d+/);
    const data = JSON.parse(response.body);
    assert.equal(data.prefix, "demo");
    assert.deepEqual(data.icons, { check: CHECK_ICON });
    assert.deepEqual(data.aliases, { tick: { parent: "check" } });
    assert.deepEqual(data.not_found, ["missing"]);
    assert.equal(data.width, 256);
  });

  it("answers 404 for a collection that is not installed", async () => {
    const response = await iconResponse(
      root,
      "GET",
      iconUrl("unknown.json?icons=check"),
    );
    assert.equal(response.status, 404);
    assert.equal(response.headers["cache-control"], "no-store");
  });

  it("rejects any prefix or icon name outside Iconify's naming rule", async () => {
    for (const path of [
      "demo.json?icons=../check",
      "demo.json?icons=Check",
      "demo.json?icons=check,a/b",
      "demo.json",
      "..%2Fdemo.json?icons=check",
      "demo/icons.json?icons=check",
      "Demo.json?icons=check",
      "demo.svg?icons=check",
    ]) {
      const response = await iconResponse(root, "GET", iconUrl(path));
      assert.equal(response.status, 400, path);
    }
  });

  it("loads every installed collection for the server render", async () => {
    assert.deepEqual(await installedCollections(root), [COLLECTION]);
    const empty = mkdtempSync(join(tmpdir(), "dms-no-icons-"));
    try {
      assert.deepEqual(await installedCollections(empty), []);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("only answers reads", async () => {
    const response = await iconResponse(
      root,
      "POST",
      iconUrl("demo.json?icons=check"),
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, "GET, HEAD");
  });
});

describe("the generated server's icon route", () => {
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backendPaths: string[] = [];
  const backend = createServer((request, response) => {
    backendPaths.push(request.url ?? "");
    response.writeHead(502);
    response.end();
  });
  let frontend: Server | undefined;
  let base = "";

  before(async () => {
    process.env.DMS_API_BASE_URL = await listen(backend);
    const runtime = (await import(
      pathToFileURL(join("templates", "vue", "server.mjs")).href
    )) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    base = await listen(frontend);
  });

  after(() => {
    process.env.DMS_API_BASE_URL = previousBackend;
    frontend?.close();
    backend.close();
  });

  it("answers icon queries itself instead of proxying them", async () => {
    const unknown = await fetch(
      `${base}${ICON_API_PATH}unknown.json?icons=check`,
    );
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), {
      message: "Unknown icon collection",
    });
    const invalid = await fetch(`${base}${ICON_API_PATH}demo.json?icons=A`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(backendPaths, [], "no icon query reaches the backend");
  });
});

describe("the client's Iconify API provider", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-icon-provider-"));
  const requested: string[] = [];

  before(() => {
    writeFixture(
      root,
      "node_modules/@iconify-json/demo/icons.json",
      JSON.stringify(COLLECTION),
    );
    _api.setFetch(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requested.push(url.href);
      const { status, headers, body } = await iconResponse(root, "GET", url);
      return new Response(body, { status, headers });
    });
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("loads every icon the bundle lacks from the page's own origin", async () => {
    assert.equal(addAPIProvider("", sameOriginIconProvider(ORIGIN)), true);
    const icon = await loadIcon("demo:check");
    assert.equal(icon.body, CHECK_ICON.body);
    assert.deepEqual(requested, [
      `${ORIGIN}${ICON_API_PATH}demo.json?icons=check`,
    ]);
    assert.ok(isIconRequest(new URL(requested[0]).pathname));
  });

  it("is registered by the client entry before any module sets up", () => {
    const entry = readFileSync(join("templates", "vue", "main.ts"), "utf8");
    const registration = entry.indexOf(
      'addAPIProvider("", sameOriginIconProvider(location.origin));',
    );
    assert.ok(registration > 0);
    assert.ok(registration < entry.indexOf("await setupFrontendModules("));
  });
});

describe("the client-bundle icon scan", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-icon-scan-"));
  const layer = join(root, "frontend-modules", "dms", "layers", "dms-layout");
  const module = join(root, "frontend-modules", "ai");

  before(() => {
    writeFixture(layer, "app/app.config.ts", 'check: "i-ph-check-light"');
    writeFixture(layer, "app/components/Header.vue", "<UIcon />");
    writeFixture(module, "app/composables/launcher.ts", '"i-ph-robot"');
    writeFixture(module, "tests/launcher.test.ts", '"i-ph-bug"');
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it("reads the TypeScript of every layer's app directory", () => {
    const globs = iconScanGlobs(root, [layer, module]);
    assert.ok(globs.includes("**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml}"));
    const scanned = globSync(globs, { cwd: root }).map((path) =>
      path.split("\\").join("/"),
    );
    assert.deepEqual(scanned.sort(), [
      "frontend-modules/ai/app/composables/launcher.ts",
      "frontend-modules/dms/layers/dms-layout/app/app.config.ts",
      "frontend-modules/dms/layers/dms-layout/app/components/Header.vue",
    ]);
  });

  it("is what the generated Vite config hands Nuxt UI", () => {
    const config = readFileSync(
      join("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    assert.match(
      config,
      /scan: \{ globInclude: iconScanGlobs\(__dirname, frontendSourceRoots\) \}/,
    );
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { addressOf } from "./helpers/net";

/** A request the server dropped would otherwise wait forever. */
const REQUEST_TIMEOUT_MS = 10_000;
/** How long a scheduled retry really waits: the page asks for longer. */
const FAST_DELAY_MS = 5;
/** The delays a page asks for while the backend stays down. */
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 8000];

async function listen(server: Server, port = 0): Promise<string> {
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  return `http://127.0.0.1:${addressOf(server).port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

/** The inline classic scripts of a document: the ones a browser runs at once. */
function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    ([, code = ""]) => code,
  );
}

interface PageRun {
  readonly delays: number[];
  readonly reloaded: Promise<number>;
}

/**
 * Runs a document's inline scripts as the browser would at `href`, with the
 * real `fetch`; the reload resolves with the status the page answers then.
 */
function runPage(html: string, href: string): PageRun {
  const delays: number[] = [];
  const reloaded = new Promise<number>((resolve) => {
    const location = {
      href,
      reload: () => {
        void fetch(href, { headers: { accept: "text/html" } }).then((answer) =>
          resolve(answer.status),
        );
      },
    };
    const context = {
      location,
      fetch,
      setTimeout: (callback: () => void, delay: number) => {
        delays.push(delay);
        return setTimeout(callback, FAST_DELAY_MS);
      },
    };
    for (const code of inlineScripts(html)) runInNewContext(code, context);
  });
  return { delays, reloaded };
}

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (!holds()) {
    assert.ok(Date.now() < deadline, "the condition held in time");
    await new Promise((resolve) => setTimeout(resolve, FAST_DELAY_MS));
  }
}

const answerPage: RequestListener = (_request, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end("{}");
};

void describe("the error page served while the backend is unreachable", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-backend-retry-"));
  const previousCwd = process.cwd();
  const previousDev = process.env.DMS_DEV;
  const previousBackend = process.env.DMS_API_BASE_URL;
  let frontend: Server | undefined;
  let backendPort = 0;
  let base = "";

  before(async () => {
    const probe = createServer();
    await listen(probe);
    backendPort = addressOf(probe).port;
    await close(probe);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendPort}`;
    writeFileSync(
      join(root, "vite.config.mjs"),
      "export default { logLevel: 'silent', server: { watch: null, ws: false } };",
    );
    process.env.DMS_DEV = "true";
    process.chdir(root);
    const runtime = await import("../templates/vue/server.mjs");
    frontend = createServer(runtime.handleRequestSafely);
    base = await listen(frontend);
  });

  after(async () => {
    process.chdir(previousCwd);
    process.env.DMS_DEV = previousDev;
    process.env.DMS_API_BASE_URL = previousBackend;
    if (frontend) await close(frontend);
    rmSync(root, { recursive: true, force: true });
  });

  async function visit(path: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  void it("loads the page once the backend is up again, asking less often while it stays down", async (context) => {
    context.mock.method(console, "error", () => undefined);
    const down = await visit("/articles");
    assert.equal(down.status, 502);
    const page = runPage(await down.text(), `${base}/articles`);
    await until(() => page.delays.length >= BACKOFF_MS.length);
    assert.deepEqual(
      page.delays.slice(0, BACKOFF_MS.length),
      BACKOFF_MS,
      "each retry waits twice as long, up to a bound",
    );
    const backend = createServer(answerPage);
    await listen(backend, backendPort);
    try {
      const status = await page.reloaded;
      assert.notEqual(status, 502, "the reload shows the page, not the 502");
    } finally {
      await close(backend);
    }
  });

  void it("does not retry an error the backend answered", async (context) => {
    context.mock.method(console, "error", () => undefined);
    const backend = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end('{"message":"broken"}');
    });
    await listen(backend, backendPort);
    try {
      const failed = await visit("/articles");
      assert.equal(failed.status, 500);
      const page = runPage(await failed.text(), `${base}/articles`);
      assert.deepEqual(page.delays, [], "a 500 page schedules no retry");
    } finally {
      await close(backend);
    }
  });
});

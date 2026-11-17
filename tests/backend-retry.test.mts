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
/** A page that never reloads fails its test instead of hanging the run. */
const TEST_TIMEOUT_MS = 15_000;
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

interface NavigateEvent {
  readonly detail: {
    readonly page: {
      readonly props: { readonly error?: { statusCode: number } };
    };
  };
}

type Listener = (event: NavigateEvent) => void;

interface PageRun {
  readonly delays: number[];
  readonly fetches: () => number;
  readonly reloaded: Promise<number>;
  /** Plays Inertia showing a page whose error status is `statusCode`. */
  readonly navigate: (statusCode?: number) => void;
}

/**
 * Runs a document's inline scripts as the browser would at `href`, with the
 * real `fetch`; the reload resolves with the status the page answers then.
 */
function runPage(html: string, href: string): PageRun {
  const delays: number[] = [];
  const listeners: Listener[] = [];
  let fetches = 0;
  const reloaded = new Promise<number>((resolve) => {
    const location = {
      href,
      reload: () => {
        void fetch(href, { headers: { accept: "text/html" } }).then((answer) =>
          resolve(answer.status),
        );
      },
    };
    const document = {
      addEventListener: (type: string, listener: Listener) => {
        if (type === "inertia:navigate") listeners.push(listener);
      },
    };
    const context = {
      location,
      document,
      fetch: (...request: Parameters<typeof fetch>) => {
        fetches += 1;
        return fetch(...request);
      },
      setTimeout: (callback: () => void, delay: number) => {
        delays.push(delay);
        return setTimeout(callback, FAST_DELAY_MS);
      },
    };
    for (const code of inlineScripts(html)) runInNewContext(code, context);
  });
  const navigate = (statusCode?: number) => {
    const error = statusCode === undefined ? undefined : { statusCode };
    for (const listener of listeners)
      listener({ detail: { page: { props: { error } } } });
  };
  return { delays, fetches: () => fetches, reloaded, navigate };
}

async function until(holds: () => boolean): Promise<void> {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (!holds()) {
    assert.ok(Date.now() < deadline, "the condition held in time");
    await new Promise((resolve) => setTimeout(resolve, FAST_DELAY_MS));
  }
}

function answering(status: number, body = "{}"): RequestListener {
  return (_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

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
    restoreEnv("DMS_DEV", previousDev);
    restoreEnv("DMS_API_BASE_URL", previousBackend);
    if (frontend) await close(frontend);
    rmSync(root, { recursive: true, force: true });
  });

  async function visit(path: string): Promise<Response> {
    return fetch(`${base}${path}`, {
      headers: { accept: "text/html" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function withBackend<T>(
    handler: RequestListener,
    run: () => Promise<T>,
  ): Promise<T> {
    const backend = createServer(handler);
    await listen(backend, backendPort);
    try {
      return await run();
    } finally {
      await close(backend);
    }
  }

  void it(
    "reloads once the backend is up again, asking less often while it stays down",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
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
      const status = await withBackend(answering(200), () => page.reloaded);
      assert.notEqual(status, 502, "the reload is no longer the 502 page");
    },
  );

  void it(
    "stops asking once the visitor left the error page",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      context.mock.method(console, "error", () => undefined);
      const down = await visit("/articles");
      const page = runPage(await down.text(), `${base}/articles`);
      page.navigate(502);
      await until(() => page.fetches() >= 2);
      page.navigate();
      const asked = page.fetches();
      await new Promise((resolve) => setTimeout(resolve, FAST_DELAY_MS * 20));
      assert.ok(
        page.fetches() <= asked + 1,
        "at most the request already scheduled goes out",
      );
      assert.ok(
        page.delays.length <= asked + 1,
        "no retry is scheduled after the page left",
      );
    },
  );

  void it(
    "retries a 503 the backend answered, and not a 500",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      context.mock.method(console, "error", () => undefined);
      for (const [status, retried] of [
        [503, true],
        [500, false],
      ] as const) {
        const failed = await withBackend(
          answering(status, '{"message":"failed"}'),
          () => visit("/articles"),
        );
        assert.equal(failed.status, status);
        const page = runPage(await failed.text(), `${base}/articles`);
        assert.equal(
          page.delays.length > 0,
          retried,
          `a ${status} page schedules a retry: ${retried}`,
        );
        page.navigate();
      }
    },
  );
});

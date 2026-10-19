import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import "./fixtures/dms-backend-proxies.mts";
import { backendResponseError } from "../templates/vue/server/backend-response.mjs";
import { fetchWaking } from "../templates/vue/server/backend-wake.mjs";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

interface Answer {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  /** Never answers, as a backend stuck while it starts. */
  hangs?: boolean;
  /** Sends the body, then a second part this many ms later. */
  trickleMs?: number;
}

const COLD: Answer = {
  status: 503,
  headers: {
    "x-antelope-cold-start": "1",
    "retry-after": "1",
    "content-type": "text/html",
  },
  body: "<html>Waking up</html>",
};
const READY: Answer = {
  status: 200,
  headers: { "content-type": "application/json" },
  body: '{"ok":true}',
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/**
 * The platform answers for a sleeping backend with its cold-start 503 until a
 * replica is up. The renderer waits that out for a GET or a HEAD only, and
 * passes every other answer on as the backend gave it.
 */
describe("the proxy waits out a waking backend", () => {
  const previous = {
    backend: process.env.DMS_API_BASE_URL,
    budget: process.env.DMS_BACKEND_WAKE_BUDGET_MS,
    secret: process.env.DMS_SESSION_SECRET,
  };
  let answers: Answer[] = [];
  let requests: { method: string; at: number; abortedAt?: number }[] = [];
  const backend = createServer((request, response) => {
    const seen = { method: request.method ?? "", at: Date.now() };
    requests.push(seen);
    request.resume();
    request.on("end", () => {
      const answer = answers.shift() ?? READY;
      if (answer.hangs) {
        response.on("close", () => {
          seen.abortedAt = Date.now();
        });
        return;
      }
      if (answer.trickleMs) {
        response.writeHead(answer.status, answer.headers);
        response.write("first;");
        setTimeout(() => response.end("second"), answer.trickleMs);
        return;
      }
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body ?? "");
    });
  });
  let frontendUrl = "";
  let frontend: Server | undefined;

  before(async () => {
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    const runtime =
      (await import("../templates/vue/server.mjs")) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    frontendUrl = `http://127.0.0.1:${await listen(frontend)}`;
  });

  beforeEach(() => {
    answers = [];
    requests = [];
    delete process.env.DMS_BACKEND_WAKE_BUDGET_MS;
  });

  after(() => {
    for (const [name, value] of Object.entries({
      DMS_API_BASE_URL: previous.backend,
      DMS_BACKEND_WAKE_BUDGET_MS: previous.budget,
      DMS_SESSION_SECRET: previous.secret,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    frontend?.close();
    backend.closeAllConnections();
    backend.close();
  });

  it("answers a GET once the backend is up, after the pauses Retry-After asks for", async () => {
    answers = [COLD, COLD, READY];
    const response = await fetch(`${frontendUrl}/api/items`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(requests.length, 3);
    const pauses = requests.slice(1).map((r, i) => r.at - requests[i].at);
    for (const pause of pauses) assert.ok(pause >= 950, `paused ${pause}ms`);
  });

  it("passes the backend's own 503 on at once", async () => {
    for (const headers of [
      { "retry-after": "1" },
      { "x-antelope-cold-start": "1" },
      { "x-antelope-cold-start": "1", "retry-after": "soon" },
    ]) {
      answers = [{ status: 503, headers, body: "maintenance" }, READY];
      requests = [];
      const response = await fetch(`${frontendUrl}/api/items`);
      assert.equal(response.status, 503, JSON.stringify(headers));
      assert.equal(await response.text(), "maintenance");
      assert.equal(requests.length, 1, JSON.stringify(headers));
    }
  });

  it("sends a POST once, even when the platform answers it as cold", async () => {
    answers = [COLD, READY];
    const response = await fetch(`${frontendUrl}/api/items`, {
      method: "POST",
      headers: { origin: frontendUrl, "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 503);
    await response.arrayBuffer();
    assert.deepEqual(
      requests.map((r) => r.method),
      ["POST"],
    );
  });

  it("relays the platform's 503 and Retry-After once the budget is spent", async () => {
    process.env.DMS_BACKEND_WAKE_BUDGET_MS = "1500";
    answers = [COLD, COLD, COLD, COLD];
    const started = Date.now();
    const response = await fetch(`${frontendUrl}/api/items`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    await response.arrayBuffer();
    assert.equal(requests.length, 2);
    assert.ok(Date.now() - started < 2500);
  });

  it("aborts a repeat still unanswered when the budget runs out", async () => {
    process.env.DMS_BACKEND_WAKE_BUDGET_MS = "1500";
    answers = [COLD, { status: 200, hangs: true }];
    const started = Date.now();
    const response = await fetch(`${frontendUrl}/api/items`);
    const elapsed = Date.now() - started;
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
    await response.arrayBuffer();
    assert.ok(elapsed >= 1400 && elapsed < 2200, `answered in ${elapsed}ms`);
    await sleep(100);
    assert.equal(requests.length, 2);
    const abortedAfter = (requests[1].abortedAt ?? Infinity) - requests[0].at;
    assert.ok(
      abortedAfter < 2200,
      `backend request aborted ${abortedAfter}ms in`,
    );
  });

  it("streams a ready answer past the budget", async () => {
    process.env.DMS_BACKEND_WAKE_BUDGET_MS = "1500";
    answers = [
      COLD,
      {
        status: 200,
        headers: { "content-type": "text/plain" },
        trickleMs: 1500,
      },
    ];
    const response = await fetch(`${frontendUrl}/api/items`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "first;second");
    assert.equal(requests.length, 2);
  });

  it("stops waiting when the client leaves", async () => {
    answers = [COLD, COLD, READY];
    const client = new AbortController();
    const pending = fetch(`${frontendUrl}/api/items`, {
      signal: client.signal,
    }).catch((error: Error) => error);
    await sleep(300);
    client.abort();
    assert.ok((await pending) instanceof Error);
    await sleep(1500);
    assert.equal(requests.length, 1);
  });
});

describe("a wait the event loop held up", () => {
  it("sends nothing once the pause ends past the budget", async () => {
    let hits = 0;
    const backend = createServer((request, response) => {
      hits += 1;
      response.writeHead(COLD.status, COLD.headers).end();
    });
    const url = `http://127.0.0.1:${await listen(backend)}/`;
    let skew = 0;
    const stall = setTimeout(() => {
      skew = 10_000;
    }, 500);
    try {
      const response = await fetchWaking(
        url,
        {},
        {
          budgetMs: 5_000,
          now: () => Date.now() + skew,
        },
      );
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "1");
      assert.equal(hits, 1);
    } finally {
      clearTimeout(stall);
      backend.close();
    }
  });
});

describe("a failed backend response", () => {
  it("keeps Retry-After for the platform's cold start only", async () => {
    const cold = await backendResponseError(
      new Response("", { status: 503, headers: COLD.headers }),
    );
    assert.equal(cold.status, 503);
    assert.equal(cold.retryAfter, "1");
    const own = await backendResponseError(
      new Response("", { status: 503, headers: { "retry-after": "1" } }),
    );
    assert.equal(own.retryAfter, undefined);
    const unsigned = await backendResponseError(
      new Response("", {
        status: 503,
        headers: { "x-antelope-cold-start": "1" },
      }),
    );
    assert.equal(unsigned.retryAfter, undefined);
  });
});

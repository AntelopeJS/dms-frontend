import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareWithBackend,
  followModuleSet,
  moduleSetFingerprint,
  reportFrontendReady,
} from "../src/module-set";

const ownVersion: string = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
).version;

interface RecordedRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

const dmsModule = {
  name: "@antelopejs/dms-frontend-vue",
  path: "/dms",
  priority: 0,
};
const langModule = {
  name: "@antelopejs/dms-lang-frontend-vue",
  path: "/lang",
  priority: 0,
};

type ServedModule = typeof dmsModule & {
  publicEndpoints?: unknown[];
  backendProxies?: unknown[];
};

function manifestOf(modules: ServedModule[]) {
  return {
    version: 1,
    archive: "/dms/frontend/modules",
    modules: modules.map((module) => ({
      ...module,
      archiveName: module.name,
      renderer: { name: "vue", version: "3" },
    })),
  };
}

describe("module set", () => {
  let server: Server;
  let backendUrl: string;
  let served: ServedModule[] = [dmsModule];
  let settling = false;
  const requests: RecordedRequest[] = [];

  before(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        });
        response.setHeader("content-type", "application/json");
        if (request.url?.startsWith("/dms/frontend/ready")) {
          response.end("{}");
          return;
        }
        response.end(JSON.stringify({ ...manifestOf(served), settling }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    backendUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => server.close());

  it("ignores the order of modules but not their sources", () => {
    assert.equal(
      moduleSetFingerprint([dmsModule, langModule]),
      moduleSetFingerprint([langModule, dmsModule]),
    );
    assert.notEqual(
      moduleSetFingerprint([dmsModule]),
      moduleSetFingerprint([{ ...dmsModule, path: "/elsewhere" }]),
    );
  });

  it("tells apart the endpoints and the backend proxies a module declares", () => {
    const tracker = {
      ...dmsModule,
      publicEndpoints: [{ path: "/api/tracker/beacon" }],
      backendProxies: [{ path: "/media/**", auth: "none" as const }],
    };
    assert.equal(
      moduleSetFingerprint([tracker]),
      moduleSetFingerprint([structuredClone(tracker)]),
    );
    assert.notEqual(
      moduleSetFingerprint([tracker]),
      moduleSetFingerprint([
        { ...tracker, publicEndpoints: [{ path: "/api/tracker/*" }] },
      ]),
    );
    assert.notEqual(
      moduleSetFingerprint([tracker]),
      moduleSetFingerprint([{ ...tracker, backendProxies: [] }]),
    );
    assert.notEqual(
      moduleSetFingerprint([dmsModule]),
      moduleSetFingerprint([tracker]),
    );
  });

  it(
    "calls back once a module declares other public endpoints",
    { timeout: 2000 },
    async () => {
      served = [dmsModule];
      const changed = new Promise<void>((resolve) => {
        const stop = followModuleSet({
          backendUrl,
          fingerprint: moduleSetFingerprint([dmsModule]),
          intervalMs: 20,
          onChange: () => {
            stop();
            resolve();
          },
        });
      });
      served = [
        { ...dmsModule, publicEndpoints: [{ path: "/api/tracker/beacon" }] },
      ];
      await changed;
      served = [dmsModule];
    },
  );

  it("calls back once the backend serves another set", async () => {
    served = [dmsModule];
    let changes = 0;
    const changed = new Promise<void>((resolve) => {
      followModuleSet({
        backendUrl,
        fingerprint: moduleSetFingerprint([dmsModule]),
        intervalMs: 20,
        onChange: () => {
          changes += 1;
          resolve();
        },
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 0);
    served = [dmsModule, langModule];
    await changed;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 1);
  });

  it("ignores a set seen on one read only", async () => {
    served = [dmsModule];
    let changes = 0;
    const stop = followModuleSet({
      backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 50,
      onChange: () => (changes += 1),
    });
    served = [];
    await new Promise((resolve) => setTimeout(resolve, 75));
    served = [dmsModule];
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    assert.equal(changes, 0);
  });

  it("waits while the backend says its set is settling", async () => {
    served = [];
    settling = true;
    let changes = 0;
    const stop = followModuleSet({
      backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 20,
      onChange: () => (changes += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();
    settling = false;
    assert.equal(changes, 0);
  });

  it("tells each unchanged read, so a restarted backend hears again", async () => {
    served = [dmsModule];
    let unchanged = 0;
    const stop = followModuleSet({
      backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 20,
      onChange: () => undefined,
      onUnchanged: () => (unchanged += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    assert.ok(unchanged >= 2);
  });

  it("stops following when asked", async () => {
    served = [dmsModule];
    let changes = 0;
    const stop = followModuleSet({
      backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 20,
      onChange: () => (changes += 1),
    });
    stop();
    served = [dmsModule, langModule];
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 0);
  });

  it("reports the served modules and its own version with the bootstrap credential", async () => {
    const isTaken = await reportFrontendReady(
      backendUrl,
      [dmsModule.name],
      "secret",
    );
    const report = requests.find((request) =>
      request.url?.startsWith("/dms/frontend/ready"),
    );
    assert.equal(isTaken, true);
    assert.equal(report?.method, "POST");
    assert.equal(report?.headers["x-dms-bootstrap"], "secret");
    assert.deepEqual(JSON.parse(report?.body ?? "{}"), {
      modules: [dmsModule.name],
      version: ownVersion,
    });
  });

  it("does not fail when the backend cannot take the report", async () => {
    assert.equal(await reportFrontendReady("http://127.0.0.1:1", ["x"]), false);
  });
});

describe("comparing a build with its backend", () => {
  const retry = { firstDelayMs: 10, maxDelayMs: 40, readTimeoutMs: 200 };
  const digestOf = (modules: readonly { name: string }[]) =>
    modules.map((module) => module.name).join(",");
  let answers: ((response: import("node:http").ServerResponse) => void)[];
  let reads = 0;
  let server: Server;
  let backendUrl: string;

  before(async () => {
    server = createServer((_request, response) => {
      reads += 1;
      const answer = answers.shift();
      if (answer) {
        answer(response);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(manifestOf([dmsModule])));
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    backendUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("still compares when the backend answers only after the read timeout, then while starting", async () => {
    reads = 0;
    answers = [
      (response) => setTimeout(() => response.end(), 500),
      (response) => {
        response.statusCode = 503;
        response.end("error.server_starting");
      },
    ];

    const drift = await compareWithBackend(
      backendUrl,
      dmsModule.name,
      digestOf,
      undefined,
      retry,
    );

    assert.deepEqual(drift, { status: "matches", served: dmsModule.name });
    assert.equal(reads, 3);
  });

  it("reports a drift found once the backend answers", async () => {
    reads = 0;
    answers = [
      (response) => {
        response.statusCode = 504;
        response.end();
      },
    ];

    const drift = await compareWithBackend(
      backendUrl,
      langModule.name,
      digestOf,
      undefined,
      retry,
    );

    assert.deepEqual(drift, { status: "drifted", served: dmsModule.name });
    assert.equal(reads, 2);
  });

  it("does not read again a backend that answered with a refusal", async () => {
    reads = 0;
    answers = [
      (response) => {
        response.statusCode = 404;
        response.end();
      },
    ];

    const drift = await compareWithBackend(
      backendUrl,
      dmsModule.name,
      digestOf,
      undefined,
      retry,
    );

    assert.equal(drift.status, "unknown");
    assert.equal(reads, 1);
  });
});

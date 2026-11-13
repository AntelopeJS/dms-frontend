import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  followModuleSet,
  moduleSetFingerprint,
  reportFrontendReady,
  reportFrontendReadyOnceAnswered,
} from "../src/module-set";
import { OWN_PACKAGE } from "./helpers/own-package";
import { addressOf } from "./helpers/net";

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

interface ModuleSetFixture {
  backendUrl: string;
  served: ServedModule[];
  settling: boolean;
  requests: RecordedRequest[];
}

function manifestOf(modules: ServedModule[]) {
  return {
    version: 2,
    modules: modules.map((module) => ({
      ...module,
      renderer: { name: "vue", version: "3" },
    })),
  };
}

function registerCallbackTests(state: ModuleSetFixture): void {
  void it(
    "calls back once a module declares other public endpoints",
    { timeout: 2000 },
    async () => {
      state.served = [dmsModule];
      let changes = 0;
      const changed = new Promise<void>((resolve) => {
        const stop = followModuleSet({
          backendUrl: state.backendUrl,
          fingerprint: moduleSetFingerprint([dmsModule]),
          intervalMs: 20,
          onChange: () => {
            changes += 1;
            stop();
            resolve();
          },
        });
      });
      state.served = [
        { ...dmsModule, publicEndpoints: [{ path: "/api/tracker/beacon" }] },
      ];
      await changed;
      assert.equal(changes, 1);
      state.served = [dmsModule];
    },
  );

  void it("calls back once the backend serves another set", async () => {
    state.served = [dmsModule];
    let changes = 0;
    const changed = new Promise<void>((resolve) => {
      followModuleSet({
        backendUrl: state.backendUrl,
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
    state.served = [dmsModule, langModule];
    await changed;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 1);
  });
}

function registerFollowTests(state: ModuleSetFixture): void {
  void it("ignores a set seen on one read only", async () => {
    state.served = [dmsModule];
    let changes = 0;
    const stop = followModuleSet({
      backendUrl: state.backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 50,
      onChange: () => (changes += 1),
    });
    state.served = [];
    await new Promise((resolve) => setTimeout(resolve, 75));
    state.served = [dmsModule];
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    assert.equal(changes, 0);
  });

  void it("waits while the backend says its set is settling", async () => {
    state.served = [];
    state.settling = true;
    let changes = 0;
    const stop = followModuleSet({
      backendUrl: state.backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 20,
      onChange: () => (changes += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    stop();
    state.settling = false;
    assert.equal(changes, 0);
  });

  void it("tells each unchanged read, so a restarted backend hears again", async () => {
    state.served = [dmsModule];
    let unchanged = 0;
    const stop = followModuleSet({
      backendUrl: state.backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 20,
      onChange: () => undefined,
      onUnchanged: () => (unchanged += 1),
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    assert.ok(unchanged >= 2);
  });

  void it("stops following when asked", async () => {
    state.served = [dmsModule];
    let changes = 0;
    const stop = followModuleSet({
      backendUrl: state.backendUrl,
      fingerprint: moduleSetFingerprint([dmsModule]),
      intervalMs: 20,
      onChange: () => (changes += 1),
    });
    stop();
    state.served = [dmsModule, langModule];
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(changes, 0);
  });
}

void describe("module set", () => {
  let server: Server;
  const state: ModuleSetFixture = {
    backendUrl: "",
    served: [dmsModule],
    settling: false,
    requests: [],
  };

  before(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        state.requests.push({
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
        response.end(
          JSON.stringify({
            ...manifestOf(state.served),
            settling: state.settling,
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    state.backendUrl = `http://127.0.0.1:${addressOf(server).port}`;
  });

  after(() => server.close());

  void it("ignores the order of modules but not their sources", () => {
    assert.equal(
      moduleSetFingerprint([dmsModule, langModule]),
      moduleSetFingerprint([langModule, dmsModule]),
    );
    assert.notEqual(
      moduleSetFingerprint([dmsModule]),
      moduleSetFingerprint([{ ...dmsModule, path: "/elsewhere" }]),
    );
  });

  void it("tells apart the endpoints and the backend proxies a module declares", () => {
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

  registerCallbackTests(state);

  registerFollowTests(state);

  void it("reports the served modules' versions and its own with the bootstrap credential", async () => {
    const isTaken = await reportFrontendReady(
      state.backendUrl,
      [{ name: dmsModule.name, version: "0.9.8" }, { name: "unversioned" }],
      "secret",
    );
    const report = state.requests.find((request) =>
      request.url?.startsWith("/dms/frontend/ready"),
    );
    assert.equal(isTaken, true);
    assert.equal(report?.method, "POST");
    assert.equal(report?.headers["x-dms-bootstrap"], "secret");
    assert.deepEqual(JSON.parse(report?.body ?? "{}"), {
      modules: [
        { name: dmsModule.name, version: "0.9.8" },
        { name: "unversioned" },
      ],
      version: OWN_PACKAGE.version,
    });
  });

  void it("does not fail when the backend cannot take the report", async () => {
    assert.equal(
      await reportFrontendReady("http://127.0.0.1:1", [{ name: "x" }]),
      false,
    );
  });
});

void describe("reporting to a backend that is waking", () => {
  const retry = { firstDelayMs: 10, maxDelayMs: 40, timeoutMs: 200 };
  let answers: ((response: import("node:http").ServerResponse) => void)[];
  let reports = 0;
  let server: Server;
  let backendUrl: string;

  before(async () => {
    server = createServer((_request, response) => {
      reports += 1;
      const answer = answers.shift();
      if (answer) {
        answer(response);
        return;
      }
      response.statusCode = 204;
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    backendUrl = `http://127.0.0.1:${addressOf(server).port}`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  void it("reports again until a backend that timed out, then was starting, takes it", async () => {
    reports = 0;
    answers = [
      (response) => setTimeout(() => response.end(), 500),
      (response) => {
        response.statusCode = 503;
        response.end("error.server_starting");
      },
    ];

    const isTaken = await reportFrontendReadyOnceAnswered(
      backendUrl,
      [{ name: dmsModule.name, version: "0.9.8" }],
      undefined,
      retry,
    );

    assert.equal(isTaken, true);
    assert.equal(reports, 3);
  });

  void it("does not report again to a backend that refused the report", async () => {
    reports = 0;
    answers = [
      (response) => {
        response.statusCode = 401;
        response.end();
      },
    ];

    const isTaken = await reportFrontendReadyOnceAnswered(
      backendUrl,
      [{ name: dmsModule.name }],
      undefined,
      retry,
    );

    assert.equal(isTaken, false);
    assert.equal(reports, 1);
  });
});

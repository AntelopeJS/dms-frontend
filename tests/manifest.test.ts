import * as assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { describe, it } from "node:test";
import {
  fetchManifest,
  type Manifest,
  ManifestUnauthorizedError,
} from "../src/common";

const manifest: Manifest = { pack: "/dms/frontend/modules", modules: [] };

interface FrontendManifest {
  version: number;
  archive: string;
  modules: Manifest["modules"];
}

const frontendManifest: FrontendManifest = {
  version: 1,
  archive: manifest.pack,
  modules: manifest.modules,
};

interface Backend {
  server: Server;
  baseUrl: string;
  requests: string[];
  headers: IncomingHttpHeaders[];
}

function startBackend(status = 200): Promise<Backend> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const headers: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      headers.push(req.headers);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(status === 200 ? frontendManifest : { error: "nope" }),
      );
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("No address");
      }
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        headers,
      });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("fetchManifest", () => {
  it("passes clientUrl as a query parameter", async () => {
    const { server, baseUrl, requests } = await startBackend();
    try {
      const result = await fetchManifest(baseUrl, "http://localhost:3002");
      assert.deepEqual(result, manifest);
      assert.equal(requests.length, 1);
      const url = new URL(requests[0], baseUrl);
      assert.equal(url.pathname, "/dms/frontend");
      assert.equal(url.searchParams.get("renderer"), "vue");
      assert.equal(url.searchParams.get("rendererVersion"), "3");
      assert.equal(url.searchParams.get("clientUrl"), "http://localhost:3002");
    } finally {
      await closeServer(server);
    }
  });

  it("omits clientUrl when not provided", async () => {
    const { server, baseUrl, requests } = await startBackend();
    try {
      await fetchManifest(baseUrl);
      assert.equal(requests[0], "/dms/frontend?renderer=vue&rendererVersion=3");
    } finally {
      await closeServer(server);
    }
  });

  it("requests and validates Vue manifests", async () => {
    const previousModules = frontendManifest.modules;
    frontendManifest.modules = [
      {
        name: "vue-module",
        archiveName: "vue-module",
        priority: 0,
        renderer: { name: "vue", version: "3" },
      },
    ];
    const { server, baseUrl, requests } = await startBackend();
    try {
      await fetchManifest(baseUrl);
      assert.equal(requests[0], "/dms/frontend?renderer=vue&rendererVersion=3");
    } finally {
      frontendManifest.modules = previousModules;
      await closeServer(server);
    }
  });

  it("does not fall back when the frontend endpoint is missing", async () => {
    const { server, baseUrl, requests } = await startBackend(404);
    try {
      await assert.rejects(() => fetchManifest(baseUrl), /dms\/frontend.*404/);
      assert.deepEqual(requests, [
        "/dms/frontend?renderer=vue&rendererVersion=3",
      ]);
    } finally {
      await closeServer(server);
    }
  });

  it("fails closed when the backend protocol version is unsupported", async () => {
    const previousVersion = frontendManifest.version;
    frontendManifest.version = 2;
    const { server, baseUrl } = await startBackend();
    try {
      await assert.rejects(
        () => fetchManifest(baseUrl),
        /Unsupported frontend manifest version: 2/,
      );
    } finally {
      frontendManifest.version = previousVersion;
      await closeServer(server);
    }
  });

  it("fails closed when the backend includes a mismatched renderer", async () => {
    const previousModules = frontendManifest.modules;
    frontendManifest.modules = [
      {
        name: "wrong",
        archiveName: "wrong",
        priority: 0,
        renderer: { name: "react", version: "19" },
      },
    ];
    const { server, baseUrl } = await startBackend();
    try {
      await assert.rejects(
        () => fetchManifest(baseUrl),
        /incompatible renderer/,
      );
    } finally {
      frontendManifest.modules = previousModules;
      await closeServer(server);
    }
  });

  it("presents the bootstrap credential when it has one", async () => {
    const { server, baseUrl, headers } = await startBackend();
    try {
      await fetchManifest(baseUrl, undefined, "the-secret");
      assert.equal(headers[0]["x-dms-bootstrap"], "the-secret");
    } finally {
      await closeServer(server);
    }
  });

  it("sends no credential header when it has none", async () => {
    const { server, baseUrl, headers } = await startBackend();
    try {
      await fetchManifest(baseUrl);
      assert.equal(headers[0]["x-dms-bootstrap"], undefined);
    } finally {
      await closeServer(server);
    }
  });

  it("reports a refused credential distinctly, naming the fix", async () => {
    const { server, baseUrl } = await startBackend(401);
    try {
      await assert.rejects(
        () => fetchManifest(baseUrl, undefined, "wrong"),
        (err: Error) => {
          assert.ok(err instanceof ManifestUnauthorizedError);
          assert.match(err.message, /DMS_BOOTSTRAP_SECRET/);
          return true;
        },
      );
    } finally {
      await closeServer(server);
    }
  });

  it("reports a forbidden response as a refused credential too", async () => {
    const { server, baseUrl } = await startBackend(403);
    try {
      await assert.rejects(
        () => fetchManifest(baseUrl),
        (err: Error) => err instanceof ManifestUnauthorizedError,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("keeps a backend outage a plain error, so the cache can absorb it", async () => {
    const { server, baseUrl } = await startBackend(500);
    try {
      await assert.rejects(
        () => fetchManifest(baseUrl),
        (err: Error) => !(err instanceof ManifestUnauthorizedError),
      );
    } finally {
      await closeServer(server);
    }
  });
});

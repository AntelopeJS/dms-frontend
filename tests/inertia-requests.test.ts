import * as assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addressOf } from "./helpers/net";
import { server } from "./fixtures/inertia";

describe("Inertia HTTP protocol", () => {
  it("does not write a second response after a client disconnect", async () => {
    const runtime = await server;
    let writeCount = 0;
    const response = {
      destroyed: false,
      headersSent: false,
      writableEnded: false,
      writeHead: () => {
        writeCount += 1;
      },
    };
    const disconnect = Object.assign(new Error("client disconnected"), {
      code: "ERR_STREAM_PREMATURE_CLOSE",
    });
    const request = {
      get url() {
        throw disconnect;
      },
    };
    await runtime.handleRequestSafely(request, response);
    assert.equal(writeCount, 0);

    response.headersSent = true;
    const invalidRequest = {
      get url() {
        throw new Error("response already started");
      },
    };
    await runtime.handleRequestSafely(invalidRequest, response);
    assert.equal(writeCount, 0);
  });

  it("releases the backend stream of a client that leaves before it answers", async () => {
    let backendClosed: () => void = () => {};
    const released = new Promise<void>((settle) => {
      backendClosed = settle;
    });
    const backend = createServer((request, response) => {
      request.socket.once("close", backendClosed);
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(": open\n\n");
      }, 100);
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = addressOf(frontend);
    try {
      await assert.rejects(
        fetch(`http://127.0.0.1:${frontendAddress.port}/api/feed`, {
          headers: { accept: "text/event-stream" },
          signal: AbortSignal.timeout(20),
        }),
      );
      const timeout = new Promise<string>((settle) =>
        setTimeout(() => settle("still open"), 2_000).unref(),
      );
      assert.equal(
        await Promise.race([released.then(() => "released"), timeout]),
        "released",
      );
    } finally {
      frontend.closeAllConnections();
      frontend.close();
      backend.closeAllConnections();
      backend.close();
    }
  });

  it("injects the SSR body without replacement-token expansion", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(join(process.cwd(), "templates", "vue", "server.mjs"), "utf8"),
    );
    assert.match(source, /renderer\.renderDmsPage\(/);
    assert.match(source, /\(\) => rendered\.body/);
    assert.doesNotMatch(source, /, rendered\.body\)/);
    assert.match(source, /falling back to client rendering/);
  });

  it("leaves the session, sign-in, e-mail render and tester paths to the modules and the backend", async () => {
    const reached: string[] = [];
    const backend = createServer((request, response) => {
      reached.push(`${request.method} ${request.url}`);
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"message":"error.page_not_found"}');
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(frontend);
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const [method, path] of [
        ["POST", "/api/_auth/session"],
        ["DELETE", "/api/_auth/session"],
        ["POST", "/api/html/render"],
        ["POST", "/api/_dms/tester"],
      ]) {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", origin: base },
          body: "{}",
        });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(reached.at(-1), `${method} ${path}`);
      }
      const signIn = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "{}",
      });
      assert.equal(signIn.status, 404);
      await signIn.body?.cancel();
      assert.equal(reached.at(-1), "POST /api/_dms/tester");
    } finally {
      frontend.close();
      backend.close();
    }
  });

  it("redirects signed-out protected visits while preserving public routes", async () => {
    const publicRoutes = new Map([
      ["/auth", { fullSlug: "/auth", publicAccess: true }],
      [
        "/privacy",
        { fullSlug: "/privacy", hasAccess: false, publicAccess: true },
      ],
    ]);
    const backend = createServer((request, response) => {
      const path = new URL(
        request.url ?? "/",
        "http://backend.local",
      ).searchParams.get("path");
      const route = publicRoutes.get(path ?? "") ?? {
        fullSlug: "/protected",
        hasAccess: false,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ route, layout: {}, shared: {} }));
    });
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    const runtime = await server;
    const frontend = createServer(runtime.handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend.listen(0, "127.0.0.1", resolve),
    );
    const frontendAddress = addressOf(frontend);
    const base = `http://127.0.0.1:${frontendAddress.port}`;
    try {
      const html = await fetch(`${base}/protected?tab=one`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      assert.equal(html.status, 302);
      assert.equal(
        html.headers.get("location"),
        "/auth?redirect=%2Fprotected%3Ftab%3Done",
      );
      const inertia = await fetch(`${base}/protected`, {
        headers: { "x-inertia": "true" },
        redirect: "manual",
      });
      assert.equal(inertia.status, 302);
      assert.equal(
        inertia.headers.get("location"),
        "/auth?redirect=%2Fprotected",
      );
      assert.equal(inertia.headers.get("vary"), "X-Inertia");
      const publicRoute = await fetch(`${base}/auth`, {
        headers: { "x-inertia": "true" },
      });
      assert.equal(publicRoute.status, 200);
      assert.equal(publicRoute.headers.get("x-inertia"), "true");
      const publicDeniedRoute = await fetch(`${base}/privacy`, {
        headers: { "x-inertia": "true" },
        redirect: "manual",
      });
      assert.equal(publicDeniedRoute.status, 200);
      assert.equal(publicDeniedRoute.headers.get("x-inertia"), "true");
    } finally {
      frontend.close();
      backend.close();
    }
  });
});

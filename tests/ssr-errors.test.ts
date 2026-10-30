import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { writeSsrErrorsWorkspace } from "./fixtures/ssr-errors-workspace";
import { addressOf } from "./helpers/net";

it("renders setup errors as HTTP errors without corrupting simultaneous successful SSR", async () => {
  const workspace = mkdtempSync(resolve(".ssr-errors-"));
  const previousBackend = process.env.DMS_API_BASE_URL;
  const previousSecret = process.env.DMS_SESSION_SECRET;
  const unreadCountPath = "/settings/user/notifications/unread-count";
  const backendReads: string[] = [];
  const backend = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    backendReads.push(`${url.pathname}${url.search}`);
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/fixture/counted") {
      const count = backendReads.filter((read) => read === "/fixture/counted");
      response.end(JSON.stringify({ count: count.length }));
      return;
    }
    if (url.pathname === unreadCountPath) {
      response.end('{"unreadCount":7}');
      return;
    }
    const path = url.searchParams.get("path");
    if (path === null) {
      response.statusCode = 404;
      response.end('{"message":"Not found"}');
      return;
    }
    if (path === "/suspended") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("fixture.errors.access_blocked");
      return;
    }
    if (path === "/broken") response.statusCode = 503;
    response.end(JSON.stringify({ componentName: path.slice(1) }));
  });
  let frontend: ReturnType<typeof createServer> | undefined;
  try {
    writeSsrErrorsWorkspace(workspace, unreadCountPath);
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = addressOf(backend);
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const { handleRequestSafely } = await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    );
    frontend = createServer(handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend!.listen(0, "127.0.0.1", resolve),
    );
    const address = addressOf(frontend);
    const base = `http://127.0.0.1:${address.port}`;
    const [failed, healthy] = await Promise.all([
      fetch(`${base}/throws`, { headers: { accept: "text/html" } }),
      fetch(`${base}/healthy`, { headers: { accept: "text/html" } }),
    ]);
    assert.equal(failed.status, 400);
    const failedHtml = await failed.text();
    assert.match(failedHtml, /400: Missing required token parameter/);
    assert.doesNotMatch(failedHtml, /WRONG PAGE/);
    assert.equal(healthy.status, 200);
    const healthyHtml = await healthy.text();
    assert.match(healthyHtml, /Healthy request/);
    assert.doesNotMatch(healthyHtml, /Missing required token parameter/);
    const initialRoute = await fetch(
      `${base}/initial-route?tab=public#details`,
      { headers: { accept: "text/html" } },
    );
    assert.equal(initialRoute.status, 200);
    assert.match(
      await initialRoute.text(),
      /Initial route:\/initial-route\?tab=public/,
    );
    const [redirectA, redirectB, isolatedHealthy] = await Promise.all([
      fetch(`${base}/requires-onboarding-a`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
      fetch(`${base}/requires-onboarding-b`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
      fetch(`${base}/healthy`, { headers: { accept: "text/html" } }),
    ]);
    assert.equal(redirectA.status, 302);
    assert.equal(redirectA.headers.get("location"), "/onboarding?source=a");
    assert.equal(redirectB.status, 302);
    assert.equal(redirectB.headers.get("location"), "/onboarding?source=b");
    assert.equal(isolatedHealthy.status, 200);
    assert.match(await isolatedHealthy.text(), /Healthy request/);
    for (const [path, location] of [
      ["/slow-guard-redirect", "/onboarding?source=guard"],
      ["/slow-guard-page-redirect", "/onboarding?source=page"],
      ["/slow-guard-both", "/onboarding?source=guard"],
    ]) {
      const response = await fetch(`${base}${path}`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      });
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get("location"), location, path);
    }
    const [guardNotFound, guardBroken, guardRedirect] = await Promise.all(
      ["/guard-not-found", "/guard-broken", "/guard-redirect"].map((path) =>
        fetch(`${base}${path}`, {
          headers: { accept: "text/html" },
          redirect: "manual",
        }),
      ),
    );
    assert.equal(guardNotFound.status, 404);
    const guardNotFoundHtml = await guardNotFound.text();
    assert.match(
      guardNotFoundHtml,
      /<main id="error"[^>]*>404: Module not found \/ Module not found<\/main>/,
    );
    assert.doesNotMatch(guardNotFoundHtml, /Guarded content/);
    assert.equal(guardBroken.status, 500);
    const guardBrokenHtml = await guardBroken.text();
    assert.match(
      guardBrokenHtml,
      /<main id="error"[^>]*>500: no message \/ no status message<\/main>/,
    );
    assert.doesNotMatch(
      guardBrokenHtml,
      /Guarded content|private middleware detail/,
    );
    assert.equal(guardRedirect.status, 302);
    assert.equal(
      guardRedirect.headers.get("location"),
      "/onboarding?source=guard",
    );
    backendReads.length = 0;
    const filled = await fetch(`${base}/fill-query`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(filled.status, 200);
    assert.equal(
      filled.headers.get("content-location"),
      "/fill-query?workspace=default",
    );
    const filledHtml = await filled.text();
    assert.match(filledHtml, /Fill:default:1/);
    assert.match(filledHtml, /\/fill-query\?workspace=default/);
    assert.deepEqual(
      backendReads.filter((read) => read.startsWith("/fixture/")),
      ["/fixture/counted"],
    );
    assert.deepEqual(
      backendReads.filter((read) => read.startsWith("/dms/page")),
      [
        "/dms/page?path=%2Ffill-query",
        "/dms/page?path=%2Ffill-query&workspace=default&shared=false",
      ],
    );
    const looping = await fetch(`${base}/fill-query?loop=0`, {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    assert.equal(looping.status, 302);
    assert.equal(looping.headers.get("location"), "/fill-query?loop=3");
    const asyncRuntimeResponses = await Promise.all([
      fetch(`${base}/async-runtime-a`, { headers: { accept: "text/html" } }),
      fetch(`${base}/async-runtime-b`, { headers: { accept: "text/html" } }),
    ]);
    const asyncRuntimeHtml = await Promise.all(
      asyncRuntimeResponses.map((response) => response.text()),
    );
    assert.match(asyncRuntimeHtml[0], /Async runtime A:\/async-runtime-a/);
    assert.doesNotMatch(asyncRuntimeHtml[0], /Async runtime B/);
    assert.match(asyncRuntimeHtml[1], /Async runtime B:\/async-runtime-b/);
    assert.doesNotMatch(asyncRuntimeHtml[1], /Async runtime A/);
    const unexpected = await fetch(`${base}/async-throws`, {
      headers: { accept: "text/html" },
    });
    assert.equal(unexpected.status, 500);
    const unexpectedHtml = await unexpected.text();
    assert.match(unexpectedHtml, /500: no message \/ no status message/);
    assert.doesNotMatch(unexpectedHtml, /private database hostname/);
    const fetchNotFound = await fetch(`${base}/fetch-not-found`, {
      headers: { accept: "text/html" },
    });
    assert.equal(fetchNotFound.status, 404);
    const fetchNotFoundHtml = await fetchNotFound.text();
    assert.match(fetchNotFoundHtml, /404: Not Found \/ Not Found/);
    assert.doesNotMatch(fetchNotFoundHtml, /10\.0\.0\.5|api\/secret/);
    const exact = await fetch(`${base}/exact`, {
      headers: { accept: "text/html" },
    });
    assert.equal(exact.status, 200);
    const exactHtml = await exact.text();
    assert.match(exactHtml, /Exact registered page:true:catch-all:0/);
    assert.doesNotMatch(exactHtml, /Registered catch-all page/);
    const catchAll = await fetch(`${base}/unregistered`, {
      headers: { accept: "text/html" },
    });
    assert.equal(catchAll.status, 200);
    assert.match(await catchAll.text(), /Registered catch-all page:true/);
    const [onboardingDocument, nestedDocument, unreadCount] = await Promise.all(
      [
        fetch(`${base}/onboarding`),
        fetch(`${base}/modules/parity/nested`),
        fetch(`${base}${unreadCountPath}`),
      ],
    );
    const productionHtml = await Promise.all(
      [onboardingDocument, nestedDocument].map(async (response) => {
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        return response.text();
      }),
    );
    assert.match(productionHtml[0], /Onboarding/);
    assert.match(productionHtml[1], /Registered catch-all page:true/);
    assert.equal(unreadCount.status, 200);
    assert.deepEqual(await unreadCount.json(), { unreadCount: 7 });
    process.env.DMS_SESSION_SECRET =
      "disposable-ssr-session-secret-at-least-32";
    const { writeSession } = await import(
      pathToFileURL(join(workspace, "server/auth/session.mjs")).href
    );
    const sessionCookie = (id: string, language: string) => {
      let cookie = "";
      writeSession(
        {
          getHeader: () => undefined,
          setHeader: (_name: string, value: string) => {
            cookie = value.split(";")[0];
          },
        },
        {
          user: { _id: id, language },
          accountId: `account-${id}`,
          activeTenantId: `tenant-${id}`,
          accessToken: "private-access-token",
          refreshToken: "private-refresh-token",
        },
      );
      return cookie;
    };
    const sessions = await Promise.all([
      fetch(`${base}/session`, {
        headers: { accept: "text/html", cookie: sessionCookie("alice", "fr") },
      }),
      fetch(`${base}/session`, {
        headers: { accept: "text/html", cookie: sessionCookie("bob", "en") },
      }),
      fetch(`${base}/session`, { headers: { accept: "text/html" } }),
    ]);
    for (const [index, [expected, locale]] of [
      ["alice:fr:alice", "fr"],
      ["bob:en:bob", "en"],
      ["anonymous:en:anonymous", "en"],
    ].entries()) {
      assert.equal(sessions[index].status, 200);
      const html = await sessions[index].text();
      assert.ok(
        html.includes(expected),
        `Session and locale must exist before plugin setup: ${expected}`,
      );
      assert.match(html, new RegExp(`lang="${locale}"`));
      assert.doesNotMatch(html, /private-access-token|private-refresh-token/);
    }
    const inertiaSession = await fetch(`${base}/session`, {
      headers: {
        cookie: sessionCookie("alice", "fr"),
        "x-inertia": "true",
      },
    });
    assert.deepEqual((await inertiaSession.json()).props, {
      path: "/session",
      page: { componentName: "session" },
      user: { _id: "alice", language: "fr" },
      session: {
        accountId: "account-alice",
        activeTenantId: "tenant-alice",
      },
      errors: {},
    });
    const failedSession = await fetch(`${base}/broken`, {
      headers: {
        cookie: sessionCookie("bob", "en"),
        "x-inertia": "true",
      },
    });
    assert.equal(failedSession.status, 503);
    const failedSessionBody = await failedSession.text();
    assert.match(failedSessionBody, /account-bob|tenant-bob/);
    assert.equal(
      JSON.stringify(JSON.parse(failedSessionBody).props.error),
      '{"statusCode":503}',
    );
    assert.doesNotMatch(failedSessionBody, /DMS backend request failed/);
    assert.doesNotMatch(
      failedSessionBody,
      /private-access-token|private-refresh-token/,
    );
    for (const headers of [{ accept: "text/html" }, { "x-inertia": "true" }]) {
      const suspended = await fetch(`${base}/suspended`, {
        headers: { ...headers, cookie: sessionCookie("bob", "en") },
        redirect: "manual",
      });
      assert.equal(suspended.status, 302);
      assert.equal(suspended.headers.get("location"), "/blocked-screen");
    }
  } finally {
    frontend?.close();
    backend.close();
    if (previousBackend === undefined) delete process.env.DMS_API_BASE_URL;
    else process.env.DMS_API_BASE_URL = previousBackend;
    if (previousSecret === undefined) delete process.env.DMS_SESSION_SECRET;
    else process.env.DMS_SESSION_SECRET = previousSecret;
    rmSync(workspace, { recursive: true, force: true });
  }
});

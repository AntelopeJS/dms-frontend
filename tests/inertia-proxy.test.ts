import * as assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { addressOf } from "./helpers/net";
import { isText } from "./helpers/guards";
import {
  server,
  writeSsrRendererFixture,
  sessionCookie,
} from "./fixtures/inertia";

describe("proxied mutations", () => {
  it("protects proxied mutations and preserves backend validation errors", async () => {
    const backend = createServer((_request, response) => {
      response.writeHead(422, {
        "content-type": "application/json",
        "x-validation-source": "dms",
      });
      response.end(
        '{"message":"Validation failed","errors":{"name":"Required"}}',
      );
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
      const rejected = await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: "{}",
      });
      assert.equal(rejected.status, 403);
      assert.deepEqual(await rejected.json(), {
        error: "Forbidden",
        reason: "missing or untrusted Origin header",
      });

      const relayed = await fetch(`${base}/api/items`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "{}",
      });
      assert.equal(relayed.status, 422);
      assert.equal(relayed.headers.get("x-validation-source"), "dms");
      assert.deepEqual(await relayed.json(), {
        message: "Validation failed",
        errors: { name: "Required" },
      });
    } finally {
      frontend.close();
      backend.close();
    }
  });
});

describe("public endpoints through the proxy", () => {
  it("lets a declared public route through anonymously, with its headers", async () => {
    process.env.DMS_SESSION_SECRET =
      "test-secret-with-at-least-thirty-two-characters";
    process.env.DMS_PUBLIC_ENDPOINTS = JSON.stringify([
      { path: "/api/hooks/*", headers: ["x-hook-secret"] },
    ]);
    const jwt = `x.${Buffer.from('{"tenantId":"tenant-1"}').toString("base64url")}.x`;
    const seen: Record<string, string | undefined>[] = [];
    const backend = createServer((request, response) => {
      seen.push({
        url: request.url,
        authorization: request.headers.authorization,
        secret: request.headers["x-hook-secret"] as string | undefined,
        other: request.headers["x-other"] as string | undefined,
        ifMatch: request.headers["if-match"],
      });
      response.writeHead(202, { "content-type": "application/json" });
      response.end("{}");
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
      const cookie = await sessionCookie({
        accessToken: jwt,
        refreshToken: "refresh-1",
        user: { id: "user-1" },
      });

      const hook = await fetch(`${base}/api/hooks/resend?tenant=acme`, {
        method: "POST",
        headers: {
          cookie,
          origin: "https://evil.example",
          "x-hook-secret": "s3cret",
          "x-other": "dropped",
        },
        body: "{}",
      });
      assert.equal(hook.status, 202);
      assert.deepEqual(seen.at(-1), {
        url: "/api/hooks/resend?tenant=acme",
        authorization: undefined,
        secret: "s3cret",
        other: undefined,
        ifMatch: undefined,
      });

      const deeper = await fetch(`${base}/api/hooks/resend/more`, {
        method: "POST",
        body: "{}",
      });
      assert.equal(deeper.status, 403);

      const owned = await fetch(`${base}/api/items`, {
        method: "PUT",
        headers: {
          cookie,
          origin: base,
          "if-match": '"7"',
          "x-hook-secret": "not-relayed",
        },
        body: "{}",
      });
      assert.equal(owned.status, 202);
      assert.deepEqual(seen.at(-1), {
        url: "/api/items",
        authorization: `Bearer ${jwt}`,
        secret: undefined,
        other: undefined,
        ifMatch: '"7"',
      });
    } finally {
      delete process.env.DMS_PUBLIC_ENDPOINTS;
      frontend.close();
      backend.close();
    }
  });
});

interface PagePropsTemplate {
  sharedOnceKey: (session?: Record<string, unknown>) => string;
  SHARED_PROP_TTL_MS: number;
}

const pagePropsModule = import(
  join(process.cwd(), "templates", "vue", "server", "page-props.mjs")
) as Promise<PagePropsTemplate>;

describe("Site layout as an Inertia once prop", () => {
  const PAGE = { route: { fullSlug: "/articles" }, layout: { id: "layout" } };
  const SHARED = { siteLayout: { pages: {} }, isOwner: true };
  const FRESH_SHARED = { siteLayout: { pages: {} }, isOwner: false };

  async function frontendWithBackend() {
    const backendCalls: string[] = [];
    const backend = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://backend.local");
      backendCalls.push(`${url.pathname}${url.search}`);
      if (url.pathname === "/dms/sitelayout") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(FRESH_SHARED));
        return;
      }
      if (url.searchParams.get("path") === "/auth/custom") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end('{"message":"error.page_not_found"}');
        return;
      }
      const omitShared = url.searchParams.get("shared") === "false";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(omitShared ? PAGE : { ...PAGE, shared: SHARED }),
      );
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
    const visit = async (
      path: string,
      headers: Record<string, string> = {},
    ) => {
      backendCalls.length = 0;
      const response = await fetch(`${base}${path}`, {
        headers: { "x-inertia": "true", ...headers },
        redirect: "manual",
      });
      const page = (await response.json()) as {
        props: Record<string, unknown>;
        onceProps?: Record<string, { prop: string; expiresAt: number | null }>;
      };
      return { page, backendCalls: [...backendCalls] };
    };
    const close = () => {
      frontend.close();
      backend.close();
    };
    return { visit, close };
  }

  function accountCookie(accountId: string): Promise<string> {
    return sessionCookie({
      accessToken: "access",
      accountId,
      activeTenantId: "tenant-1",
      user: { id: accountId },
    });
  }

  it("sends the site layout once per session, then the page alone", async () => {
    const { sharedOnceKey, SHARED_PROP_TTL_MS } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    const anonymous = sharedOnceKey(undefined);
    try {
      const before = Date.now();
      const first = await visit("/articles");
      assert.deepEqual(first.backendCalls, ["/dms/page?path=%2Farticles"]);
      assert.deepEqual(first.page.props.shared, SHARED);
      assert.deepEqual(first.page.props.page, PAGE);
      assert.deepEqual(Object.keys(first.page.onceProps ?? {}), [anonymous]);
      const declared = first.page.onceProps?.[anonymous];
      assert.equal(declared?.prop, "shared");
      assert.ok(
        (declared?.expiresAt ?? 0) >= before + SHARED_PROP_TTL_MS &&
          (declared?.expiresAt ?? 0) <= Date.now() + SHARED_PROP_TTL_MS,
      );

      const next = await visit("/articles", {
        "x-inertia-except-once-props": anonymous,
      });
      assert.deepEqual(next.backendCalls, [
        "/dms/page?path=%2Farticles&shared=false",
      ]);
      assert.equal("shared" in next.page.props, false);
      assert.deepEqual(next.page.props.page, PAGE);
      assert.deepEqual(next.page.onceProps, {
        [anonymous]: { prop: "shared", expiresAt: null },
      });

      const cookie = await accountCookie("account-a");
      const signedIn = await visit("/articles", {
        cookie,
        "x-inertia-except-once-props": anonymous,
      });
      assert.deepEqual(signedIn.backendCalls, ["/dms/page?path=%2Farticles"]);
      assert.deepEqual(signedIn.page.props.shared, SHARED);
      const accountKey = sharedOnceKey({
        accountId: "account-a",
        activeTenantId: "tenant-1",
      });
      assert.notEqual(accountKey, anonymous);
      assert.deepEqual(Object.keys(signedIn.page.onceProps ?? {}), [
        accountKey,
      ]);
      const held = await visit("/articles", {
        cookie,
        "x-inertia-except-once-props": accountKey,
      });
      assert.deepEqual(held.backendCalls, [
        "/dms/page?path=%2Farticles&shared=false",
      ]);
      const mixed = await visit("/articles", {
        cookie,
        "x-inertia-except-once-props": `${anonymous},${accountKey}`,
      });
      assert.deepEqual(mixed.backendCalls, ["/dms/page?path=%2Farticles"]);
      assert.deepEqual(mixed.page.props.shared, SHARED);
      assert.deepEqual(Object.keys(mixed.page.onceProps ?? {}), [accountKey]);
      assert.equal(
        sharedOnceKey({
          accountId: "account-a",
          activeTenantId: "tenant-2",
        }) === accountKey,
        false,
      );
    } finally {
      close();
    }
  });

  it("answers a partial reload with the props it names", async () => {
    const { sharedOnceKey } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    const held = sharedOnceKey(undefined);
    const partial = (data: string, extra: Record<string, string> = {}) =>
      visit("/articles?tab=b", {
        "x-inertia-partial-component": "DmsDynamicPage",
        "x-inertia-partial-data": data,
        ...extra,
      });
    try {
      const shared = await partial("shared", {
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(shared.backendCalls, ["/dms/sitelayout"]);
      assert.deepEqual(Object.keys(shared.page.props).sort(), [
        "errors",
        "shared",
      ]);
      assert.deepEqual(shared.page.props.shared, FRESH_SHARED);
      assert.notEqual(shared.page.onceProps?.[held]?.expiresAt, null);

      const page = await partial("page.layout", {
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(page.backendCalls, [
        "/dms/page?path=%2Farticles&tab=b&shared=false",
      ]);
      assert.deepEqual(Object.keys(page.page.props).sort(), ["errors", "page"]);

      const session = await partial("user,session", {
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(session.backendCalls, []);
      assert.deepEqual(session.page.props, {
        user: null,
        session: null,
        errors: {},
      });

      const stale = await partial("page");
      assert.deepEqual(stale.backendCalls, [
        "/dms/page?path=%2Farticles&tab=b",
      ]);
      assert.deepEqual(stale.page.props.shared, SHARED);

      const excepted = await visit("/articles", {
        "x-inertia-partial-component": "DmsDynamicPage",
        "x-inertia-partial-except": "page",
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(excepted.backendCalls, ["/dms/sitelayout"]);
      assert.equal("page" in excepted.page.props, false);

      const other = await visit("/articles", {
        "x-inertia-partial-component": "Other",
        "x-inertia-partial-data": "shared",
        "x-inertia-except-once-props": held,
      });
      assert.deepEqual(other.backendCalls, [
        "/dms/page?path=%2Farticles&shared=false",
      ]);
      assert.ok(isText(other.page.props.path));
    } finally {
      close();
    }
  });

  it("asks the backend for the page with the query of the visit", async () => {
    const { sharedOnceKey } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    try {
      const first = await visit(
        "/articles?workspace=web&locale=fr&locale=de&path=%2Fother",
      );
      assert.deepEqual(first.backendCalls, [
        "/dms/page?path=%2Farticles&workspace=web&locale=de",
      ]);
      const next = await visit("/articles?workspace=web&shared=true", {
        "x-inertia-except-once-props": sharedOnceKey(undefined),
      });
      assert.deepEqual(next.backendCalls, [
        "/dms/page?path=%2Farticles&workspace=web&shared=false",
      ]);
    } finally {
      close();
    }
  });

  it("keeps the layout over a frontend-only page only when the browser holds it", async () => {
    await writeSsrRendererFixture();
    const { sharedOnceKey } = await pagePropsModule;
    const { visit, close } = await frontendWithBackend();
    const held = sharedOnceKey(undefined);
    try {
      const holding = await visit("/auth/custom", {
        "x-inertia-except-once-props": held,
      });
      assert.equal(
        (holding.page.props.page as { isFrontendOnly?: boolean })
          .isFrontendOnly,
        true,
      );
      assert.deepEqual(holding.page.onceProps, {
        [held]: { prop: "shared", expiresAt: null },
      });
      const bare = await visit("/auth/custom");
      assert.equal("shared" in bare.page.props, false);
      assert.equal(bare.page.onceProps, undefined);
    } finally {
      close();
      await rm(join(process.cwd(), "templates", "vue", "dist"), {
        force: true,
        recursive: true,
      });
    }
  });
});

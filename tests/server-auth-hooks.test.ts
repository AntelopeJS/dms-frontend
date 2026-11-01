import * as assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import {
  copyStaticTemplates,
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../src/common";
import { serverAuth } from "../templates/vue/server/auth-hooks.mjs";
import { resolveServerDeclarations } from "../templates/vue/server/module-routes.mjs";
import type {
  DmsServerSetup,
  DmsSession,
} from "../templates/vue/server-module";
import { addressOf } from "./helpers/net";
import { isNumber, isText } from "./helpers/guards";
import { requestOf, responseOf } from "./helpers/http-doubles";
import { jsonAt, responseJson } from "./helpers/json";
import { requestHandlerOf } from "./helpers/workspace-server";

const SESSION_SECRET = "a-test-only-session-secret-of-32-characters";
const ACCOUNT_ID = "0b5e7c2a-4d1f-4a8e-9c3b-2f6d8e1a7b40";

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function resolved(
  declarations: { id: string; priority?: number; setup: DmsServerSetup }[],
) {
  const warnings: string[] = [];
  const modules = resolveServerDeclarations(declarations, (message: string) =>
    warnings.push(message),
  );
  return { modules, warnings };
}

describe("Auth hook declarations", () => {
  it("come from the highest-priority module that registers them, and another one is reported", () => {
    const refreshSession = async () => undefined;
    const { modules, warnings } = resolved([
      {
        id: "low",
        priority: 1,
        setup: (s) => s.registerAuth({ signInPath: "/other" }),
      },
      {
        id: "dms",
        priority: 5,
        setup: (s) => s.registerAuth({ signInPath: "/auth", refreshSession }),
      },
    ]);
    assert.equal(modules.auth.id, "dms");
    assert.equal(modules.auth.refreshSession, refreshSession);
    assert.deepEqual(warnings, [
      "Frontend module low registers auth hooks, which are ignored: dms (priority 5) provides them.",
    ]);
  });

  it("are ignored whole when malformed, with a warning", () => {
    const { modules, warnings } = resolved([
      {
        id: "dms",
        setup: (s) => s.registerAuth({ signInExempt: ["auth/**"] }),
      },
      {
        id: "saas",
        // @ts-expect-error refreshSession is the string "no", an off-contract hook that must make the whole auth declaration ignored with a warning
        setup: (s) => s.registerAuth({ refreshSession: "no" }),
      },
    ]);
    assert.equal(modules.auth, undefined);
    assert.match(
      warnings[0],
      /^Frontend module dms registers auth hooks, which are ignored: signInExempt/,
    );
    assert.match(warnings[1], /refreshSession is not a function/);
  });

  it("leave pages without a session where no module registers them", () => {
    const auth = serverAuth(undefined, () => ({}));
    assert.equal(auth.signInPath, "/auth");
    assert.equal(auth.signInLocation("/x?y=1"), "/auth?redirect=%2Fx%3Fy%3D1");
    assert.equal(auth.isSignInExempt("/auth/2fa"), true);
    assert.equal(auth.isSignInExempt("/onboarding"), true);
    assert.equal(auth.isSignInExempt("/dashboard"), false);
    assert.equal(auth.isSignInExempt("/auth"), true);
    assert.equal(auth.isSignInExempt("/authors"), false);
    assert.equal(auth.isSignInExempt("/auth-callback"), false);
    assert.deepEqual(
      auth.view({
        user: { name: "Ada" },
        accountId: "a",
        activeTenantId: "t",
        updatedAt: 7,
        accessToken: "secret",
      }),
      {},
    );
  });

  it("renew no session where no module registers them", async () => {
    const auth = serverAuth(undefined, () => ({}));
    assert.equal(await auth.refresh({ headers: {} }, {}), undefined);
  });

  it("exempt the provider's sign-in path when it names no exempt pages", () => {
    const { modules } = resolved([
      { id: "dms", setup: (s) => s.registerAuth({ signInPath: "/login" }) },
    ]);
    const auth = serverAuth(modules.auth, () => ({}));
    assert.equal(auth.signInLocation("/x"), "/login?redirect=%2Fx");
    assert.equal(auth.isSignInExempt("/login"), true);
    assert.equal(auth.isSignInExempt("/login/"), true);
    assert.equal(auth.isSignInExempt("/login/reset"), true);
    assert.equal(auth.isSignInExempt("/onboarding"), true);
    assert.equal(auth.isSignInExempt("/logins"), false);
    assert.equal(auth.isSignInExempt("/auth"), false);
    assert.equal(auth.isSignInExempt("/dashboard"), false);
  });

  it("use the provider's, the server adding the session stamp", () => {
    const { modules } = resolved([
      {
        id: "dms",
        setup: (s) =>
          s.registerAuth({
            signInPath: "/login",
            signInExempt: ["/login/**", "/welcome"],
            publicSession: (session) => ({
              user: session.user,
              session: { accountId: session.accountId },
            }),
          }),
      },
    ]);
    const auth = serverAuth(modules.auth, () => ({}));
    assert.equal(auth.provider, "dms");
    assert.equal(auth.signInLocation("/x"), "/login?redirect=%2Fx");
    assert.equal(auth.isSignInExempt("/login"), true);
    assert.equal(auth.isSignInExempt("/login/reset"), true);
    assert.equal(auth.isSignInExempt("/welcome/x"), false);
    assert.equal(auth.isSignInExempt("/auth"), false);
    assert.deepEqual(
      auth.view({
        user: { name: "Ada" },
        accountId: "a",
        updatedAt: 9,
        accessToken: "secret",
      }),
      { user: { name: "Ada" }, session: { accountId: "a", updatedAt: 9 } },
    );
    assert.deepEqual(auth.view(undefined), {});
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const address = addressOf(server);
  return `http://127.0.0.1:${address.port}`;
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((settle) => {
    if (!server?.listening) return settle();
    server.closeAllConnections();
    server.close(() => settle());
  });
}

const FIXTURE_ENTRY = `
import { defineDmsServer } from "#dms/server";

export default defineDmsServer((server) => {
  server.registerAuth({
    signInPath: "/login",
    signInExempt: ["/login/**"],
    async refreshSession(event, session) {
      const renewed = { ...session, accessToken: "renewed-" + event.module.id };
      event.session.write(renewed);
      return renewed;
    },
    publicSession: (session) => ({
      user: { ...session.user, viaHook: true },
      session: { accountId: session.accountId },
    }),
  });
  server.registerRoute("GET", "/api/_fixture/session", (event) => ({
    read: event.session.read(),
    view: event.session.view(),
    account: event.cookies.readSealed("dms_account_${ACCOUNT_ID.replaceAll("-", "")}"),
  }));
  server.registerRoute("POST", "/api/_fixture/session", (event) => {
    event.session.write({ accessToken: "from-module", persistent: false, user: { name: "Grace" } });
    return null;
  });
});
`;

interface SessionTemplate {
  writeSession(response: ServerResponse, session: Partial<DmsSession>): void;
  writeSealedCookie(
    response: ServerResponse,
    name: string,
    value: Record<string, string>,
  ): void;
  readSession(request: IncomingMessage): DmsSession | undefined;
}

function setCookies(response: ServerResponse): string[] {
  const header = response.getHeader("set-cookie");
  return (Array.isArray(header) ? header : [header]).filter(isText);
}

function cookiePairs(response: ServerResponse): string[] {
  return setCookies(response).map((cookie) => cookie.split(";", 1)[0]);
}

describe("Auth hooks in the production server", () => {
  const workspace = realpathSync(mkdtempSync(resolve(".server-auth-hooks-")));
  const source = mkdtempSync(join(tmpdir(), "dms-auth-fixture-"));
  let backend: Server | undefined;
  let frontend: Server | undefined;
  let frontendUrl = "";
  let sessions: SessionTemplate;
  const environment = {
    DMS_API_BASE_URL: process.env.DMS_API_BASE_URL,
    DMS_SESSION_SECRET: process.env.DMS_SESSION_SECRET,
    DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE,
  };

  before(async () => {
    backend = createServer((request, response) => {
      const authorization = request.headers.authorization ?? "";
      const signedIn = authorization.startsWith("Bearer renewed-");
      response.writeHead(signedIn ? 200 : 401, {
        "content-type": "application/json",
      });
      response.end(
        signedIn
          ? JSON.stringify({ route: { hasAccess: true }, layout: {} })
          : '{"message":"error.401"}',
      );
    });
    process.env.DMS_API_BASE_URL = await listen(backend);
    process.env.DMS_SESSION_SECRET = SESSION_SECRET;
    process.env.DMS_COOKIE_SECURE = "false";

    writeFixture(source, "dms.server.ts", FIXTURE_ENTRY);
    copyStaticTemplates(workspace);
    writeFixture(workspace, "package.json", '{"type":"module"}');
    const layers = [{ path: source, packageName: "@acme/auth-frontend" }];
    const registry = createFrontendModuleRegistry(workspace, layers);
    cpSync(source, registry.modules[0].root, { recursive: true });
    writeFrontendModuleRegistry(workspace, layers);
    const { build } = await import("vite");
    await build({
      configFile: join(workspace, "vite.server.config.ts"),
      root: workspace,
      logLevel: "silent",
    });
    sessions = (await import(
      pathToFileURL(join(workspace, "server", "auth", "session.mjs")).href
    )) as SessionTemplate;
    frontend = createServer(await requestHandlerOf(workspace));
    frontendUrl = await listen(frontend);
  });

  after(async () => {
    await close(frontend);
    await close(backend);
    for (const [name, value] of Object.entries(environment))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  const visit = (path: string, cookie?: string) => {
    const headers = cookie
      ? { "x-inertia": "true", cookie }
      : { "x-inertia": "true" };
    return fetch(`${frontendUrl}${path}`, { redirect: "manual", headers });
  };

  it("sends a signed-out visit the backend refuses to the provider's sign-in page", async () => {
    const response = await visit("/private?tab=1");
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      "/login?redirect=%2Fprivate%3Ftab%3D1",
    );
  });

  it("leaves the provider's exempt pages to the error page", async () => {
    const response = await visit("/login/reset");
    assert.equal(response.status, 401);
    assert.equal((await response.json()).props.error.statusCode, 401);
  });

  it("renews a refused session through the provider's hook and retries the visit with it", async () => {
    const jar = responseOf();
    sessions.writeSession(jar, {
      accessToken: "expired",
      refreshToken: "refresh",
      accountId: "account-1",
      activeTenantId: "default",
      user: { name: "Ada", language: "fr" },
    });
    const response = await visit("/private", cookiePairs(jar)[0]);
    assert.equal(response.status, 200);
    const page = await responseJson(response);
    assert.deepEqual(jsonAt(page, "props", "user"), {
      name: "Ada",
      language: "fr",
      viaHook: true,
    });
    assert.equal(jsonAt(page, "props", "session", "accountId"), "account-1");
    assert.ok(isNumber(jsonAt(page, "props", "session", "updatedAt")));
    const [cookie] = response.headers.getSetCookie();
    const renewed = sessions.readSession(
      requestOf({ headers: { cookie: cookie.split(";", 1)[0] } }),
    );
    assert.equal(renewed?.accessToken, "renewed-acme__auth-frontend");
    assert.equal(
      renewed?.updatedAt,
      jsonAt(page, "props", "session", "updatedAt"),
    );
  });

  it("hands the module owning sign-in the session and its own dms_* cookies", async () => {
    const jar = responseOf();
    const session = {
      accessToken: "a",
      refreshToken: "r",
      accountId: ACCOUNT_ID,
      user: { _id: "u1", name: "Ada" },
    };
    sessions.writeSession(jar, session);
    sessions.writeSealedCookie(
      jar,
      `dms_account_${ACCOUNT_ID.replaceAll("-", "")}`,
      { refreshToken: "r", accountId: ACCOUNT_ID },
    );
    const response = await fetch(`${frontendUrl}/api/_fixture/session`, {
      headers: { cookie: cookiePairs(jar).join("; ") },
    });
    const body = await responseJson(response);
    assert.equal(jsonAt(body, "read", "accessToken"), "a");
    assert.deepEqual(jsonAt(body, "view", "user"), {
      _id: "u1",
      name: "Ada",
      viaHook: true,
    });
    assert.equal(jsonAt(body, "account", "refreshToken"), "r");
    assert.equal(jsonAt(body, "account", "accountId"), ACCOUNT_ID);
  });

  it("keeps only a session written persistent for 30 days", () => {
    const persistent = responseOf();
    const session = responseOf();
    sessions.writeSession(persistent, { accessToken: "a", persistent: true });
    sessions.writeSession(session, { accessToken: "b" });
    assert.match(setCookies(persistent)[0] ?? "", /; Max-Age=2592000/);
    assert.doesNotMatch(setCookies(session)[0] ?? "", /Max-Age/);
  });

  it("writes the session cookie, ending with the browser when not persistent", async () => {
    const response = await fetch(`${frontendUrl}/api/_fixture/session`, {
      method: "POST",
      headers: { origin: frontendUrl },
    });
    assert.equal(response.status, 204);
    const [cookie] = response.headers.getSetCookie();
    assert.match(
      cookie,
      /^dms_session_[0-9a-f]{12}=[^;]+; Path=\/; HttpOnly; SameSite=Lax$/,
    );
    const written = sessions.readSession(
      requestOf({ headers: { cookie: cookie.split(";", 1)[0] } }),
    );
    assert.equal(written?.accessToken, "from-module");
    assert.ok(isNumber(written?.updatedAt));
  });
});

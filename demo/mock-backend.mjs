import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const fixturePath = process.env.DMS_PLAYGROUND_FIXTURE;
if (!fixturePath) throw new Error("DMS_PLAYGROUND_FIXTURE is required");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const DEMO_USER = {
  id: "user-demo-001",
  _id: "user-demo-001",
  email: "operator@example.test",
  name: "Demo Operator",
};
const TOKENS = {
  access_token: "demo-access-token",
  refresh_token: "demo-refresh-token",
  active_tenant_id: "tenant-demo-001",
  user: DEMO_USER,
};

function siteLayout() {
  return fixture.site;
}

function routePattern(path) {
  return path.replaceAll(/:[^/]+/g, "[^/]+");
}

function pageFor(path) {
  const exact = fixture.pages[path];
  const pattern = Object.keys(fixture.pages).find((candidate) => {
    if (!candidate.includes(":")) return false;
    return new RegExp(`^${routePattern(candidate)}$`).test(path);
  });
  const page = exact ?? fixture.pages[pattern];
  if (!page) return undefined;
  return { ...page, shared: fixture.site };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length
    ? JSON.parse(Buffer.concat(chunks).toString("utf8"))
    : {};
}

function sendJson(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handleAuth(request, response, path) {
  const input = await readBody(request);
  const handlers = {
    "/api/auth/login": () =>
      input.email === "2fa@example.test"
        ? {
            requires_2fa: true,
            two_factor_token: "demo-2fa-token",
            methods: ["email"],
          }
        : TOKENS,
    "/api/auth/signup": () => TOKENS,
    "/api/auth/verify-2fa": () => TOKENS,
    "/api/auth/request-2fa-email": () => ({ success: true }),
    "/api/auth/refresh": () => TOKENS,
    "/api/auth/logout": () => ({ success: true }),
    "/api/auth/me": () => DEMO_USER,
    "/api/auth/switch-tenant": () => ({
      ...TOKENS,
      active_tenant_id: input.tenantId,
    }),
  };
  const handler = handlers[path];
  if (!handler) return false;
  sendJson(response, 200, handler());
  return true;
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://backend.local");
  if (url.pathname === "/dms/page") {
    const page = pageFor(url.searchParams.get("path") ?? "/");
    sendJson(response, page ? 200 : 404, page ?? { message: "Page not found" });
    return;
  }
  if (url.pathname === "/dms/sitelayout") {
    sendJson(response, 200, siteLayout());
    return;
  }
  if (await handleAuth(request, response, url.pathname)) return;
  sendJson(response, 404, { message: "Not found" });
}

createServer(handleRequest).listen(
  Number(process.env.PORT ?? 5010),
  process.env.HOST ?? "127.0.0.1",
);

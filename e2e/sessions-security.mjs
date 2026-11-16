import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, startFakeBackend, withSatellite } from "./proxy-satellite.mjs";
import { cookieHeader, fakeAuthBackend, setCookies, signIn } from "./proxy-signin.mjs";

/**
 * @param {string} directory A directory
 * @returns {string[]} Every file below it
 */
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

export const journeys = [
  {
    id: "sessions-security",
    title: "secrets stay on the server: no page, answer or built file holds them, the bootstrap credential reaches only the ready report, and a session needs the same secret",
    entryPoint: "documents and API answers of the run's frontend, its built files, and servers started against one fake backend with different DMS_SESSION_SECRET values",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const web = ctx.state.webUrl;
      const secrets = Object.entries(ctx.state.secrets);
      const credentials = ctx.adminCredentials();
      const login = await exchange(web, { method: "POST", path: "/auth/login", headers: { origin: web, "content-type": "application/json" }, body: JSON.stringify({ email: credentials.email, password: credentials.password }) });
      const cookie = cookieHeader(setCookies(login));
      const answers = {
        signedOutPage: await exchange(web, { path: "/auth", headers: { accept: "text/html" } }),
        signedInPage: await exchange(web, { path: "/settings", headers: { accept: "text/html", cookie } }),
        inertia: await exchange(web, { path: "/settings", headers: { "x-inertia": "true", cookie } }),
        session: await exchange(web, { path: "/api/_auth/session", headers: { cookie } }),
        login,
        preview: await exchange(web, { path: "/dms-preview", headers: { accept: "text/html" } }),
        serverOptions: await exchange(web, { path: "/generated-server-options.json" }),
        manifestCache: await exchange(web, { path: "/.manifest-cache.json" }),
        modules: await exchange(web, { path: "/frontend-modules/playground-frontend/dms.server.ts" }),
        serverEntry: await exchange(web, { path: "/server.mjs" }),
      };
      /** @type {string[]} */
      const leaks = [];
      for (const [name, answer] of Object.entries(answers)) {
        for (const [secretName, value] of secrets) if (answer.text.includes(value)) leaks.push(`${name} holds ${secretName}`);
      }
      const client = join(ctx.state.runPlayground, ".dms-frontend", "dist", "client");
      const built = walk(client).filter((file) => !/\.(br|gz|png|jpg|woff2?)$/.test(file) && statSync(file).size < 20_000_000);
      for (const file of built) {
        const text = readFileSync(file, "utf8");
        for (const [secretName, value] of secrets) if (text.includes(value)) leaks.push(`${file} holds ${secretName}`);
      }
      observe(ctx, "no secret reaches the browser", { leaks, scanned: built.length, secretsChecked: secrets.map(([name]) => name) }, [
        ctx.holds("the run has secrets to look for", secrets.length >= 5, secrets.length),
        ctx.holds("many built files were scanned", built.length > 100, built.length),
        ctx.equal("no answer and no built file holds any of them", leaks, []),
        ctx.equal("the generated secrets and server code are not served by start", [answers.serverOptions, answers.manifestCache, answers.modules, answers.serverEntry].map((answer) => answer.headers.etag ?? null), [null, null, null, null]),
        ctx.equal("a session answer holds the user, never a token", Object.keys(bodyJson(answers.session)).sort(), ["session", "user"]),
      ]);

      const { handler } = fakeAuthBackend();
      await withSatellite(ctx, { backend: handler, env: { DMS_COOKIE_SECURE: "false" } }, async (server) => {
        const entry = await signIn(server);
        await exchange(server.url, { path: "/api/some/route", headers: { cookie: entry.cookie, "x-dms-bootstrap": "from-the-browser" } });
        await exchange(server.url, { path: "/dms-preview", headers: { accept: "text/html" } });
        await exchange(server.url, { path: "/api/_auth/session", headers: { cookie: entry.cookie } });
        const secret = ctx.state.secrets.DMS_BOOTSTRAP_SECRET;
        const others = server.backend.requests.filter((seen) => seen.url !== "/dms/frontend/ready");
        const ready = server.backend.requests.filter((seen) => seen.url === "/dms/frontend/ready");
        observe(ctx, "the bootstrap credential goes only to the ready report", { requests: server.backend.requests.length, ready: ready.length }, [
          ctx.equal("the ready report carries it in x-dms-bootstrap", ready.map((seen) => seen.headers["x-dms-bootstrap"]), [secret]),
          ctx.equal("no other request to the backend carries a bootstrap header, whatever the browser sent", others.map((seen) => seen.headers["x-dms-bootstrap"] ?? null).filter(Boolean), []),
          ctx.equal("no request body or URL holds the credential", server.backend.requests.some((seen) => seen.url.includes(secret) || seen.body.toString().includes(secret)), false),
        ]);
      });

      const shared = await startFakeBackend(fakeAuthBackend().handler);
      try {
        const secretOne = "a".repeat(40);
        const secretTwo = "b".repeat(40);
        let cookieOne = "";
        await withSatellite(ctx, { sharedBackend: shared, env: { DMS_SESSION_SECRET: secretOne, DMS_COOKIE_SECURE: "false" } }, async (server) => {
          cookieOne = (await signIn(server)).cookie;
        });
        const ask = (/** @type {{ url: string }} */ server) => exchange(server.url, { path: "/api/_auth/session", headers: { cookie: cookieOne } }).then(bodyJson);
        const sameSecret = await withSatellite(ctx, { sharedBackend: shared, env: { DMS_SESSION_SECRET: secretOne, DMS_COOKIE_SECURE: "false" } }, ask);
        const otherSecret = await withSatellite(ctx, { sharedBackend: shared, env: { DMS_SESSION_SECRET: secretTwo, DMS_COOKIE_SECURE: "false" } }, ask);
        observe(ctx, "DMS_SESSION_SECRET seals the cookie and stays the same across restarts", { sameSecret, otherSecret }, [
          ctx.equal("after a restart with the same secret the session is still valid", Object.keys(sameSecret).sort(), ["session", "user"]),
          ctx.equal("with another secret the same cookie shows nobody", otherSecret, {}),
        ]);
      } finally {
        await shared.close();
      }
    },
  },
];

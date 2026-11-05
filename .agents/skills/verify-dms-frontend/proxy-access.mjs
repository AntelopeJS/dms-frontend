import { at } from "./json.mjs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { fakeAuthBackend, signIn } from "./proxy-signin.mjs";

const CROSS_ORIGIN = { error: "Forbidden", reason: "missing or untrusted Origin header" };
const NONE_PROXY = JSON.stringify([{ path: "/hook/**", auth: "none" }]);

const MANIFEST_FILE = JSON.stringify({
  endpoints: [
    { path: "/api/acme/events/*/*", methods: ["POST", "put"], headers: ["X-Acme-Secret"] },
    { path: "/api/acme/default/*" },
  ],
  proxies: [{ module: "acme-backend", path: "/webhooks/acme/**", auth: "none" }],
});

const OPERATOR_ENTRIES = [
  { path: "/api/acme/hooks/*", methods: ["POST"], headers: ["x-acme-signature"] },
  { path: "/api/*/wild", methods: ["POST"] },
  { path: "/dms/outside", methods: ["POST"] },
  { path: "/api/acme/query?x=1", methods: ["POST"] },
  { path: "/api/acme/../escape", methods: ["POST"] },
  { path: "/api/acme/badheader/*", methods: ["POST"], headers: ["authorization"] },
  { path: "/api/acme/forwarded/*", methods: ["POST"], headers: ["x-forwarded-host"] },
  { path: "/api/acme/dmsheader/*", methods: ["POST"], headers: ["x-dms-extra"] },
  { path: "/api/acme/inertia/*", methods: ["POST"], headers: ["x-inertia-version"] },
  { path: "/api/acme/override/*", methods: ["POST"], headers: ["x-http-method-override"] },
  { path: "/api/acme/methodoverride/*", methods: ["POST"], headers: ["x-method-override"] },
  { path: "/api/acme/httpmethod/*", methods: ["POST"], headers: ["x-http-method"] },
  { path: "/api/acme/cookie/*", methods: ["POST"], headers: ["cookie"] },
  { path: "/api/acme/original/*", methods: ["POST"], headers: ["x-original-url"] },
  { path: "/api/acme/rewrite/*", methods: ["POST"], headers: ["x-rewrite-url"] },
  { path: "/api/acme/realip/*", methods: ["POST"], headers: ["x-real-ip"] },
  { path: "/api/acme/trace/*", methods: ["TRACE"] },
  { path: "/api/acme/nomethods/*", methods: [] },
  { path: "/api/acme/notarray/*", methods: "POST" },
  { path: "/api/acme/nameless/*", methods: ["POST"], headers: ["acme-header"] },
];
const OPERATOR_ENDPOINTS = JSON.stringify(OPERATOR_ENTRIES);

const REFUSED_PATHS = [
  "/api/zzz/wild",
  "/dms/outside",
  "/api/acme/query",
  "/api/escape",
  "/api/acme/badheader/x",
  "/api/acme/forwarded/x",
  "/api/acme/dmsheader/x",
  "/api/acme/inertia/x",
  "/api/acme/override/x",
  "/api/acme/methodoverride/x",
  "/api/acme/httpmethod/x",
  "/api/acme/cookie/x",
  "/api/acme/original/x",
  "/api/acme/rewrite/x",
  "/api/acme/realip/x",
  "/api/acme/trace/x",
  "/api/acme/nomethods/x",
  "/api/acme/notarray/x",
  "/api/acme/nameless/x",
];

/**
 * @param {import("./proxy-http.mjs").Exchange} answer An answer
 * @returns {{ status: number, body: unknown }} Status and parsed body
 */
const shortAnswer = (answer) => ({ status: answer.status, body: bodyJson(answer) });

/** @typedef {import("./control.d.ts").JourneyContext} Context */
/** @typedef {import("./proxy-satellite.mjs").Satellite} Server */
/** @typedef {Awaited<ReturnType<typeof signIn>>} Login */

/**
 * @param {Context} ctx The journey
 */
async function checkRunFrontend(ctx) {
  const web = ctx.state.webUrl;
  const signature = { "x-playground-signature": "dev" };
  const webhook = await exchange(web, { method: "POST", path: "/api/playground/webhooks/stripe", headers: signature });
  const unsigned = await exchange(web, { method: "POST", path: "/api/playground/webhooks/stripe" });
  const deeper = await exchange(web, { method: "POST", path: "/api/playground/webhooks/stripe/extra", headers: signature });
  const wrongMethod = await exchange(web, { method: "PUT", path: "/api/playground/webhooks/stripe", headers: signature });
  const ownOrigin = await exchange(web, { method: "POST", path: "/api/playground/webhooks/stripe", headers: { origin: web } });
  observe(ctx, "the run's playground webhook is a public endpoint of its frontend module", {
    webhook: shortAnswer(webhook),
    unsigned: shortAnswer(unsigned),
    deeper: shortAnswer(deeper),
    wrongMethod: shortAnswer(wrongMethod),
    ownOrigin: shortAnswer(ownOrigin),
  }, [
    ctx.equal("a signed POST without Origin reaches the backend route", shortAnswer(webhook), { status: 200, body: { received: true, provider: "stripe" } }),
    ctx.equal("an unsigned POST without Origin reaches the route, which refuses the signature itself", shortAnswer(unsigned), { status: 401, body: "Bad signature" }),
    ctx.equal("a path one segment deeper is not public: 403 from the frontend", shortAnswer(deeper), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("a method the endpoint does not declare is not public: 403", shortAnswer(wrongMethod), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("the same POST with the frontend's own Origin is proxied too", shortAnswer(ownOrigin), { status: 401, body: "Bad signature" }),
  ]);

  const origins = [
    ["no Origin", undefined],
    ["another site", "https://evil.example"],
    ["the same host on another port", `http://127.0.0.1:${Number(new URL(web).port) + 1}`],
    ["localhost for 127.0.0.1", `http://localhost:${new URL(web).port}`],
    ["https for http", `https://127.0.0.1:${new URL(web).port}`],
    ["the literal null", "null"],
    ["a malformed value", "not a url"],
  ];
  /** @type {{ label: string, method: string, status: number, body: unknown }[]} */
  const refused = [];
  for (const [label, origin] of origins) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const answer = await exchange(web, { method, path: "/api/verify/nothing", headers: origin === undefined ? {} : { origin } });
      refused.push({ label, method, ...shortAnswer(answer) });
    }
  }
  /** @type {{ method: string, status: number, forbiddenByFrontend: boolean }[]} */
  const allowed = [];
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const answer = await exchange(web, { method, path: "/api/verify/nothing", headers: { origin: web } });
    allowed.push({ method, status: answer.status, forbiddenByFrontend: at(bodyJson(answer), "error") === "Forbidden" && at(bodyJson(answer), "reason") === CROSS_ORIGIN.reason });
  }
  /** @type {{ method: string, forbiddenByFrontend: boolean }[]} */
  const safe = [];
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const answer = await exchange(web, { method, path: "/api/verify/nothing" });
    safe.push({ method, forbiddenByFrontend: at(bodyJson(answer), "reason") === CROSS_ORIGIN.reason });
  }
  observe(ctx, "session proxy /api/**: Origin rule on the run's frontend", { refused, allowed, safe }, [
    ctx.equal("every state-changing request without the own Origin answers 403 with the documented body", refused.filter((entry) => entry.status === 403 && JSON.stringify(entry.body) === JSON.stringify(CROSS_ORIGIN)).length, origins.length * 4),
    ctx.equal("a request with the frontend's own Origin is not refused by the frontend", allowed.map((entry) => entry.forbiddenByFrontend), [false, false, false, false]),
    ctx.equal("GET, HEAD and OPTIONS need no Origin", safe.map((entry) => entry.forbiddenByFrontend), [false, false, false]),
  ]);
}

/**
 * @param {Context} ctx The journey
 * @param {Server} server The second server
 * @param {Login} login The sign-in
 */
async function checkManifestEndpoints(ctx, server, login) {
  const acme = { "x-acme-secret": "s3cret", "x-acme-other": "no", authorization: "Bearer client", cookie: login.cookie };
  const post = await exchange(server.url, { method: "POST", path: "/api/acme/events/a/b?x=1", headers: acme, body: "{}" });
  const seenPost = server.backend.to("/api/acme/events/a/b").at(-1);
  const put = await exchange(server.url, { method: "PUT", path: "/api/acme/events/a/b", headers: acme, body: "{}" });
  const del = await exchange(server.url, { method: "DELETE", path: "/api/acme/events/a/b", headers: acme });
  const oneSegment = await exchange(server.url, { method: "POST", path: "/api/acme/events/a", headers: acme });
  const threeSegments = await exchange(server.url, { method: "POST", path: "/api/acme/events/a/b/c", headers: acme });
  const prefix = await exchange(server.url, { method: "POST", path: "/api/acme/events", headers: acme });
  const dotDot = await exchange(server.url, { method: "POST", path: "/api/acme/events/a/b/../../../admin", headers: acme });
  const encodedDots = await exchange(server.url, { method: "POST", path: "/api/acme/events/%2e%2e/%2e%2e/secret", headers: acme });
  const climbsInto = await exchange(server.url, { method: "POST", path: "/api/zzz/../acme/events/a/b", headers: acme });
  const backslash = await exchange(server.url, { method: "POST", path: "/api/acme/events/a\\..\\other", headers: acme });
  const defaultPost = await exchange(server.url, { method: "POST", path: "/api/acme/default/a", headers: acme, body: "{}" });
  const defaultPut = await exchange(server.url, { method: "PUT", path: "/api/acme/default/a", headers: acme, body: "{}" });
  const defaultPatch = await exchange(server.url, { method: "PATCH", path: "/api/acme/default/a", headers: acme, body: "{}" });
  const defaultDelete = await exchange(server.url, { method: "DELETE", path: "/api/acme/default/a", headers: acme });
  observe(ctx, "manifest public endpoint /api/acme/default/* declares no methods: POST only", {
    post: shortAnswer(defaultPost),
    put: shortAnswer(defaultPut),
    backendSaw: server.backend.to("/api/acme/default/a").map((seen) => seen.method),
  }, [
    ctx.equal("POST is public by default", defaultPost.status, 200),
    ctx.equal("PUT is not", shortAnswer(defaultPut), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("PATCH is not", shortAnswer(defaultPatch), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("DELETE is not", shortAnswer(defaultDelete), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("the backend saw only the POST", server.backend.to("/api/acme/default/a").map((seen) => seen.method), ["POST"]),
  ]);
  observe(ctx, "manifest public endpoint /api/acme/events/*/* (POST, PUT; x-acme-secret)", {
    post: shortAnswer(post),
    backendSaw: { method: seenPost?.method, url: seenPost?.url, headers: seenPost?.headers },
    put: shortAnswer(put),
    del: shortAnswer(del),
    oneSegment: shortAnswer(oneSegment),
    threeSegments: shortAnswer(threeSegments),
    prefix: shortAnswer(prefix),
    dotDot: shortAnswer(dotDot),
    encodedDots: shortAnswer(encodedDots),
    climbsInto: shortAnswer(climbsInto),
    backslash: shortAnswer(backslash),
    backendPaths: server.backend.requests.map((seen) => `${seen.method} ${seen.url}`),
  }, [
    ctx.equal("POST without Origin reaches the backend", post.status, 200),
    ctx.equal("the declared header arrives with its value", seenPost.headers["x-acme-secret"], "s3cret"),
    ctx.equal("an undeclared header does not", seenPost.headers["x-acme-other"] ?? null, null),
    ctx.equal("the signed-in browser's session is not sent to a public endpoint", seenPost.headers.authorization ?? null, null),
    ctx.equal("the query string is kept for the backend", seenPost.url, "/api/acme/events/a/b?x=1"),
    ctx.equal("PUT, declared in lower case, is public too", put.status, 200),
    ctx.equal("DELETE is not declared: 403", shortAnswer(del), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("one segment instead of two: 403", shortAnswer(oneSegment), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("three segments: 403, no prefix match", shortAnswer(threeSegments), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("the prefix alone: 403", shortAnswer(prefix), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("a path climbing out with .. is matched after normalization: 403", shortAnswer(dotDot), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("%2e%2e is normalized too: 403", shortAnswer(encodedDots), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("a path that climbs into the public path is matched as the backend gets it", [climbsInto.status, server.backend.to("/api/acme/events/a/b").length], [200, 3]),
    ctx.equal("a backslash path reaches no public endpoint: 403", backslash.status, 403),
    ctx.equal("the backend never saw the refused paths", server.backend.requests.some((seen) => /admin|secret|other|\/c$/.test(seen.url)), false),
  ]);
}

/**
 * @param {Context} ctx The journey
 * @param {Server} server The second server
 * @param {Login} login The sign-in
 */
async function checkOperatorEndpoints(ctx, server, login) {
  const hooks = await exchange(server.url, { method: "POST", path: "/api/acme/hooks/one", headers: { "x-acme-signature": "sig", cookie: login.cookie } });
  const seenHook = server.backend.to("/api/acme/hooks/one")[0];
  const log = server.log();
  const warned = OPERATOR_ENTRIES.filter((entry, index) => index > 0 && log.includes(`Ignoring malformed public endpoint ${JSON.stringify(entry)}`)).length;
  /** @type {{ path: string, status: number, reached: number }[]} */
  const refusals = [];
  for (const path of REFUSED_PATHS) {
    const answer = await exchange(server.url, { method: "POST", path, headers: { "x-acme-signature": "sig" } });
    refusals.push({ path, status: answer.status, reached: server.backend.to(path).length });
  }
  observe(ctx, "DMS_PUBLIC_ENDPOINTS: a good entry works, every malformed one is dropped whole with a warning", { hooks: shortAnswer(hooks), seenHook: seenHook?.headers, refusals, warned }, [
    ctx.equal("the well-formed operator entry is public", hooks.status, 200),
    ctx.equal("its declared header arrives", seenHook.headers["x-acme-signature"], "sig"),
    ctx.equal(`${REFUSED_PATHS.length} malformed entries each get a warning`, warned, REFUSED_PATHS.length),
    ctx.equal("none of the malformed entries was widened into a public endpoint", refusals.map((entry) => entry.status), REFUSED_PATHS.map(() => 403)),
    ctx.equal("none reached the backend", refusals.map((entry) => entry.reached), REFUSED_PATHS.map(() => 0)),
  ]);
}

/**
 * @param {Context} ctx The journey
 * @param {Server} server The second server
 * @param {Login} login The sign-in
 */
async function checkAuthNone(ctx, server, login) {
  /** @type {Record<string, { status: number, authorization: string | string[] | null, cookie: string | string[] | null, origin: string | string[] | undefined }>} */
  const none = {};
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const answer = await exchange(server.url, { method, path: "/hook/anything", headers: { cookie: login.cookie, authorization: "Bearer client", origin: "https://evil.example" }, body: "x" });
    const seen = server.backend.to("/hook/anything").at(-1);
    none[method] = { status: answer.status, authorization: seen.headers.authorization ?? null, cookie: seen.headers.cookie ?? null, origin: seen.headers.origin };
  }
  const bare = await exchange(server.url, { method: "POST", path: "/webhooks/acme/event", body: "x" });
  observe(ctx, "auth none: no Origin is needed and the session is never sent", { none, bare: shortAnswer(bare) }, [
    ctx.equal("every state-changing method is proxied without the own Origin", Object.values(none).map((entry) => entry.status), [200, 200, 200, 200]),
    ctx.equal("the signed-in browser's session is never sent", Object.values(none).map((entry) => [entry.authorization, entry.cookie]), [[null, null], [null, null], [null, null], [null, null]]),
    ctx.equal("the Origin is relayed as received", Object.values(none).map((entry) => entry.origin), ["https://evil.example", "https://evil.example", "https://evil.example", "https://evil.example"]),
    ctx.equal("a proxy declared in the manifest by a backend module works without Origin", bare.status, 200),
  ]);
}

/**
 * @param {Context} ctx The journey
 * @param {Server} server The second server
 * @param {Login} login The sign-in
 * @param {import("./proxy-signin.mjs").FakeAuth} auth What the backend issued
 */
async function checkSessionToken(ctx, server, login, auth) {
  const withOrigin = await exchange(server.url, { method: "POST", path: "/api/session/needs-origin", headers: { cookie: login.cookie, origin: server.url } });
  const seenSession = server.backend.to("/api/session/needs-origin")[0];
  observe(ctx, "auth session: the signed-in request carries the access token", { status: withOrigin.status, authorization: seenSession?.headers.authorization }, [
    ctx.equal("a POST with the own Origin and the session reaches the backend with the access token", seenSession?.headers.authorization, `Bearer ${auth.current}`),
  ]);
}

export const journeys = [
  {
    id: "proxy-access",
    title: "a state-changing proxied request needs the frontend's own Origin; auth none and public endpoints are the documented exceptions",
    entryPoint: "POST/PUT/DELETE/GET through the run's frontend and through a second `ajs dms start` with declared proxies and public endpoints",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await checkRunFrontend(ctx);

      const { handler, auth } = fakeAuthBackend();
      await withSatellite(ctx, {
        backend: handler,
        env: { DMS_BACKEND_PROXIES: NONE_PROXY, DMS_PUBLIC_ENDPOINTS: OPERATOR_ENDPOINTS, DMS_COOKIE_SECURE: "false" },
        files: { "generated-public-endpoints.json": MANIFEST_FILE },
      }, async (server) => {
        const login = await signIn(server);
        await checkManifestEndpoints(ctx, server, login);
        await checkOperatorEndpoints(ctx, server, login);
        await checkAuthNone(ctx, server, login);
        await checkSessionToken(ctx, server, login, auth);
      });
    },
  },
];

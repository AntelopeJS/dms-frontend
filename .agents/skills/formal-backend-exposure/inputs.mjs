import fc from "fast-check";

/** @typedef {import("./contract.mjs").Deployment} Deployment */
/** @typedef {"absent" | "own" | "other" | "null" | "https-own"} OriginKind */
/** @typedef {"none" | "valid" | "forged" | "foreign"} SessionKind */
/**
 * One request a visitor sends: its method and raw request target, the Origin
 * it carries against the Host it names, its session cookie, and the extra
 * headers it sends, each valued with {@link MARK} so that the backend side
 * can tell them from the server's own.
 *
 * @typedef {{
 *   method: string,
 *   target: string,
 *   host: "own" | "other",
 *   origin: OriginKind,
 *   session: SessionKind,
 *   headers: string[],
 * }} Visit
 */
/** @typedef {{ deployment: Deployment, visit: Visit }} Case */

/** The value prefix of every header a visitor chooses. */
export const MARK = "zqmark";

const FIRST = ["api", "api", "media", "a"];
const REST = ["hooks", "b", "a", "_dms", "icons", "x.y"];
const VISIT_FIRST = [...FIRST, "dms", "assets", "node_modules", "@vite", "API"];
const ODD_SEGMENTS = ["..", ".", "%2e%2e", "%2E.", "", "%61pi", "API", "a%2Fb", "x;y", "%zz", "a\\b", "a%2F..%2F..%2Fapi", '"q"', "{b}"];
const MALFORMED_PROXIES = ["/", "/**", "/*", "/*/a", "a/b", "/a/**/b", "/a//b", "/a/..", "/a/./b", "/assets/**", "/api/_dms/**", "/@vite/**", "/a b", "/a%2Fb/**"];
const MALFORMED_ENDPOINTS = ["/api/*", "/api/*/b", "/media/a", "/api/a/**", "/api/a/../b", "/api", "/api/.a", "/api/a/b?x=1"];
/** @type {import("./contract.mjs").ProxyEntry} */
const DMS_API = { path: "/api/**" };
/** @type {import("./contract.mjs").ProxyEntry} */
const DMS_PAGES = { path: "/dms/**" };
/** @type {import("./contract.mjs").ProxyEntry[]} */
const NO_PROXIES = [];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const ENDPOINT_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const DECLARABLE_HEADERS = ["x-hook-secret", "x-acme-signature"];
const UNDECLARABLE_HEADERS = ["x-forwarded-for", "x-dms-tenant", "authorization", "x-http-method-override"];
const HOSTILE_TARGETS = ["//evil.example/api/a", "http://evil.example/api/a", "/\\evil.example/api/a", "*", "/%2F%2Fevil.example/a"];
const QUERIES = ["", "", "", "?q=1", "?next=%2F..%2Fapi", "#frag", "?a=1#b"];

/**
 * Headers a visitor may send: the ones the docs relay, the ones a public
 * endpoint may declare, and ones the backend gives a meaning to.
 */
const VISITOR_HEADERS = [
  "user-agent",
  "x-content-language",
  "x-realtime-session",
  "x-realtime-connection",
  "accept",
  "content-type",
  "if-match",
  "referer",
  ...DECLARABLE_HEADERS,
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-real-ip",
  "x-client-ip",
  "cf-ipcountry",
  "forwarded",
  "x-dms-bootstrap",
  "x-dms-tenant",
  "x-http-method-override",
  "x-inertia",
  "x-other",
  "authorization",
];

const rest = fc.constantFrom(...REST);

const wellFormedProxy = fc
  .tuple(fc.constantFrom(...FIRST), fc.array(fc.oneof({ weight: 3, arbitrary: rest }, { weight: 2, arbitrary: fc.constant("*") }), { maxLength: 3 }), fc.boolean())
  .map(([first, more, deep]) => `/${[first, ...more].join("/")}${deep ? "/**" : ""}`);

const proxyEntry = fc
  .record({
    path: fc.oneof({ weight: 8, arbitrary: wellFormedProxy }, { weight: 1, arbitrary: fc.constantFrom(...MALFORMED_PROXIES) }),
    auth: fc.oneof({ weight: 8, arbitrary: fc.constantFrom(undefined, "session", "none", "none") }, { weight: 1, arbitrary: fc.constant("bearer") }),
    maxBodyBytes: fc.oneof({ weight: 8, arbitrary: fc.constantFrom(undefined, undefined, 1_048_576) }, { weight: 1, arbitrary: fc.constantFrom(0, 1.5, "1024") }),
  })
  .map(({ path, auth, maxBodyBytes }) => {
    /** @type {import("./contract.mjs").ProxyEntry} */
    const entry = { path };
    if (auth !== undefined) entry.auth = auth;
    if (maxBodyBytes !== undefined) entry.maxBodyBytes = maxBodyBytes;
    return entry;
  });

const wellFormedEndpoint = fc
  .tuple(fc.constantFrom("hooks", "a", "b"), fc.array(fc.oneof(rest, fc.constant("*")), { maxLength: 2 }))
  .map(([first, more]) => `/api/${[first, ...more].join("/")}`);

const endpointEntry = fc
  .record({
    path: fc.oneof({ weight: 6, arbitrary: wellFormedEndpoint }, { weight: 1, arbitrary: fc.constantFrom(...MALFORMED_ENDPOINTS) }),
    methods: fc.oneof({ weight: 2, arbitrary: fc.constant(undefined) }, { weight: 5, arbitrary: fc.subarray(ENDPOINT_METHODS, { minLength: 1, maxLength: 2 }) }, { weight: 1, arbitrary: fc.constant(["TRACE"]) }),
    headers: fc.oneof({ weight: 2, arbitrary: fc.constant(undefined) }, { weight: 5, arbitrary: fc.subarray(DECLARABLE_HEADERS, { minLength: 1 }) }, { weight: 1, arbitrary: fc.subarray(UNDECLARABLE_HEADERS, { minLength: 1, maxLength: 1 }) }),
  })
  .map(({ path, methods, headers }) => {
    /** @type {import("./contract.mjs").EndpointEntry} */
    const entry = { path };
    if (methods !== undefined) entry.methods = methods;
    if (headers !== undefined) entry.headers = headers;
    return entry;
  });

/**
 * A deployment: the backend proxies and the public endpoints it declares, the
 * DMS's own `/api/**` and `/dms/**` among them half of the time.
 */
const deployment = fc
  .record({
    random: fc.array(proxyEntry, { minLength: 1, maxLength: 3 }),
    dms: fc.constantFrom(NO_PROXIES, [DMS_API], [DMS_API], [DMS_API, DMS_PAGES], [DMS_PAGES]),
    dmsFirst: fc.boolean(),
    endpoints: fc.array(endpointEntry, { minLength: 1, maxLength: 2 }),
  })
  .map(({ random, dms, dmsFirst, endpoints }) => ({ proxies: dmsFirst ? [...dms, ...random] : [...random, ...dms], endpoints }));

/**
 * The segments of a path a pattern covers: each `*` filled with one segment,
 * `**` with up to two.
 *
 * @param {string} pattern
 */
function instancesOf(pattern) {
  const segments = pattern.startsWith("/") ? pattern.slice(1).split("/") : [pattern];
  const filled = segments.map((segment) => {
    if (segment === "**") return fc.array(rest, { maxLength: 2 });
    if (segment === "*") return fc.oneof({ weight: 4, arbitrary: rest }, { weight: 1, arbitrary: fc.constantFrom(...ODD_SEGMENTS) }).map((value) => [value]);
    return fc.constant([segment]);
  });
  return fc.tuple(...filled).map((parts) => parts.flat());
}

/**
 * A visit aimed at a declaration: a path it covers, and for a public
 * endpoint one of its methods most of the time.
 *
 * @param {Deployment} declared
 * @returns {fc.Arbitrary<{ segments: string[], method: string }>}
 */
function aimed(declared) {
  const method = fc.constantFrom(...METHODS);
  const anyPath = fc.record({ segments: fc.tuple(fc.constantFrom(...VISIT_FIRST), fc.array(rest, { maxLength: 3 })).map(([first, more]) => [first, ...more]), method });
  /** @type {fc.WeightedArbitrary<{ segments: string[], method: string }>[]} */
  const targets = [{ weight: 1, arbitrary: anyPath }];
  for (const { path } of declared.proxies) targets.push({ weight: 1, arbitrary: fc.record({ segments: instancesOf(path), method }) });
  for (const { path, methods } of declared.endpoints) {
    const allowed = (methods ?? ["POST"]).filter((name) => METHODS.includes(name));
    const own = allowed.length ? fc.constantFrom(...allowed) : method;
    targets.push({ weight: 2, arbitrary: fc.record({ segments: instancesOf(path), method: fc.oneof({ weight: 3, arbitrary: own }, { weight: 1, arbitrary: method }) }) });
  }
  return fc.oneof(...targets);
}

/**
 * A raw request target over `segments`: up to two odd segments spliced in,
 * one segment sometimes extended past a declared literal (`api` to `apix`),
 * an optional trailing slash and query, and a separator that is not `/` after
 * the first segment now and then. A space goes out as `%20`, as a browser
 * sends it: Node's client refuses a raw one.
 *
 * @param {string[]} segments
 */
function rawTarget(segments) {
  const splice = fc.tuple(fc.nat({ max: 4 }), fc.constantFrom(...ODD_SEGMENTS));
  const extend = fc.tuple(fc.nat({ max: 4 }), fc.constantFrom("x", ".json", "-b"));
  return fc
    .record({
      odd: fc.oneof({ weight: 3, arbitrary: fc.constant([]) }, { weight: 1, arbitrary: fc.array(splice, { minLength: 1, maxLength: 2 }) }),
      extended: fc.oneof({ weight: 4, arbitrary: fc.constant([]) }, { weight: 1, arbitrary: fc.array(extend, { minLength: 1, maxLength: 1 }) }),
      trailing: fc.boolean(),
      query: fc.constantFrom(...QUERIES),
      separator: fc.constantFrom("/", "/", "/", "/", "\\", "//"),
    })
    .map(({ odd, extended, trailing, query, separator }) => {
      const spliced = [...segments];
      for (const [at, suffix] of extended) if (spliced.length) spliced[Math.min(at, spliced.length - 1)] += suffix;
      for (const [at, segment] of odd) spliced.splice(Math.min(at, spliced.length), 0, segment);
      const [first = "", ...more] = spliced;
      return `/${first}${more.length ? separator : ""}${more.join("/")}${trailing ? "/" : ""}${query}`.replaceAll(" ", "%20");
    });
}

/**
 * A visit: a method and a raw target from `request`, a Host, an Origin, a
 * session cookie and extra headers.
 *
 * @param {fc.Arbitrary<{ segments: string[], method: string }>} request
 * @returns {fc.Arbitrary<Visit>}
 */
function visitOf(request) {
  const sent = request.chain(({ segments, method }) =>
    fc.oneof({ weight: 14, arbitrary: rawTarget(segments) }, { weight: 1, arbitrary: fc.constantFrom(...HOSTILE_TARGETS) }).map((target) => ({ method, target })),
  );
  return fc
    .record({
      sent,
      host: fc.constantFrom("own", "own", "own", "other"),
      origin: fc.constantFrom("absent", "own", "own", "other", "null", "https-own"),
      session: fc.constantFrom("none", "valid", "valid", "forged", "foreign"),
      headers: fc.subarray(VISITOR_HEADERS),
    })
    .map(({ sent: { method, target }, ...others }) => ({ method, target, ...others }));
}

/**
 * A pattern that covers `path`: a prefix of it, deep when cut short, some of
 * its segments after the first turned into `*`.
 *
 * @param {string[]} path
 */
function patternOver(path) {
  return fc
    .record({
      cut: fc.integer({ min: 1, max: path.length }),
      stars: fc.array(fc.boolean(), { minLength: path.length, maxLength: path.length }),
      deep: fc.boolean(),
      auth: fc.constantFrom(undefined, "session", "none"),
    })
    .map(({ cut, stars, deep, auth }) => {
      const kept = path.slice(0, cut).map((segment, index) => (index > 0 && stars[index] ? "*" : segment));
      const pattern = `/${kept.join("/")}${cut < path.length || deep ? "/**" : ""}`;
      return auth ? { path: pattern, auth } : { path: pattern };
    });
}

/**
 * A deployment where two or three proxies, and sometimes a public endpoint,
 * cover one path, and a visit to that path: the cases where the order of the
 * proxies decides.
 */
const overlapCase = fc
  .tuple(fc.constantFrom(...FIRST), fc.array(rest, { minLength: 1, maxLength: 4 }))
  .map(([first, more]) => [first, ...more])
  .chain((path) =>
    fc.record({
      deployment: fc.record({
        proxies: fc.array(patternOver(path), { minLength: 2, maxLength: 3 }),
        endpoints: path[0] === "api" ? fc.subarray([{ path: `/${path.join("/")}`, methods: ENDPOINT_METHODS, headers: DECLARABLE_HEADERS }]) : fc.constant([]),
      }),
      visit: visitOf(fc.record({ segments: fc.constant(path), method: fc.constantFrom(...METHODS) })),
    }),
  );

/** A deployment and one visit to it. */
const randomCase = deployment.chain((declared) => visitOf(aimed(declared)).map((visit) => ({ deployment: declared, visit })));

/** A deployment and one visit to it: a random one, or one where proxies overlap. */
export const exposureCase = fc.oneof({ weight: 3, arbitrary: randomCase }, { weight: 1, arbitrary: overlapCase });

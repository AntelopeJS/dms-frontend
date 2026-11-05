import { covers, declaredEndpoints, declaredProxies, isOwnOrigin, matchingEndpoints, ownerOf, PAGE_READS, RELAYED_HEADERS, SAFE_METHODS } from "./contract.mjs";
import { SESSION_AUTHORIZATION } from "./drive.mjs";
import { MARK } from "./inputs.mjs";

/** @typedef {import("./inputs.mjs").Case} Case */
/** @typedef {import("./drive.mjs").Observation} Observation */
/** @typedef {import("./drive.mjs").BackendRequest} BackendRequest */
/** @typedef {import("./contract.mjs").Owner} Owner */
/**
 * What a rule reads of one case: the case, what the docs say owns it, what
 * the visit did, and the backend requests that are not the server's own page
 * reads.
 *
 * @typedef {{ case: Case, owner: Owner, observation: Observation, proxied: BackendRequest[] }} Seen
 */
/**
 * A rule: its name, and the sentence that says how a case breaks it, or
 * `undefined` when the case keeps it.
 *
 * @typedef {{ name: string, broken: (seen: Seen) => string | undefined }} Rule
 */

const FORWARDED = new Set(["x-forwarded-for", "x-forwarded-proto", "x-forwarded-host"]);
const CREDENTIALS = new Set(["cookie", "authorization"]);

/** @param {BackendRequest} received */
const pathOf = (received) => new URL(received.url, "http://backend.local").pathname;

/** @param {BackendRequest} received */
const shown = (received) => `${received.method} ${received.url}`;

/**
 * @param {Owner} owner
 * @param {BackendRequest} received
 */
const isPageRead = (owner, received) => owner.kind === "page" && received.method === "GET" && PAGE_READS.has(pathOf(received));

/** @param {Seen} seen */
const isSignedIn = (seen) => seen.case.visit.session === "valid";

/** @param {Seen} seen */
const hasOwnOrigin = (seen) => isOwnOrigin(seen.observation.origin, seen.observation.host);

/**
 * The auth mode of the proxy that decides the visit, when the docs name one:
 * `undefined` when the most specific covering proxies tie on different modes.
 *
 * @param {Owner} owner
 */
function winningAuth(owner) {
  const modes = new Set(owner.winners.map((proxy) => proxy.auth));
  return modes.size === 1 ? [...modes][0] : undefined;
}

/**
 * Whether the docs refuse the visit with a 403: a write without the
 * frontend's own Origin under an `auth: "session"` proxy, outside the public
 * endpoints. `undefined` when the docs leave the proxy to declaration order.
 *
 * @param {Seen} seen
 */
function isRefusedByDocs(seen) {
  if (seen.owner.endpoints.length) return false;
  const auth = winningAuth(seen.owner);
  if (auth === undefined) return undefined;
  return auth === "session" && !SAFE_METHODS.has(seen.case.visit.method) && !hasOwnOrigin(seen);
}

/**
 * Builds what a rule reads of a case.
 *
 * @param {Case} current
 * @param {Observation} observation
 * @returns {Seen}
 */
export function seenOf(current, observation) {
  const owner = ownerOf(current.deployment, current.visit.method, current.visit.target);
  const proxied = observation.received.filter((received) => !isPageRead(owner, received));
  return { case: current, owner, observation, proxied };
}

/** @type {Rule} */
const declaredPrefixesOnly = {
  name: "DeclaredPrefixesOnly",
  broken: ({ case: { deployment }, owner, proxied }) => {
    const proxies = declaredProxies(deployment.proxies);
    for (const received of proxied) {
      if (owner.kind !== "backend") return `the backend received ${shown(received)}, but the docs give the visit to the ${owner.kind}`;
      if (!proxies.some((proxy) => covers(proxy, pathOf(received)))) return `the backend received ${shown(received)}, which no declared proxy covers`;
    }
    return undefined;
  },
};

/** @type {Rule} */
const samePathAsMatched = {
  name: "SamePathAsMatched",
  broken: ({ case: { visit }, owner, proxied }) => {
    if (owner.kind !== "backend") return undefined;
    if (proxied.length > 1) return `the backend received ${proxied.length} requests: ${proxied.map(shown).join(", ")}`;
    const [received] = proxied;
    const expected = `${visit.method} ${owner.pathname}${owner.search}`;
    return received && shown(received) !== expected ? `the backend received ${shown(received)}, the server matched ${expected}` : undefined;
  },
};

/** @type {Rule} */
const sessionOnlyWhereDeclared = {
  name: "SessionOnlyWhereDeclared",
  broken: (seen) => {
    const { deployment } = seen.case;
    for (const received of seen.observation.received) {
      const authorization = received.headers.authorization;
      if (authorization === undefined || authorization.includes(MARK)) continue;
      if (authorization !== SESSION_AUTHORIZATION || !isSignedIn(seen)) return `the backend received ${shown(received)} with Authorization "${authorization}", which is not the visitor's session`;
      if (!seen.proxied.includes(received)) continue;
      const path = pathOf(received);
      const isSessionPath = declaredProxies(deployment.proxies).some((proxy) => proxy.auth === "session" && covers(proxy, path));
      if (!isSessionPath) return `the backend received ${shown(received)} with the session, and no auth: "session" proxy covers it`;
      if (matchingEndpoints(declaredEndpoints(deployment.endpoints), received.method, path).length) return `the backend received ${shown(received)} with the session, and it is a public endpoint`;
    }
    return undefined;
  },
};

/** @type {Rule} */
const noCrossSiteSessionWrite = {
  name: "NoCrossSiteSessionWrite",
  broken: (seen) => {
    if (hasOwnOrigin(seen)) return undefined;
    const write = seen.observation.received.find((received) => !SAFE_METHODS.has(received.method) && received.headers.authorization === SESSION_AUTHORIZATION);
    return write ? `the backend received ${shown(write)} with the session, and the visitor sent ${seen.observation.origin === undefined ? "no Origin" : `Origin ${seen.observation.origin}`}` : undefined;
  },
};

/** @type {Rule} */
const noVisitorCredentials = {
  name: "NoVisitorCredentials",
  broken: ({ observation }) => {
    for (const received of observation.received) {
      if (received.headers.cookie !== undefined) return `the backend received ${shown(received)} with Cookie "${received.headers.cookie}"`;
      if (received.headers.authorization?.includes(MARK)) return `the backend received ${shown(received)} with the visitor's own Authorization`;
    }
    return undefined;
  },
};

/** @type {Rule} */
const forwardedByTheProxy = {
  name: "ForwardedByTheProxy",
  broken: ({ observation }) => {
    const expected = { "x-forwarded-for": observation.clientAddress, "x-forwarded-proto": "http", "x-forwarded-host": observation.host };
    for (const received of observation.received) {
      for (const [name, value] of Object.entries(expected)) {
        const got = received.headers[name];
        if (got !== value) return `the backend received ${shown(received)} with ${name} ${got === undefined ? "missing" : `"${String(got)}"`}, expected "${value}"`;
      }
    }
    return undefined;
  },
};

/** @type {Rule} */
const listedHeadersOnly = {
  name: "ListedHeadersOnly",
  broken: ({ owner, observation, proxied }) => {
    const declared = new Set(owner.endpoints.flatMap((endpoint) => endpoint.headers));
    for (const received of observation.received) {
      for (const [name, value] of Object.entries(received.headers)) {
        if (FORWARDED.has(name) || CREDENTIALS.has(name) || !String(value).includes(MARK)) continue;
        if (RELAYED_HEADERS.has(name) || (proxied.includes(received) && declared.has(name))) continue;
        return `the backend received ${shown(received)} with the visitor's ${name}`;
      }
    }
    return undefined;
  },
};

/** @type {Rule} */
const declaredPrefixesReach = {
  name: "DeclaredPrefixesReach",
  broken: (seen) => {
    if (seen.owner.kind !== "backend" || isRefusedByDocs(seen) !== false || seen.proxied.length) return undefined;
    return `the visit answered ${seen.observation.status} and the backend received nothing, though ${seen.owner.winners.map((proxy) => proxy.path).join(" or ")} covers it`;
  },
};

/** @type {Rule} */
const winningProxyDecides = {
  name: "WinningProxyDecides",
  broken: (seen) => {
    const refused = isRefusedByDocs(seen);
    if (seen.owner.kind !== "backend" || seen.owner.endpoints.length || refused === undefined) return undefined;
    const { status } = seen.observation;
    const winner = `${seen.owner.winners[0]?.path} (auth: "${winningAuth(seen.owner)}") decides`;
    if (refused) return status === 403 && !seen.proxied.length ? undefined : `${winner}: a write without the own Origin gets 403, and it answered ${status}`;
    if (status === 403) return `${winner}: the visit is not refused, and it answered 403`;
    const [received] = seen.proxied;
    if (!received) return undefined;
    const expected = winningAuth(seen.owner) === "session" && isSignedIn(seen) ? SESSION_AUTHORIZATION : undefined;
    const got = received.headers.authorization;
    return got === expected ? undefined : `${winner}: the backend received ${shown(received)} ${got === undefined ? "without the session" : "with the session"}`;
  },
};

/** @type {Rule} */
const publicEndpointsWork = {
  name: "PublicEndpointsWork",
  broken: (seen) => {
    const { owner, observation, proxied } = seen;
    if (owner.kind !== "backend" || !owner.endpoints.length) return undefined;
    const endpoint = owner.endpoints.map((candidate) => candidate.path).join(" or ");
    if (observation.status === 403 || proxied.length !== 1) return `the public endpoint ${endpoint} answered ${observation.status}, and the backend received ${proxied.length} requests`;
    const [received] = proxied;
    if (received?.headers.authorization !== undefined) return `the public endpoint ${endpoint} got the session`;
    const sent = new Set(seen.case.visit.headers);
    const carries = (/** @type {import("./contract.mjs").Endpoint} */ candidate) => candidate.headers.every((name) => !sent.has(name) || received?.headers[name] !== undefined);
    if (owner.endpoints.some(carries)) return undefined;
    const missing = owner.endpoints.flatMap((candidate) => candidate.headers).filter((name) => sent.has(name) && received?.headers[name] === undefined);
    return `the backend received ${received ? shown(received) : "nothing"} without the declared ${[...new Set(missing)].join(", ")}`;
  },
};

/** Every rule, in the order they are checked and reported. */
export const RULES = [
  declaredPrefixesOnly,
  samePathAsMatched,
  sessionOnlyWhereDeclared,
  noCrossSiteSessionWrite,
  noVisitorCredentials,
  forwardedByTheProxy,
  listedHeadersOnly,
  declaredPrefixesReach,
  winningProxyDecides,
  publicEndpointsWork,
];

// What a module route handler receives and how its answer is written: the
// Web-standard request, the session, the module's sealed cookies, the backend,
// and the defaults every route gets once (same-origin on unsafe methods, a body
// limit, `no-store`). See `server-module.ts` for the types a module reads.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { backend, json, RequestBodyError } from "./auth/backend.mjs";
import {
  clientIp,
  CROSS_ORIGIN_ERROR,
  isSameOrigin,
  requestScheme,
} from "./auth/client-ip.mjs";
import {
  clearSealedCookie,
  clearSession,
  readSealedCookie,
  readSession,
  SESSION_COOKIE,
  setRequestSession,
  writeSealedCookie,
  writeSession,
} from "./auth/session.mjs";
import { renderEmailTemplate } from "./email.mjs";
import {
  isBackendUrl,
  relayableCookies,
  relayedLocation,
} from "./proxy-redirects.mjs";
import { backendUrl } from "./request-target.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const COOKIE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The sealed cookies of the module that owns sign-in: session, accounts, flows. */
const RESERVED_COOKIE_PREFIX = "dms_";
const BODY_TOO_LARGE = "Request body too large";

function requestOrigin(request) {
  const host = request.headers.host;
  try {
    return new URL(`${requestScheme(request)}://${host}`).origin;
  } catch {
    return "http://frontend.local";
  }
}

function requestHeaders(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (name.startsWith(":") || value === undefined) continue;
    for (const entry of [value].flat()) headers.append(name, entry);
  }
  return headers;
}

/** The request body as a Web stream that errors past `limit` bytes. */
function limitedBody(request, limit) {
  let size = 0;
  return Readable.toWeb(request).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit)
          controller.error(new RequestBodyError(413, BODY_TOO_LARGE));
        else controller.enqueue(chunk);
      },
    }),
  );
}

function webRequest(request, route) {
  const url = new URL(request.url, requestOrigin(request));
  const hasBody = !["GET", "HEAD"].includes(request.method);
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (hasBody && declaredLength > route.bodyLimit)
    throw new RequestBodyError(413, BODY_TOO_LARGE);
  return new Request(url, {
    method: request.method,
    headers: requestHeaders(request),
    body: hasBody ? limitedBody(request, route.bodyLimit) : undefined,
    duplex: "half",
  });
}

async function readJson(webRequestValue) {
  if (!webRequestValue.body) return {};
  const chunks = [];
  const reader = webRequestValue.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid request body");
  }
}

function checkedCookieName(name) {
  if (typeof name !== "string" || !COOKIE_NAME.test(name))
    throw new Error(`Invalid cookie name: ${String(name)}`);
  if (name === SESSION_COOKIE)
    throw new Error(
      `The ${SESSION_COOKIE} cookie is the session's: use event.session`,
    );
  return name;
}

function sessionAccess(request, response, view) {
  return {
    read: () => readSession(request),
    view: () => view?.(readSession(request)) ?? {},
    write(session) {
      session.updatedAt = Date.now();
      writeSession(response, session);
    },
    clear: () => clearSession(response),
    useForRequest: (session) => setRequestSession(request, session),
  };
}

/**
 * The name a module's sealed cookie takes in the jar. The module that owns
 * sign-in (`registerAuth`) names its own, the `dms_*` ones included; any other
 * module's are prefixed with its id and a dot, which no name of the owner's
 * holds, so no module reads or overwrites another's, nor the owner's session
 * and account cookies.
 */
function moduleCookieName(name, moduleId, authOwner) {
  const checked = checkedCookieName(name);
  if (moduleId === authOwner) return checked;
  if (checked.startsWith(RESERVED_COOKIE_PREFIX))
    throw new Error(
      `The ${RESERVED_COOKIE_PREFIX}* cookies belong to the module that owns sign-in` +
        `${authOwner ? ` (${authOwner})` : ""}: choose another name than ${name}`,
    );
  return `${String(moduleId).replaceAll(/[^A-Za-z0-9_-]/g, "-")}.${checked}`;
}

function cookieAccess(request, response, moduleId, authOwner) {
  const named = (name) => moduleCookieName(name, moduleId, authOwner);
  return {
    readSealed: (name) => readSealedCookie(request, named(name)),
    writeSealed: (name, value, options = {}) =>
      writeSealedCookie(
        response,
        named(name),
        value,
        options.maxAge,
        options.path ?? "/",
      ),
    clear: (name, options = {}) =>
      clearSealedCookie(response, named(name), options.path ?? "/"),
  };
}

function frozenCopy(value) {
  return Object.freeze(structuredClone(value ?? {}));
}

/**
 * The event a handler receives.
 *
 * @param context `{ request, response, route, params, module, app, view,
 *   authOwner }`, where `module` is `{ id, options, privateOptions }`, `app`
 *   the deployment's read-only data, `view` what a session shows a page and
 *   `authOwner` the id of the module that owns sign-in
 */
export function createServerEvent(context) {
  const { request, response, route, params } = context;
  const event = {
    request: webRequest(request, route),
    params: Object.freeze({ ...params }),
    session: sessionAccess(request, response, context.view),
    cookies: cookieAccess(
      request,
      response,
      context.module.id,
      context.authOwner,
    ),
    backend: (path, init = {}) => backend(path, request, init),
    backendUrl: (path) => backendUrl(path),
    clientIp: () => clientIp(request),
    module: Object.freeze({
      id: context.module.id,
      options: frozenCopy(context.module.options),
      privateOptions: frozenCopy(context.module.privateOptions),
    }),
    renderEmail: (template, props, options = {}) =>
      renderEmailTemplate(template, props, options),
    app: Object.freeze({
      authEstablishEndpoints: Object.freeze([
        ...(context.app?.authEstablishEndpoints ?? []),
      ]),
    }),
  };
  event.url = new URL(event.request.url);
  event.readJson = () => readJson(event.request);
  return event;
}

function isResponse(value) {
  return (
    value instanceof Response ||
    (typeof value === "object" &&
      value !== null &&
      typeof value.status === "number" &&
      typeof value.headers?.get === "function" &&
      "body" in value)
  );
}

function asResponse(result) {
  if (isResponse(result)) return result;
  if (result === undefined || result === null)
    return new Response(null, { status: 204 });
  return Response.json(result);
}

/**
 * Writes a handler's answer. The cookies the event wrote are already on the
 * Node response; those of a returned `Response` are added to them. A backend
 * answer the handler relays goes out as the proxy relays one: its `Location`
 * on the frontend's origin, no cookie of another site its fetch reached.
 */
async function writeServerResponse(request, response, result) {
  const answer = asResponse(result);
  const cookies = [response.getHeader("set-cookie") ?? []]
    .flat()
    .concat(relayableCookies(answer));
  answer.headers.forEach((value, name) => {
    if (name === "set-cookie") return;
    response.setHeader(
      name,
      name === "location" && isBackendUrl(answer.url)
        ? relayedLocation(value, answer.url)
        : value,
    );
  });
  if (cookies.length) response.setHeader("set-cookie", cookies);
  if (!answer.headers.has("cache-control"))
    response.setHeader("cache-control", "no-store");
  response.writeHead(answer.status, answer.statusText || undefined);
  if (!answer.body || request.method === "HEAD") {
    await answer.body?.cancel();
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(answer.body), response);
}

/**
 * Answers a request with the module route it reached. The route's defaults
 * apply first: a request with a state-changing method needs the frontend's
 * own `Origin` unless the route says otherwise. An error the handler lets
 * through reaches the server's error handling with the cookies written so
 * far.
 *
 * @param context See `createServerEvent`
 */
export async function answerModuleRoute(context) {
  const { request, response, route } = context;
  if (
    route.sameOrigin &&
    !SAFE_METHODS.has(request.method) &&
    !isSameOrigin(request)
  ) {
    json(response, 403, CROSS_ORIGIN_ERROR);
    return;
  }
  const event = createServerEvent(context);
  const result = await route.handler(event);
  await writeServerResponse(request, response, result);
}

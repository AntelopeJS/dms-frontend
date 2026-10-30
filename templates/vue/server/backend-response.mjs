import { GENERIC_ERROR_MESSAGE } from "./auth/backend.mjs";
import { isFrontendVisit, redirectFrontendVisit } from "./inertia.mjs";
import { isString } from "./type-guards.mjs";

/**
 * What a JSON caller gets when the backend fails: the generic i18n key of
 * the API error contract. A page gets the status code alone, which the DMS
 * error page describes in the visitor's language; the technical cause only
 * reaches the server log.
 */
export const UNEXPECTED_ERROR_BODY = { message: GENERIC_ERROR_MESSAGE };
/**
 * A typed refusal carries a machine-readable i18n key as its body, bare or
 * JSON-encoded, e.g. `saas.errors.workspace.access_blocked`.
 */
const REFUSAL_CODE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i;
const REFUSAL_CODE_MAX_LENGTH = 200;
const FORBIDDEN = 403;
const FRONTEND_ORIGIN = "http://frontend.local";

export class BackendResponseError extends Error {
  /**
   * @param {number} status
   * @param {string | undefined} code The typed refusal code of the answer
   */
  constructor(status, code) {
    super(`DMS backend returned ${status}`);
    this.status = status;
    this.code = code;
  }
}

/**
 * The refusal code in a backend answer: the string or the `message` of its
 * JSON body, or the body itself when it is not JSON (a bare code).
 *
 * @param {Response} response
 * @returns {Promise<string | undefined>}
 */
async function refusalCode(response) {
  const text = (await response.text().catch(() => "")).trim();
  if (text.length > REFUSAL_CODE_MAX_LENGTH) return undefined;
  /** @type {unknown} */
  let value = text;
  try {
    /** @type {unknown} */
    const data = JSON.parse(text);
    value = isString(data) ? data : data?.message;
  } catch {}
  return isString(value) && REFUSAL_CODE.test(value) ? value : undefined;
}

/**
 * The error for a failed backend response, with its typed code if any.
 *
 * @param {Response} response
 */
export async function backendResponseError(response) {
  return new BackendResponseError(response.status, await refusalCode(response));
}

/**
 * Redirect a page visit the backend refused with a typed 403 (a suspended
 * workspace, say) to the path a frontend module registered for its code
 * through the SDK's `registerAccessRedirect`, looked up in the SSR renderer
 * `loadRenderer` resolves. Only a same-origin path other than the refused one
 * qualifies: a refused destination sent to itself again would loop.
 *
 * @param {unknown} error What the request failed with
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {() => Promise<typeof import("../ssr-renderer.ts")>} loadRenderer
 * @returns {Promise<boolean>} Whether the visit was redirected
 */
export async function redirectAccessRefusal(
  error,
  request,
  response,
  loadRenderer,
) {
  if (
    !isFrontendVisit(request) ||
    !(error instanceof BackendResponseError) ||
    error.status !== FORBIDDEN ||
    !error.code
  )
    return false;
  /** @type {string | undefined} */
  let location;
  try {
    location = (await loadRenderer()).accessRedirect?.(error.code);
  } catch (rendererError) {
    console.error("DMS access redirect lookup failed", rendererError);
    return false;
  }
  if (!location) return false;
  const target = new URL(location, FRONTEND_ORIGIN);
  const refused = new URL(request.url, FRONTEND_ORIGIN);
  if (target.origin !== FRONTEND_ORIGIN || target.pathname === refused.pathname)
    return false;
  redirectFrontendVisit(request, response, location);
  return true;
}

// Reading a failed DMS backend response for the page a visitor gets instead.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows.

import { GENERIC_ERROR_MESSAGE } from "./auth/backend.mjs";
import { isFrontendVisit, redirectFrontendVisit } from "./inertia.mjs";

// What a visitor sees when the backend fails: the technical cause only reaches
// the server log. A page gets the SSR renderer's unexpected-error wording, a
// JSON caller the generic i18n key of the API error contract.
export const UNEXPECTED_ERROR = {
  statusMessage: "Application error",
  message: "An unexpected error occurred",
};
export const UNEXPECTED_ERROR_BODY = { message: GENERIC_ERROR_MESSAGE };
// A typed refusal carries a machine-readable i18n key as its body, bare or
// JSON-encoded, e.g. `saas.errors.workspace.access_blocked`.
const REFUSAL_CODE = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/i;
const REFUSAL_CODE_MAX_LENGTH = 200;
const FORBIDDEN = 403;
const FRONTEND_ORIGIN = "http://frontend.local";

export class BackendResponseError extends Error {
  constructor(status, code) {
    super(`DMS backend returned ${status}`);
    this.status = status;
    this.code = code;
  }
}

async function refusalCode(response) {
  const text = (await response.text().catch(() => "")).trim();
  if (text.length > REFUSAL_CODE_MAX_LENGTH) return undefined;
  let value = text;
  try {
    const data = JSON.parse(text);
    value = typeof data === "string" ? data : data?.message;
  } catch {
    // A bare code.
  }
  return typeof value === "string" && REFUSAL_CODE.test(value)
    ? value
    : undefined;
}

/** The error for a failed backend response, with its typed code if any. */
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
 * @returns Whether the visit was redirected
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

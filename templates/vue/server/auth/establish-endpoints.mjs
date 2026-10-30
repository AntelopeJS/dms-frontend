import { readFileSync } from "node:fs";
import { isString } from "../type-guards.mjs";

/**
 * Absolute backend API paths only: no scheme, no authority, no query string,
 * and no segment that could climb out of `/api/`.
 */
const BACKEND_API_PATH =
  /^\/api\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;

/**
 * Written at the workspace root by the loader, from the endpoints each
 * backend module declared in the frontend manifest. This file sits two
 * directories up.
 */
const DECLARED_ENDPOINTS_FILE = new URL(
  "../../generated-auth-establish.json",
  import.meta.url,
);

/** @type {unknown[] | undefined} */
let declaredEndpoints;

/**
 * Backend endpoints the modules of this deployment declared as session-opening.
 *
 * Read from the workspace rather than from the backend: the file is generated
 * when the workspace is materialized, so the server needs no backend round trip
 * — and no operator — to know which module flows may end on a login. A
 * workspace built from a DMS that predates the declaration simply has no file,
 * and the list falls back to whatever the environment names.
 *
 * @param {URL | string} [file] Generated file to read
 * @returns {unknown[]} The declared paths, unfiltered
 */
export function readDeclaredEstablishEndpoints(file = DECLARED_ENDPOINTS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.endpoints) ? parsed.endpoints : [];
  } catch {
    return [];
  }
}

/**
 * Backend endpoints this deployment lets a module open a session from.
 *
 * The union of what the backend's modules declared — the standard case, which
 * needs no configuration — and what the environment adds on top, which is how
 * an operator extends the list for a route no module owns. Everything else
 * stays refused, so no backend endpoint that happens to mint a token pair can
 * be turned into a login by a request from the browser.
 *
 * The backend endpoints a module may open a session from: what the backend's
 * modules declared in the frontend manifest, and what the environment adds
 * (`DMS_AUTH_ESTABLISH_ENDPOINTS`). The module that owns sign-in reads them as
 * `event.app.authEstablishEndpoints`.
 *
 * @param {string} [declaration] Comma-separated absolute backend paths from the environment
 * @param {unknown[]} [declared] Paths declared by the backend's frontend modules
 * @returns The well-formed backend API paths, without duplicates
 */
export function allowedEstablishEndpoints(
  declaration = process.env.DMS_AUTH_ESTABLISH_ENDPOINTS,
  declared = (declaredEndpoints ??= readDeclaredEstablishEndpoints()),
) {
  const fromEnvironment = (declaration ?? "")
    .split(",")
    .map((entry) => entry.trim());
  return [
    ...new Set(
      [...declared, ...fromEnvironment].filter(
        (entry) => isString(entry) && BACKEND_API_PATH.test(entry),
      ),
    ),
  ];
}

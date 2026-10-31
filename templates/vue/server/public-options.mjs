import { isNonNullObject } from "./type-guards.mjs";

const VARIABLE = "DMS_PUBLIC_OPTIONS";
export const PUBLIC_OPTIONS_ELEMENT_ID = "dms-public-options";

/**
 * The registry the workspace was materialized with.
 *
 * @typedef {object} FrontendRegistry
 * @property {{ id: string, options?: unknown }[]} modules The modules, highest priority first
 */

/**
 * @param {string | undefined} raw
 * @returns {object | undefined}
 */
function parse(raw) {
  if (!raw) return undefined;
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(raw);
    return isNonNullObject(parsed) && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    console.warn(`${VARIABLE} is not a JSON object of options by module id`);
    return undefined;
  }
}

/**
 * The options by module id the server runs with, undefined when unset.
 *
 * The modules' public options the running server serves: computed by `ajs
 * dms start` from the project's configuration and handed over in
 * `DMS_PUBLIC_OPTIONS`, a JSON object of options by module id. A build never
 * holds them, so a deployment's variables reach the dashboard without a
 * rebuild. Unset (`ajs dms dev`), the registry's options stand.
 */
export const RUNTIME_PUBLIC_OPTIONS = parse(process.env[VARIABLE]);

/**
 * The options of each module of the registry, the runtime ones first.
 *
 * @param {FrontendRegistry} registry
 */
export function publicOptionsOf(registry) {
  return Object.fromEntries(
    registry.modules.map((module) => [
      module.id,
      RUNTIME_PUBLIC_OPTIONS?.[module.id] ?? module.options,
    ]),
  );
}

/**
 * The script a page document carries the runtime options in, for the
 * browser's setup of the modules; nothing when the build's options stand.
 */
export function publicOptionsScript() {
  if (!RUNTIME_PUBLIC_OPTIONS) return "";
  const value = JSON.stringify(RUNTIME_PUBLIC_OPTIONS).replaceAll(
    "<",
    "\\u003c",
  );
  return `<script id="${PUBLIC_OPTIONS_ELEMENT_ID}" type="application/json">${value}</script>`;
}

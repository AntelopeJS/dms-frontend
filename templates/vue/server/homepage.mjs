import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { frontendRegistryOf } from "./generated-files.mjs";
import { publicOptionsOf } from "./public-options.mjs";
import { isRecord, isString } from "./type-guards.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = join(PROJECT_ROOT, "generated-frontend-modules.json");
const REGISTRY = frontendRegistryOf(
  existsSync(REGISTRY_PATH)
    ? JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
    : { modules: [] },
);

/**
 * @param {Readonly<Record<string, unknown>>} options
 * @returns {string | undefined}
 */
function findHomepage(options) {
  if (isString(options.homepage)) return options.homepage;
  for (const child of Object.values(options)) {
    const homepage = isRecord(child) ? findHomepage(child) : undefined;
    if (homepage !== undefined) return homepage;
  }
  return undefined;
}

const OPTIONS = publicOptionsOf(REGISTRY);

/**
 * Works out which page a visit to `/` means. The answer lives in the module
 * registry the workspace was materialized with: a module declares `homepage`
 * somewhere in its options, at whatever depth its own configuration shape
 * puts it, and the highest-priority declaration wins, since the registry is
 * already sorted. Read once at boot, because the registry is a build
 * artifact and cannot change while the server is up.
 */
export const HOMEPAGE =
  REGISTRY.modules
    .map((module) => {
      const options = OPTIONS[module.id];
      return isRecord(options) ? findHomepage(options) : undefined;
    })
    .find(Boolean) ?? "/";

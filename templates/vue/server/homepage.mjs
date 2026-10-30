import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { publicOptionsOf } from "./public-options.mjs";
import { isNonNullObject, isString } from "./type-guards.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = join(PROJECT_ROOT, "generated-frontend-modules.json");
const REGISTRY = existsSync(REGISTRY_PATH)
  ? JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
  : { modules: [] };

function findHomepage(options) {
  if (!isNonNullObject(options)) return undefined;
  if (isString(options.homepage)) return options.homepage;
  return Object.values(options)
    .map(findHomepage)
    .find((homepage) => homepage !== undefined);
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
    .map((module) => findHomepage(OPTIONS[module.id]))
    .find(Boolean) ?? "/";

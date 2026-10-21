// Working out which page a visit to `/` means.
//
// The answer lives in the module registry the workspace was materialized with:
// a module declares `homepage` somewhere in its options, at whatever depth its
// own configuration shape puts it, and the highest-priority declaration wins —
// the registry is already sorted. Read once at boot, because the registry is a
// build artifact and cannot change while the server is up.
//
// Split out of server.mjs, whose size the linter caps.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REGISTRY_PATH = join(PROJECT_ROOT, "generated-frontend-modules.json");
const REGISTRY = existsSync(REGISTRY_PATH)
  ? JSON.parse(readFileSync(REGISTRY_PATH, "utf8"))
  : { modules: [] };

function findHomepage(options) {
  if (!options || typeof options !== "object") return undefined;
  if (typeof options.homepage === "string") return options.homepage;
  return Object.values(options)
    .map(findHomepage)
    .find((homepage) => homepage !== undefined);
}

export const HOMEPAGE =
  REGISTRY.modules
    .map((module) => findHomepage(module.options))
    .find(Boolean) ?? "/";

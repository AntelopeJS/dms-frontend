import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ENVIRONMENT_VARIABLES } from "../../src/help";
import { type Problem, ROOT, type SourceCheck } from "./repository";

/**
 * Set by the CLI for the processes it spawns, never by a user: dev mode for
 * the generated server, the verify-source runner's inputs, and the Vite and
 * Node settings of a build.
 */
const INTERNAL_VARIABLES = new Set([
  "DMS_DEV",
  "DMS_LAYER_SOURCE",
  "DMS_MODULE_SOURCES",
  "DMS_LOCAL_PACKAGES",
  "DMS_VITE_LOG_LEVEL",
  "DMS_PUBLIC_OPTIONS",
  "NODE_OPTIONS",
]);

const ENV_READ =
  /process\.env\.([A-Z][A-Z0-9_]*)|\.env\("([A-Z][A-Z0-9_]*)"\)|flagOrEnv\([^,]+, "([A-Z][A-Z0-9_]*)"\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

function helpListsEveryVariableRead(): Problem[] {
  const documented = new Set(
    ENVIRONMENT_VARIABLES.flatMap(([names]) => names.split(", ")),
  );
  const read = new Set(
    [join(ROOT, "src"), join(ROOT, "templates")]
      .flatMap(sourceFiles)
      .flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(ENV_READ)].map(
          (match) => match[1] ?? match[2] ?? match[3],
        ),
      ),
  );
  const missing = [...read].filter(
    (name) => !documented.has(name!) && !INTERNAL_VARIABLES.has(name!),
  );
  return [
    ...(read.has("DMS_PREPARE_STRICT")
      ? []
      : ["the environment scan no longer sees DMS_PREPARE_STRICT"]),
    ...missing.map(
      (name) =>
        `${name} is read by the CLI or the generated server but missing from ENVIRONMENT_VARIABLES (src/help.ts)`,
    ),
  ];
}

function manifestPublishesOnlyTheDiscoverableExecutable(): Problem[] {
  const manifest: { name?: unknown; bin?: unknown } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  return [
    ...(manifest.name === "@antelopejs/dms-frontend"
      ? []
      : [`package.json is named ${JSON.stringify(manifest.name)}`]),
    ...(isDeepStrictEqual(manifest.bin, { "ajs-dms": "./dist/index.js" })
      ? []
      : [`package.json bin is ${JSON.stringify(manifest.bin)}`]),
  ];
}

function manifestRequiresTheAntelopeJsCli(): Problem[] {
  const manifest: {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: unknown;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return [
    ...(manifest.peerDependencies?.["@antelopejs/core"] === ">=1.16.0 <2"
      ? []
      : ["package.json must require @antelopejs/core >=1.16.0 <2 as a peer"]),
    ...(manifest.peerDependenciesMeta === undefined
      ? []
      : ["package.json must not make a peer dependency optional"]),
    ...["figlet", "boxen", "chalk", "@types/figlet"].flatMap((dependency) =>
      [manifest.dependencies, manifest.devDependencies].flatMap((group) =>
        group?.[dependency] === undefined
          ? []
          : [
              `package.json must not depend on ${dependency}: the core output module draws the banner`,
            ],
      ),
    ),
  ];
}

interface EntryConditions {
  types: string;
  default: string;
}

/**
 * Adding `exports` to a package that had none is where a deep import turns
 * into a resolution error. Consumers import `@antelopejs/dms-frontend/dist/
 * common.js` today, so the wildcards that keep those paths reachable are
 * part of the contract, not a detail of the map.
 */
function manifestKeepsTheDeepPathsReachable(): Problem[] {
  const {
    exports: map,
  }: { exports: Record<string, string | EntryConditions> } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8"),
  );
  const expected = {
    "./dist/*.js": { types: "./dist/*.d.ts", default: "./dist/*.js" },
    "./dist/*": "./dist/*",
    "./templates/*": "./templates/*",
    "./package.json": "./package.json",
    "./common": { types: "./dist/common.d.ts", default: "./dist/common.js" },
  };
  return Object.entries(expected)
    .filter(([key, value]) => !isDeepStrictEqual(map[key], value))
    .map(
      ([key, value]) =>
        `package.json exports ${key} is ${JSON.stringify(map[key])}, consumers need ${JSON.stringify(value)}`,
    );
}

export const CLI_SURFACE_CHECKS: SourceCheck[] = [
  {
    name: "ajs dms help environment lists every variable the CLI and the generated server read",
    run: helpListsEveryVariableRead,
  },
  {
    name: "the package publishes only the core-discoverable executable",
    run: manifestPublishesOnlyTheDiscoverableExecutable,
  },
  {
    name: "the package keeps the deep dist and templates paths reachable",
    run: manifestKeepsTheDeepPathsReachable,
  },
  {
    name: "the package requires the AntelopeJS CLI that publishes its output module",
    run: manifestRequiresTheAntelopeJsCli,
  },
];

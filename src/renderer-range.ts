// Refusing a frontend module that declares it does not run on this loader
// release, before a workspace is built from it.
//
// A module declares the releases it supports the way a package declares the
// Node.js versions it runs on: `engines["@antelopejs/dms-frontend"]` in its own
// package.json. The loader reads it from the module's files because they are
// the one input `prepare`, `dev`, `build` and `verify-source` all have: the
// last compiles module sources without any backend, so a declaration that only
// reached the loader through the manifest would never be seen there.
//
// Not a peer dependency: the generated workspace installs every module as a
// workspace package, and pnpm installs a workspace package's peers, optional
// ones included, so a peer on the loader would pull a copy of it into every
// workspace. Package managers ignore an engine they do not know.

import semver from "semver";
import { readLayerPackage } from "./layers";
import { ResolvedLayer } from "./workspace";

/** The loader a module's range is checked against: a package name and release. */
export interface RendererRelease {
  name: string;
  version: string;
}

export interface RendererRangeCheckOptions {
  /** Release to check against; defaults to this package's own. */
  renderer?: RendererRelease;
  /** Where the notice about modules declaring no range goes. */
  warn?: (message: string) => void;
}

interface DeclaredRange {
  module: string;
  range: unknown;
}

const OWN_RELEASE: RendererRelease = require("../package.json");

/**
 * Modules already named in an undeclared-range notice. A process only ever
 * loads one set of modules, so repeating the notice would add nothing.
 */
const noticedModules = new Set<string>();

/**
 * A module as the messages name it: its package name and where it was loaded
 * from, since two layers may share a name (every playground layer is
 * `playground-frontend-vue`).
 */
function moduleLabel(layer: ResolvedLayer): string {
  if (!layer.packageName) return layer.path;
  return `${layer.packageName} (${layer.path})`;
}

function declaredRange(
  layer: ResolvedLayer,
  rendererName: string,
): DeclaredRange {
  return {
    module: moduleLabel(layer),
    range: readLayerPackage(layer.path)?.engines?.[rendererName],
  };
}

/**
 * A prerelease is checked as the release it leads to: `0.4.0-next.1` belongs to
 * the 0.4 line, which a module declaring `<0.4.0` has never been run against,
 * even though semver orders it below 0.4.0.
 */
function releaseLine(version: string): string {
  return semver.coerce(version)?.version ?? version;
}

function describeProblem(
  declaration: DeclaredRange,
  version: string,
): string | undefined {
  const { module, range } = declaration;
  if (typeof range !== "string" || semver.validRange(range) === null)
    return `${module} declares an unreadable range: ${JSON.stringify(range)}`;
  if (semver.satisfies(releaseLine(version), range)) return undefined;
  return `${module} supports ${range}`;
}

function noticeUndeclared(
  declarations: DeclaredRange[],
  renderer: RendererRelease,
  warn: (message: string) => void,
): void {
  const modules = declarations
    .filter(({ range }) => range === undefined)
    .map(({ module }) => module)
    .filter((module) => !noticedModules.has(module));
  if (modules.length === 0) return;
  for (const module of modules) noticedModules.add(module);
  warn(
    `⚠ No supported ${renderer.name} range declared, so not checked against ` +
      `${renderer.version}: ${modules.join(", ")}. A frontend module declares ` +
      `one in its package.json, under engines["${renderer.name}"].`,
  );
}

/**
 * Fail unless every module supports this loader release.
 *
 * A module that declares no range is still loaded, so a module published before
 * the declaration existed keeps working; it is named once in a notice instead.
 * One that declares a range this release falls outside of, or a range that
 * cannot be read, stops the command here rather than later, in the middle of
 * a build or a render, on an API this release no longer has or does not have
 * yet.
 *
 * @param layers Resolved modules, each read from its own package.json
 * @param options Release to check against and notice sink, for tests
 */
export function assertLayersSupportRenderer(
  layers: ResolvedLayer[],
  options: RendererRangeCheckOptions = {},
): void {
  const renderer = options.renderer ?? OWN_RELEASE;
  const declarations = layers.map((layer) =>
    declaredRange(layer, renderer.name),
  );
  noticeUndeclared(declarations, renderer, options.warn ?? console.warn);
  const problems = declarations
    .filter(({ range }) => range !== undefined)
    .map((declaration) => describeProblem(declaration, renderer.version))
    .filter((problem) => problem !== undefined);
  if (problems.length === 0) return;
  throw new Error(
    `These frontend modules do not run on ${renderer.name} ${renderer.version}:\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      `\nInstall a ${renderer.name} release their ranges allow, or upgrade those ` +
      `modules to releases that support ${renderer.version}.`,
  );
}

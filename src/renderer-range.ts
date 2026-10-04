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

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CliError,
  getProcessUi,
  type MessageOptions,
} from "@antelopejs/core/cli";
import semver from "semver";
import { readLayerPackage } from "./layers";
import { showPath } from "./output";
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
  warn?: (text: string, options: MessageOptions) => void;
  /**
   * Workspace that remembers the modules already named in that notice, so it
   * shows once per workspace rather than on every run.
   */
  workspaceDir?: string;
}

interface DeclaredRange {
  /** Names the module in the workspace's record of notices. */
  module: string;
  /** Names it in messages, its directory as the user reads it. */
  shown: string;
  range: unknown;
}

const OWN_RELEASE: RendererRelease = require("../package.json");

/** The core's indent under a problem's title, continued by a reason of several lines. */
const DETAIL_INDENT = "  ";

/**
 * Modules already named in an undeclared-range notice. A process only ever
 * loads one set of modules, so repeating the notice would add nothing.
 */
const noticedModules = new Set<string>();

/** Modules a workspace has named in the notice, one label per line. */
const NOTICED_MODULES_FILE = ".renderer-range-noticed";

function readNoticedModules(workspaceDir: string | undefined): Set<string> {
  const file = workspaceDir && join(workspaceDir, NOTICED_MODULES_FILE);
  if (!file || !existsSync(file)) return new Set();
  return new Set(readFileSync(file, "utf8").split("\n").filter(Boolean));
}

function saveNoticedModules(
  workspaceDir: string | undefined,
  modules: Set<string>,
): void {
  if (!workspaceDir) return;
  writeFileSync(
    join(workspaceDir, NOTICED_MODULES_FILE),
    [...modules].map((module) => `${module}\n`).join(""),
  );
}

/**
 * A module as the messages name it: its package name and where it was loaded
 * from, since two layers may share a name (every playground layer is
 * `playground-frontend-vue`).
 */
function moduleLabel(layer: ResolvedLayer): string {
  if (!layer.packageName) return layer.path;
  return `${layer.packageName} (${layer.path})`;
}

/** A module as messages show it: from its source when the manifest named it. */
function shownModule(layer: ResolvedLayer): string {
  const where = showPath(layer.sourcePath ?? layer.path);
  return layer.packageName ? `${layer.packageName} (${where})` : where;
}

function declaredRange(
  layer: ResolvedLayer,
  rendererName: string,
): DeclaredRange {
  return {
    module: moduleLabel(layer),
    shown: shownModule(layer),
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
  const { shown, range } = declaration;
  if (typeof range !== "string" || semver.validRange(range) === null)
    return `${shown} declares an unreadable range: ${JSON.stringify(range)}`;
  if (semver.satisfies(releaseLine(version), range)) return undefined;
  return `${shown} supports ${range}`;
}

function noticeUndeclared(
  declarations: DeclaredRange[],
  renderer: RendererRelease,
  warn: (text: string, options: MessageOptions) => void,
  workspaceDir: string | undefined,
): void {
  const remembered = readNoticedModules(workspaceDir);
  const undeclared = declarations
    .filter(({ range }) => range === undefined)
    .filter(
      ({ module }) => !noticedModules.has(module) && !remembered.has(module),
    );
  if (undeclared.length === 0) return;
  for (const { module } of undeclared) {
    noticedModules.add(module);
    remembered.add(module);
  }
  saveNoticedModules(workspaceDir, remembered);
  const hint = getProcessUi().symbols.levels.hint;
  warn(
    `No supported ${renderer.name} range declared, so not checked against ${renderer.version}`,
    {
      details: [
        ...undeclared.map(({ shown }) => shown),
        `${hint} Declare one in its package.json, under engines["${renderer.name}"]`,
      ],
    },
  );
}

/**
 * Fail unless every module supports this loader release.
 *
 * A module that declares no range is still loaded, so a module published before
 * the declaration existed keeps working; it is named once in a notice instead,
 * once per workspace when one is given.
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
  noticeUndeclared(
    declarations,
    renderer,
    options.warn ??
      ((text, messageOptions) =>
        getProcessUi().message("warn", text, messageOptions)),
    options.workspaceDir,
  );
  const problems = declarations
    .filter(({ range }) => range !== undefined)
    .map((declaration) => describeProblem(declaration, renderer.version))
    .filter((problem) => problem !== undefined);
  if (problems.length === 0) return;
  throw new CliError({
    title: `These frontend modules do not run on ${renderer.name} ${renderer.version}`,
    reason: problems.join(`\n${DETAIL_INDENT}`),
    fixes: [
      `Install a ${renderer.name} release in their ranges, or upgrade the modules`,
    ],
  });
}

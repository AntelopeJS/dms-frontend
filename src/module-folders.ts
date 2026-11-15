import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import semver from "semver";
import { isObjectLike, isText } from "./internal/guards";

/** AntelopeJS's record of the package versions its module cache holds. */
const CACHE_MANIFEST_FILE = "manifest.json";
/** Where AntelopeJS records the lockfile of each package version a project runs. */
const LOCK_FOLDER = "antelope-lock";

/** A module's source in the project's configuration, as AntelopeJS's config loader returns it. */
export interface ModuleSource {
  type: string;
  path?: string;
  package?: string;
  version?: string;
  remote?: string;
}

/** The folder AntelopeJS's git downloader clones a remote into, in its module cache. */
function gitCloneName(remote: string): string {
  return remote.replace(/[^a-zA-Z0-9_]/g, "_");
}

/** The folder AntelopeJS's package downloader installs a version into, in its module cache. */
function packageCacheEntry(pkg: string, version: string): string {
  return `${pkg}@${semver.valid(version) ?? version}`;
}

/** The versions of a package that AntelopeJS's module cache manifest records, lowest first. */
function cachedVersions(cache: string, pkg: string): string[] {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(cache, CACHE_MANIFEST_FILE), "utf-8"),
    );
  } catch {
    return [];
  }
  if (!isObjectLike(manifest)) return [];
  return semver.sort(
    Object.entries(manifest).flatMap(([entry, version]) =>
      isText(version) &&
      semver.valid(version) &&
      entry === packageCacheEntry(pkg, version)
        ? [version]
        : [],
    ),
  );
}

/** The versions of a package that the project's `antelope-lock/` records, as AntelopeJS's lock store lists them. */
function lockedVersions(projectDir: string, pkg: string): string[] {
  const record = join(projectDir, LOCK_FOLDER, pkg);
  const prefix = `${basename(record)}@`;
  let names: string[];
  try {
    names = readdirSync(dirname(record));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const version = name.startsWith(prefix)
      ? semver.valid(name.slice(prefix.length))
      : null;
    return version ? [version] : [];
  });
}

/**
 * The version AntelopeJS's package downloader runs for a version spec, short
 * of asking the registry: an exact version as is, for a range the highest
 * that `antelope-lock/` records in it, else the highest cached in range, and
 * for a tag the highest cached, stable only for `latest`.
 */
function resolvedVersion(
  projectDir: string,
  cache: string,
  pkg: string,
  spec: string | undefined,
): string | undefined {
  const exact = semver.valid(spec);
  if (exact) return exact;
  const range = semver.validRange(spec);
  const locked = range
    ? semver.maxSatisfying(lockedVersions(projectDir, pkg), range)
    : null;
  if (locked) return locked;
  const cached = cachedVersions(cache, pkg);
  if (range) return semver.maxSatisfying(cached, range) ?? undefined;
  const stable = spec === "latest" ? semver.maxSatisfying(cached, "*") : null;
  return stable ?? cached[cached.length - 1];
}

function moduleFolderCandidates(
  projectDir: string,
  cacheFolder: string,
  source: ModuleSource,
): string[] {
  const cache = resolve(projectDir, cacheFolder);
  if (source.type === "local" && source.path)
    return [resolve(projectDir, source.path)];
  if (source.type === "git" && source.remote)
    return [join(cache, gitCloneName(source.remote))];
  if (!source.package) return [];
  const version = resolvedVersion(
    projectDir,
    cache,
    source.package,
    source.version,
  );
  return [
    ...(version
      ? [join(cache, packageCacheEntry(source.package, version))]
      : []),
    join(projectDir, "node_modules", source.package),
  ];
}

/**
 * Where a module's package is: a local source's path, a git source's clone in
 * AntelopeJS's module cache, or the version of a package that cache holds for
 * the source's version spec, else the package installed in the project's
 * node_modules.
 */
export function moduleFolder(
  projectDir: string,
  cacheFolder: string,
  source: ModuleSource,
): string | undefined {
  return moduleFolderCandidates(projectDir, cacheFolder, source).find(
    (folder) => existsSync(join(folder, "package.json")),
  );
}

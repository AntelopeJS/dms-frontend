import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import semver from "semver";
import { isObjectLike, isText } from "./internal/guards";

/** AntelopeJS's record of the package versions its module cache holds. */
const CACHE_MANIFEST_FILE = "manifest.json";

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

/**
 * The cached version AntelopeJS runs for a version spec when the registry
 * cannot be asked: the highest in range, or for a tag the highest cached,
 * stable only for `latest`.
 */
function pickCachedVersion(
  versions: string[],
  spec: string,
): string | undefined {
  const range = semver.validRange(spec);
  if (range) return semver.maxSatisfying(versions, range) ?? undefined;
  const stable = spec === "latest" ? semver.maxSatisfying(versions, "*") : null;
  return stable ?? versions[versions.length - 1];
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
  const version = pickCachedVersion(
    cachedVersions(cache, source.package),
    source.version ?? "latest",
  );
  return [
    join(projectDir, "node_modules", source.package),
    ...(version
      ? [join(cache, packageCacheEntry(source.package, version))]
      : []),
  ];
}

/**
 * Where a module's package is: a local source's path, a git source's clone in
 * AntelopeJS's module cache, or a package installed in the project's
 * node_modules, else the version of it that cache holds for the source's
 * version spec.
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

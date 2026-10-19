// A snapshot: what a production build needs from the backend, taken once and
// kept with the project, so that the build itself reaches no backend and holds
// no credential. It is the manifest, with every private value emptied, and the
// layer sources the backend archives, extracted.
//
// The build and its output never carry a secret: the server reads its own
// (`DMS_SESSION_SECRET`, `DMS_HTML_RENDER_SECRET`, `DMS_OAUTH_RELAY_SECRET`)
// from its environment when it starts.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import { canonicalizeBackendUrl } from "./config";
import { moduleSetFingerprint } from "./module-set";
import { withoutPrivateValues } from "./private-values";
import type { Manifest, ManifestModule } from "./workspace";

/** The snapshot's description, next to its `layers/` directory. */
export const SNAPSHOT_FILE = "snapshot.json";
/** The extracted layer sources, one directory per module's `archiveName`. */
export const SNAPSHOT_LAYERS_DIR = "layers";
/** Where a build records the module set it was made from, for `start`. */
export const BUILD_ORIGIN_FILE = ".build-origin.json";

const SNAPSHOT_FORMAT = 1;
const DIGEST_LENGTH = 16;

export interface FrontendSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  /** The backend the snapshot was taken from, canonical. */
  backendUrl: string;
  /** When it was taken, ISO 8601. */
  takenAt: string;
  /** {@link manifestDigest} of its modules. */
  digest: string;
  /** The manifest the backend served, private values emptied. */
  manifest: Manifest;
}

/** What a build was made from, as `start` reads it back. */
export interface BuildOrigin {
  /** `snapshot` for `build --from`, `backend` for a build that fetched it. */
  source: "snapshot" | "backend";
  backendUrl: string;
  /** When the manifest was taken or fetched, ISO 8601. */
  takenAt: string;
  digest: string;
}

/**
 * A short, stable identity of the module set a manifest serves: the same
 * modules, priorities and routes give the same digest whoever reads it, so a
 * build and the backend it serves can be compared. Option values are left out
 * (see `moduleSetFingerprint`).
 *
 * @param modules The manifest's modules
 */
export function manifestDigest(modules: readonly ManifestModule[]): string {
  return createHash("sha256")
    .update(
      moduleSetFingerprint(modules.map(({ path: _path, ...module }) => module)),
    )
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

/**
 * Writes a snapshot of `manifest` into `dir`, replacing one already there,
 * with the layers extracted under `layersSource`.
 *
 * @param dir Snapshot directory
 * @param backendUrl Backend the manifest came from
 * @param manifest Manifest as the backend served it
 * @param layersSource Directory holding the extracted layers archive
 */
export function writeSnapshot(
  dir: string,
  backendUrl: string,
  manifest: Manifest,
  layersSource: string,
): FrontendSnapshot {
  const modules = withoutPrivateValues(manifest.modules).map(
    ({ path: _path, ...module }) => module,
  );
  const snapshot: FrontendSnapshot = {
    format: SNAPSHOT_FORMAT,
    backendUrl: canonicalizeBackendUrl(backendUrl),
    takenAt: new Date().toISOString(),
    digest: manifestDigest(modules),
    manifest: { pack: manifest.pack, modules },
  };
  mkdirSync(dir, { recursive: true });
  const layers = join(dir, SNAPSHOT_LAYERS_DIR);
  rmSync(layers, { recursive: true, force: true });
  cpSync(layersSource, layers, { recursive: true });
  writeFileSync(
    join(dir, SNAPSHOT_FILE),
    `${JSON.stringify(snapshot, null, 2)}\n`,
  );
  return snapshot;
}

/**
 * Reads the snapshot in `dir`, refusing one this loader cannot build from.
 *
 * @param dir Snapshot directory
 */
export function readSnapshot(dir: string): FrontendSnapshot {
  const file = join(dir, SNAPSHOT_FILE);
  const refresh = "Take one: ajs dms snapshot -b <backend url> -o <dir>";
  if (!existsSync(file)) {
    throw new CliError({
      title: `No snapshot in ${dir}`,
      reason: `${SNAPSHOT_FILE} is missing.`,
      fixes: [refresh],
    });
  }
  let snapshot: Partial<FrontendSnapshot>;
  try {
    snapshot = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliError(
      { title: `${file} is not valid JSON`, fixes: [refresh] },
      { cause: error },
    );
  }
  if (
    snapshot.format !== SNAPSHOT_FORMAT ||
    !Array.isArray(snapshot.manifest?.modules) ||
    typeof snapshot.backendUrl !== "string"
  ) {
    throw new CliError({
      title: `${file} is not a snapshot this loader can build from`,
      reason: `It needs format ${SNAPSHOT_FORMAT}, a backend URL and a manifest.`,
      fixes: [refresh],
    });
  }
  if (!existsSync(join(dir, SNAPSHOT_LAYERS_DIR))) {
    throw new CliError({
      title: `The snapshot in ${dir} has no ${SNAPSHOT_LAYERS_DIR} directory`,
      fixes: [refresh],
    });
  }
  return snapshot as FrontendSnapshot;
}

/** Records what the build in `workspaceDir` was made from. */
export function writeBuildOrigin(workspaceDir: string, origin: BuildOrigin) {
  writeFileSync(
    join(workspaceDir, BUILD_ORIGIN_FILE),
    `${JSON.stringify(origin, null, 2)}\n`,
  );
}

/** What the build in `workspaceDir` was made from, if it recorded it. */
export function readBuildOrigin(workspaceDir: string): BuildOrigin | undefined {
  try {
    const origin = JSON.parse(
      readFileSync(join(workspaceDir, BUILD_ORIGIN_FILE), "utf8"),
    ) as Partial<BuildOrigin>;
    return typeof origin.digest === "string"
      ? (origin as BuildOrigin)
      : undefined;
  } catch {
    return undefined;
  }
}

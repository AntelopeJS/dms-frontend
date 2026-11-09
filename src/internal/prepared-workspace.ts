import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedLayer } from "../workspace";
import { needsInstall } from "../workspace-setup";
import { isText } from "./guards";
import { isPlainObject } from "./plain-object";

const PREPARED_LAYERS_FILE = ".dms-build-layers.json";

/**
 * What a build that skips the setup needs of a layer: where its sources are,
 * so its errors name the file to edit, and what its install hashed.
 *
 * @internal
 */
export type RecordedLayer = Pick<
  ResolvedLayer,
  "path" | "name" | "sourcePath" | "packageName"
>;

/**
 * A production workspace `--prepared` builds as it is, or why it refuses to.
 *
 * @internal
 */
export type PreparedWorkspace =
  | { prepared: true; layers: RecordedLayer[] }
  | { prepared: false; reason: string };

const OPTIONAL_TEXT_KEYS = ["name", "sourcePath", "packageName"] as const;

function isRecordedLayer(value: unknown): value is RecordedLayer {
  return (
    isPlainObject(value) &&
    Object.prototype.hasOwnProperty.call(value, "path") &&
    isText(value.path) &&
    OPTIONAL_TEXT_KEYS.every(
      (key) =>
        !Object.prototype.hasOwnProperty.call(value, key) || isText(value[key]),
    )
  );
}

function recordedLayers(workspaceDir: string): RecordedLayer[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      readFileSync(join(workspaceDir, PREPARED_LAYERS_FILE), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (
    !isPlainObject(parsed) ||
    !Object.prototype.hasOwnProperty.call(parsed, "layers")
  )
    return undefined;
  const { layers } = parsed;
  if (!Array.isArray(layers)) return undefined;
  const listed: unknown[] = layers;
  return listed.every(isRecordedLayer) ? listed : undefined;
}

/**
 * Drops the record of the last setup, before a setup rewrites the workspace:
 * a setup that stops halfway leaves a workspace `--prepared` refuses.
 *
 * @internal
 */
export function forgetPreparedLayers(workspaceDir: string): void {
  rmSync(join(workspaceDir, PREPARED_LAYERS_FILE), { force: true });
}

/**
 * Records the layers a setup wrote into the workspace, once it is done.
 *
 * @internal
 */
export function recordPreparedLayers(
  workspaceDir: string,
  layers: readonly ResolvedLayer[],
): void {
  const recorded: RecordedLayer[] = layers.map(
    ({ path, name, sourcePath, packageName }) => ({
      path,
      name,
      sourcePath,
      packageName,
    }),
  );
  writeFileSync(
    join(workspaceDir, PREPARED_LAYERS_FILE),
    `${JSON.stringify({ layers: recorded }, null, 2)}\n`,
  );
}

/**
 * The workspace a production setup finished, with its dependencies installed
 * for the layers it recorded, or why it is not.
 *
 * @internal
 */
export function readPreparedWorkspace(workspaceDir: string): PreparedWorkspace {
  const layers = recordedLayers(workspaceDir);
  if (!layers)
    return {
      prepared: false,
      reason: "No production setup finished in it.",
    };
  const layerPaths = layers.map((layer) => layer.path);
  if (needsInstall(workspaceDir, layerPaths, false))
    return {
      prepared: false,
      reason: "Its dependencies are not installed, or changed since they were.",
    };
  return { prepared: true, layers };
}

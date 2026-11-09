import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEPS_HASH_FILE } from "../config";
import type { ResolvedLayer } from "../workspace";
import { needsInstall } from "../workspace-setup";
import { isFlag, isText } from "./guards";
import { isPlainObject } from "./plain-object";

const PREPARED_LAYERS_FILE = ".dms-build-layers.json";

/**
 * Where a layer's sources were when the setup copied them, so a build that
 * skips the setup still names the file to edit in its errors.
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

/** What a finished setup records in its workspace. */
interface PreparedRecord {
  /** Whether the install was current for these layers when the setup ended. */
  installed: boolean;
  layers: RecordedLayer[];
}

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

function readRecord(workspaceDir: string): PreparedRecord | undefined {
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
    !Object.prototype.hasOwnProperty.call(parsed, "installed")
  )
    return undefined;
  const { installed } = parsed;
  if (
    !isFlag(installed) ||
    !Object.prototype.hasOwnProperty.call(parsed, "layers")
  )
    return undefined;
  const { layers } = parsed;
  if (!Array.isArray(layers)) return undefined;
  const listed: unknown[] = layers;
  return listed.every(isRecordedLayer)
    ? { installed, layers: listed }
    : undefined;
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
 * Records the layers a setup wrote into the workspace once it is done, and
 * whether its install is current for them. The install is checked now, while
 * the layers' sources are where the setup read them.
 *
 * @internal
 */
export function recordPreparedLayers(
  workspaceDir: string,
  layers: readonly ResolvedLayer[],
): void {
  const record: PreparedRecord = {
    installed: !needsInstall(
      workspaceDir,
      layers.map((layer) => layer.path),
      false,
    ),
    layers: layers.map(({ path, name, sourcePath, packageName }) => ({
      path,
      name,
      sourcePath,
      packageName,
    })),
  };
  writeFileSync(
    join(workspaceDir, PREPARED_LAYERS_FILE),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * The workspace a production setup finished, with its dependencies
 * installed, or why it is not. It reads the workspace alone: neither the
 * project nor the layers' sources.
 *
 * @internal
 */
export function readPreparedWorkspace(workspaceDir: string): PreparedWorkspace {
  const record = readRecord(workspaceDir);
  if (!record)
    return {
      prepared: false,
      reason: "No production setup finished in it.",
    };
  const installed =
    record.installed &&
    existsSync(join(workspaceDir, DEPS_HASH_FILE)) &&
    existsSync(join(workspaceDir, "node_modules"));
  if (!installed)
    return {
      prepared: false,
      reason: "Its dependencies are not installed, or changed since they were.",
    };
  return { prepared: true, layers: record.layers };
}

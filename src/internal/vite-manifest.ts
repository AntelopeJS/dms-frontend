import { CliError } from "@antelopejs/core/cli";
import { isFlag, isText } from "./guards";
import { isPlainObject } from "./plain-object";

/** @internal */
export interface ViteChunk {
  file: string;
  isEntry?: boolean;
}

function isViteChunk(value: unknown): value is ViteChunk {
  return (
    isPlainObject(value) &&
    isText(value.file) &&
    (value.isEntry === undefined || isFlag(value.isEntry))
  );
}

/**
 * The chunks of the manifest Vite writes next to a build.
 *
 * @internal
 * @throws CliError when the manifest is not an object of chunks that name
 *   their file
 */
export function parseViteManifest(content: string, label: string): ViteChunk[] {
  const manifest: unknown = JSON.parse(content);
  const chunks: unknown[] = isPlainObject(manifest)
    ? Object.values(manifest)
    : [];
  if (!isPlainObject(manifest) || !chunks.every(isViteChunk))
    throw new CliError({
      title: `The ${label} is not a Vite manifest`,
      reason: "Every entry of it must name the chunk's file.",
    });
  return chunks;
}

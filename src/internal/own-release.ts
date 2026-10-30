import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isObjectLike, isText } from "./guards";

/** @internal */
export interface OwnRelease {
  name: string;
  version: string;
}

function isOwnRelease(value: unknown): value is OwnRelease {
  return (
    isObjectLike(value) &&
    "name" in value &&
    isText(value.name) &&
    "version" in value &&
    isText(value.version)
  );
}

function readOwnRelease(): OwnRelease {
  const manifest: unknown = JSON.parse(
    readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
  );
  if (!isOwnRelease(manifest))
    throw new Error("The package.json of dms-frontend has no name or version");
  return manifest;
}

/**
 * The package.json of this package: the release the loader reports and checks
 * module ranges against.
 * @internal
 */
export const ownRelease = readOwnRelease();

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { CliError } from "@antelopejs/core/cli";
import { formatSize } from "./output";

/** Read by `ajs dms build`: the threshold, in KB of Brotli, 0 turns it off. */
export const ENTRY_WEIGHT_VARIABLE = "DMS_ENTRY_WEIGHT_WARNING";

/**
 * A module that adds more than this to the client entry is reported: a little
 * above the DMS core module's own share, the shell every page renders (43 KB
 * with every module of the organisation loaded).
 */
export const DEFAULT_ENTRY_WEIGHT_WARNING_KB = 50;

/** Written by the client build (`templates/vue/entry-weight.mjs`). */
const ENTRY_WEIGHT_FILE = join("dist", "client", ".vite", "entry-weight.json");

/** Owners of the entry's bytes that are no frontend module. */
const SHARED_OWNER = "shared";
const TRANSLATIONS_OWNER = "translations";
const NON_MODULE_OWNERS = new Set([SHARED_OWNER, TRANSLATIONS_OWNER]);

const BYTES_PER_KB = 1024;

interface RecordedEntryWeight {
  files: string[];
  bytes: number;
  owners: Record<string, number>;
}

export interface EntryShare {
  owner: string;
  /** Output bytes of the entry from the owner's sources. */
  bytes: number;
  /** The same share of the entry's Brotli size. */
  brotli: number;
}

/** What the entry weighs, and who it weighs for, largest first. */
export interface EntryWeight {
  bytes: number;
  brotli: number;
  shares: EntryShare[];
}

/** The Brotli size the server serves a built file with. */
function brotliSize(file: string): number {
  const compressed = `${file}.br`;
  if (existsSync(compressed)) return statSync(compressed).size;
  // compress-assets leaves out files too small to gain from it.
  return brotliCompressSync(readFileSync(file), {
    params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY },
  }).length;
}

/**
 * The entry's weight in the built workspace, once its assets are compressed;
 * nothing when the client build recorded none.
 */
export function readEntryWeight(workspaceDir: string): EntryWeight | undefined {
  const path = join(workspaceDir, ENTRY_WEIGHT_FILE);
  if (!existsSync(path)) return undefined;
  const recorded = JSON.parse(
    readFileSync(path, "utf8"),
  ) as RecordedEntryWeight;
  const brotli = recorded.files.reduce(
    (sum, file) => sum + brotliSize(join(workspaceDir, "dist", "client", file)),
    0,
  );
  const ratio = recorded.bytes ? brotli / recorded.bytes : 0;
  const shares = Object.entries(recorded.owners)
    .map(([owner, bytes]) => ({
      owner,
      bytes,
      brotli: Math.round(bytes * ratio),
    }))
    .sort((left, right) => right.bytes - left.bytes);
  return { bytes: recorded.bytes, brotli, shares };
}

/**
 * The threshold `DMS_ENTRY_WEIGHT_WARNING` sets, in bytes of Brotli; 0 when
 * the warning is off.
 */
export function entryWeightThreshold(env: NodeJS.ProcessEnv): number {
  const value = env[ENTRY_WEIGHT_VARIABLE]?.trim();
  if (!value) return DEFAULT_ENTRY_WEIGHT_WARNING_KB * BYTES_PER_KB;
  const kilobytes = Number(value);
  if (!Number.isFinite(kilobytes) || kilobytes < 0)
    throw new CliError({
      title: `${ENTRY_WEIGHT_VARIABLE} is not a size`,
      reason: `It is ${JSON.stringify(value)}; it takes a number of KB of Brotli.`,
      fixes: [
        `Set ${ENTRY_WEIGHT_VARIABLE}=${DEFAULT_ENTRY_WEIGHT_WARNING_KB}, or 0 to turn the warning off`,
      ],
    });
  return kilobytes * BYTES_PER_KB;
}

/** The frontend modules above `threshold`, largest first. */
export function heavyEntryModules(
  weight: EntryWeight,
  threshold: number,
): EntryShare[] {
  if (threshold <= 0) return [];
  return weight.shares.filter(
    (share) => !NON_MODULE_OWNERS.has(share.owner) && share.brotli > threshold,
  );
}

/** One line per owner, for the build's report. */
export function describeEntryShares(weight: EntryWeight): string[] {
  return weight.shares.map(
    (share) =>
      `${share.owner}  ${formatSize(share.brotli)} (${formatSize(share.bytes)})`,
  );
}

interface ReportUi {
  message(
    level: "info" | "warn",
    text: string,
    options?: { detail?: string; details?: string[] },
  ): void;
}

/**
 * Tells what the client entry weighs and what each module adds to it, and
 * warns about a module above the threshold. Every page loads the entry before
 * it runs anything, so a module's weight there is paid on every page.
 */
export function reportEntryWeight(
  ui: ReportUi,
  workspaceDir: string,
  env: NodeJS.ProcessEnv,
): void {
  const threshold = entryWeightThreshold(env);
  const weight = readEntryWeight(workspaceDir);
  if (!weight) return;
  ui.message(
    "info",
    `Client entry ${formatSize(weight.brotli)} Brotli (${formatSize(weight.bytes)}), loaded first by every page`,
    { details: describeEntryShares(weight) },
  );
  const heavy = heavyEntryModules(weight, threshold);
  heavy.forEach((share, index) => {
    const isLast = index === heavy.length - 1;
    ui.message(
      "warn",
      `${share.owner} adds ${formatSize(share.brotli)} Brotli to the client entry`,
      {
        details: isLast
          ? [
              "What a module's dms.frontend.ts and its plugins import is loaded by every page: render a component they only show on some pages by its registered name or with defineAsyncComponent",
              `The threshold is ${formatSize(threshold)} (${ENTRY_WEIGHT_VARIABLE}, in KB; 0 turns the warning off)`,
            ]
          : [],
      },
    );
  });
}

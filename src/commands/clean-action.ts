import { existsSync, rmSync } from "node:fs";
import { createPrompter, getProcessUi, pluralize } from "@antelopejs/core/cli";
import {
  directorySize,
  getWorkspaceDir,
  parseBackendUrl,
  UsageError,
} from "../common";
import {
  formatSize,
  isTerminalFeedback,
  showWorkspace,
  workspaceId,
  writeFeedback,
} from "../output";
import {
  describeKey,
  readWorkspaceRecords,
  reportSkipped,
  type WorkspaceRecord,
} from "./workspaces-action";

export interface CleanOptions {
  backendUrl?: string;
  all?: boolean;
  yes?: boolean;
}

const CLEAN_ALL_COMMAND = "ajs dms clean --all";
const YES_FLAG = "--yes";
const COLUMN_GAP = "  ";
const ROW_INDENT = "  ";

/**
 * One line per workspace, columns aligned: its id, its backend and what it
 * is keyed on.
 */
export function describeWorkspaces(
  records: WorkspaceRecord[],
  isTerminal: boolean,
): string[] {
  const rows = records.map((record) => [
    workspaceId(record.dir, isTerminal),
    record.backendUrl,
    describeKey(record),
  ]);
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) => cell.padEnd(widths[column]))
      .join(COLUMN_GAP)
      .trimEnd(),
  );
}

/**
 * Asks before `--all` removes anything, after listing what it removes. Without
 * a terminal to ask on, only `--yes` lets it proceed.
 */
async function confirmCleanAll(
  records: WorkspaceRecord[],
  totalBytes: number,
  options: CleanOptions,
): Promise<boolean> {
  const prompter = createPrompter({ command: CLEAN_ALL_COMMAND });
  if (!options.yes && prompter.isInteractive) {
    writeFeedback(
      `Remove ${pluralize(records.length, "workspace")} (${formatSize(totalBytes)})?`,
    );
    for (const line of describeWorkspaces(records, true)) {
      writeFeedback(`${ROW_INDENT}${line}`);
    }
  }
  return prompter.confirm({
    message: "Continue?",
    flag: YES_FLAG,
    answer: options.yes || undefined,
    defaultAnswer: false,
  });
}

async function cleanAll(options: CleanOptions): Promise<void> {
  const ui = getProcessUi();
  const { records, skipped } = readWorkspaceRecords();
  if (records.length === 0) {
    ui.message("info", "No workspaces found");
    reportSkipped(ui, skipped);
    return;
  }

  const totalBytes = records.reduce((sum, record) => sum + record.sizeBytes, 0);
  if (!(await confirmCleanAll(records, totalBytes, options))) {
    ui.message("skip", "Nothing removed");
    return;
  }

  for (const record of records) {
    rmSync(record.dir, { recursive: true, force: true });
  }
  ui.message(
    "success",
    `Removed ${pluralize(records.length, "workspace")} · freed ${formatSize(totalBytes)}`,
    {
      details: options.yes
        ? describeWorkspaces(records, isTerminalFeedback())
        : [],
    },
  );
  reportSkipped(ui, skipped);
}

export async function runClean(options: CleanOptions): Promise<void> {
  const ui = getProcessUi();
  if (options.all) {
    await cleanAll(options);
    return;
  }

  if (!options.backendUrl) {
    throw new UsageError({
      title: "Nothing to clean: pass -b <url> or --all",
      reason:
        "clean never uses DMS_API_BASE_URL from the environment or ./.env.",
      fixes: [
        "Remove the workspace build, start and dev -b share for a URL: ajs dms clean -b <url>",
        "Remove every workspace, including those dev created without -b: ajs dms clean --all",
        "List the workspaces: ajs dms workspaces",
      ],
    });
  }
  const backendUrl = parseBackendUrl(options.backendUrl);
  const workspaceDir = getWorkspaceDir(backendUrl);

  if (!existsSync(workspaceDir)) {
    ui.message("info", `No workspace for ${backendUrl}: nothing to clean`);
    return;
  }

  const freedBytes = directorySize(workspaceDir);
  rmSync(workspaceDir, { recursive: true, force: true });
  ui.message(
    "success",
    `Removed workspace ${showWorkspace(workspaceDir)} · ${backendUrl} · freed ${formatSize(freedBytes)}`,
  );
}

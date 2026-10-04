import { existsSync, rmSync } from "node:fs";
import { createPrompter, getProcessUi, pluralize } from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  directorySize,
  getWorkspaceDir,
  parseBackendUrl,
  UsageError,
} from "../common";
import { type HelpExample, withExamples } from "../help";
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
} from "./workspaces";

interface CleanOptions {
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

const CLEAN_EXAMPLES: HelpExample[] = [
  {
    description: "The workspace build, start and dev -b share for a backend",
    command: "ajs dms clean -b https://dms.example.com",
  },
  {
    description: "Every workspace, without asking (scripts, CI)",
    command: "ajs dms clean --all --yes",
  },
];

export function cmdClean(): Command {
  // -b is not the shared option: clean deletes, so its target is never taken
  // from DMS_API_BASE_URL, which a project's .env sets without the user
  // having it in mind.
  const command = new Command("clean")
    .summary("Remove generated workspaces")
    .description(
      "Remove generated workspaces: their node_modules, manifest cache, downloaded layers and build output.",
    )
    .option(
      "-b, --backend-url <url>",
      "Backend URL whose workspace to remove; DMS_API_BASE_URL is never read",
    )
    .option("-a, --all", "Remove every workspace, after a confirmation")
    .option("-y, --yes", "Skip the confirmation of --all")
    .action(async (options: CleanOptions) => {
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
    });
  return withExamples(command, CLEAN_EXAMPLES);
}

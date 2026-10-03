import {
  getProcessUi,
  type TableColumn,
  type Ui,
  writeData,
} from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  DMS_FRONTEND_HOME,
  directorySize,
  listWorkspaces,
  projectDirFromWorkspaceKey,
} from "../common";
import {
  formatAge,
  formatSize,
  isTerminalResult,
  showPath,
  workspaceId,
} from "../output";

interface WorkspacesOptions {
  json?: boolean;
}

/** One workspace as `--json` prints it: full paths, sizes in bytes, ISO dates. */
export interface WorkspaceRecord {
  id: string;
  dir: string;
  backendUrl: string;
  key: { type: "url" } | { type: "project"; path: string };
  sizeBytes: number;
  lastUsedAt: string;
}

/** Reads every workspace the loader owns, with its size on disk. */
export function readWorkspaceRecords(): {
  records: WorkspaceRecord[];
  skipped: string[];
} {
  const { workspaces, skipped } = listWorkspaces();
  const records = workspaces.map((workspace): WorkspaceRecord => {
    const projectDir = projectDirFromWorkspaceKey(workspace.workspaceKey);
    return {
      id: workspaceId(workspace.dir, false),
      dir: workspace.dir,
      backendUrl: workspace.backendUrl,
      key: projectDir ? { type: "project", path: projectDir } : { type: "url" },
      sizeBytes: directorySize(workspace.dir),
      lastUsedAt: workspace.lastUsedAt,
    };
  });
  return { records, skipped };
}

/**
 * What a workspace is keyed on: `url`, or `project <dir>` for one `dev`
 * created without `-b`. A project-keyed workspace names its directory because
 * the same backend also has — or will have — a second, URL-keyed workspace
 * built by `build`, and the two are otherwise indistinguishable.
 */
export function describeKey(record: WorkspaceRecord): string {
  return record.key.type === "project"
    ? `project ${showPath(record.key.path)}`
    : "url";
}

const TERMINAL_COLUMNS: TableColumn<WorkspaceRecord>[] = [
  { header: "id", value: (record) => workspaceId(record.dir, true) },
  { header: "backend", value: (record) => record.backendUrl },
  { header: "key", value: describeKey },
  { header: "size", value: (record) => formatSize(record.sizeBytes) },
  { header: "last used", value: (record) => formatAge(record.lastUsedAt) },
];

/** Piped, one tab-separated line per workspace, in this order and unformatted. */
const PIPED_COLUMNS: TableColumn<WorkspaceRecord>[] = [
  { header: "id", value: (record) => record.id },
  { header: "backend", value: (record) => record.backendUrl },
  { header: "key", value: (record) => record.key.type },
  {
    header: "project",
    value: (record) => (record.key.type === "project" ? record.key.path : ""),
  },
  { header: "size", value: (record) => String(record.sizeBytes) },
  { header: "last used", value: (record) => record.lastUsedAt },
  { header: "dir", value: (record) => record.dir },
];

/**
 * The listing on stdout: an aligned table on a terminal, tab-separated lines
 * without a header in a pipe. An empty listing says so on stderr only.
 */
export function renderWorkspaces(
  ui: Ui,
  records: WorkspaceRecord[],
  isTerminal: boolean,
): void {
  if (records.length === 0) {
    ui.message("info", `No workspaces in ${showPath(DMS_FRONTEND_HOME)}`);
    return;
  }
  ui.table(records, isTerminal ? TERMINAL_COLUMNS : PIPED_COLUMNS);
}

/** Directories under the loader home that are not workspaces, on stderr. */
export function reportSkipped(ui: Ui, skipped: string[]): void {
  for (const dir of skipped) {
    ui.message("skip", `Skipped ${showPath(dir)} (not a workspace)`);
  }
}

export function cmdWorkspaces(): Command {
  return new Command("workspaces")
    .description("List generated workspaces, with their size and last use")
    .option("--json", "Print the list as one JSON document on stdout")
    .addHelpText(
      "after",
      `
Piped, it prints one tab-separated line per workspace, without a header:
id, backend URL, key type (url or project), project directory, size in bytes,
last use (ISO 8601) and workspace directory.`,
    )
    .action((options: WorkspacesOptions) => {
      const ui = getProcessUi();
      const { records, skipped } = readWorkspaceRecords();
      writeData(ui, {
        data: records,
        isJson: options.json,
        render: (target) =>
          renderWorkspaces(target, records, isTerminalResult()),
      });
      reportSkipped(ui, skipped);
    });
}

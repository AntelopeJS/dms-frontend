import { existsSync, rmSync } from "node:fs";
import { getProcessUi, pluralize } from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  describeWorkspace,
  getWorkspaceDir,
  listWorkspaces,
  parseBackendUrl,
  UsageError,
} from "../common";
import { showWorkspace } from "../output";

interface CleanOptions {
  backendUrl?: string;
  all?: boolean;
}

export function cmdClean(): Command {
  // -b is not the shared option: clean deletes, so its target is never taken
  // from DMS_API_BASE_URL, which a project's .env sets without the user
  // having it in mind.
  return new Command("clean")
    .description("Remove workspace build artifacts")
    .option(
      "-b, --backend-url <url>",
      "Backend DMS URL whose workspace to remove",
    )
    .option("-a, --all", "Clean all workspaces")
    .action(async (options: CleanOptions) => {
      const ui = getProcessUi();
      if (options.all) {
        const workspaces = listWorkspaces();

        if (workspaces.length === 0) {
          ui.message("info", "No workspaces found");
          return;
        }

        for (const ws of workspaces) {
          rmSync(ws.dir, { recursive: true, force: true });
          ui.message(
            "success",
            `Removed ${showWorkspace(ws.dir)} · ${describeWorkspace(ws)}`,
          );
        }
        ui.message(
          "success",
          `Cleaned ${pluralize(workspaces.length, "workspace")}`,
        );
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
          ],
        });
      }
      const backendUrl = parseBackendUrl(options.backendUrl);
      const workspaceDir = getWorkspaceDir(backendUrl);

      if (!existsSync(workspaceDir)) {
        ui.message("info", `No workspace for ${backendUrl}: nothing to clean`);
        return;
      }

      rmSync(workspaceDir, { recursive: true, force: true });
      ui.message(
        "success",
        `Removed workspace ${showWorkspace(workspaceDir)} · ${backendUrl}`,
      );
    });
}

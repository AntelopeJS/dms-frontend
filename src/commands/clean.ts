import { existsSync, rmSync } from "node:fs";
import { Command } from "commander";
import {
  describeWorkspace,
  getWorkspaceDir,
  listWorkspaces,
  parseBackendUrl,
  UsageError,
} from "../common";
import { info, success } from "../utils/cli-ui";

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
      if (options.all) {
        console.error("");
        // Clean all workspaces
        info("Cleaning all workspaces...");
        const workspaces = listWorkspaces();

        if (workspaces.length === 0) {
          info("No workspaces found.");
          return;
        }

        for (const ws of workspaces) {
          rmSync(ws.dir, { recursive: true, force: true });
          success(`Removed ${ws.dir} (${describeWorkspace(ws)})`);
        }

        console.error("");
        success(`Cleaned ${workspaces.length} workspace(s).`);
        return;
      }

      if (!options.backendUrl) {
        throw new UsageError("Nothing to clean: pass -b <url> or --all", [
          "clean never uses DMS_API_BASE_URL from the environment or ./.env.",
          "-b reaches the workspace 'build', 'start' and 'dev -b' share for that URL;",
          "a workspace 'dev' created without -b is only removable with --all.",
        ]);
      }
      const workspaceDir = getWorkspaceDir(parseBackendUrl(options.backendUrl));
      console.error("");

      if (!existsSync(workspaceDir)) {
        info("Workspace not found — nothing to clean.");
        return;
      }

      rmSync(workspaceDir, { recursive: true, force: true });
      success(`Removed workspace: ${workspaceDir}`);
    });
}

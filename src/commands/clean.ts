import { existsSync, rmSync } from "node:fs";
import { Command } from "commander";
import {
  describeWorkspace,
  getWorkspaceDir,
  listWorkspaces,
  Options,
} from "../common";
import { info, success, warning } from "../utils/cli-ui";

interface CleanOptions {
  backendUrl?: string;
  all?: boolean;
}

export function cmdClean(): Command {
  return new Command("clean")
    .description("Remove workspace build artifacts")
    .addOption(Options.backendUrl)
    .option("-a, --all", "Clean all workspaces")
    .action(async (options: CleanOptions) => {
      console.log("");

      if (options.all) {
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

        console.log("");
        success(`Cleaned ${workspaces.length} workspace(s).`);
        return;
      }

      if (!options.backendUrl) {
        warning(
          "Specify -b <url> to clean a specific workspace, or --all to clean everything.\n" +
            "  -b only reaches the workspace 'build', 'start' and 'dev -b' share for that URL;\n" +
            "  a workspace 'dev' created without -b is keyed on the project directory and is\n" +
            "  only removable with --all.",
        );
        process.exit(1);
      }

      const workspaceDir = getWorkspaceDir(options.backendUrl);

      if (!existsSync(workspaceDir)) {
        info("Workspace not found — nothing to clean.");
        return;
      }

      rmSync(workspaceDir, { recursive: true, force: true });
      success(`Removed workspace: ${workspaceDir}`);
    });
}

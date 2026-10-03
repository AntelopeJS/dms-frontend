import { join } from "node:path";
import { CliError, getProcessUi } from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  normalizeBootstrapSecret,
  Options,
  requireBackendUrl,
  resolveSessionSecret,
  runCommand,
} from "../common";
import {
  cachedAge,
  showWorkspace,
  writeBlankLine,
  writeHeader,
} from "../output";
import { setUpWorkspace } from "./workspace-task";

interface BuildOptions {
  backendUrl?: string;
  force?: boolean;
  offline?: boolean;
  bootstrapSecret?: string;
}

export function cmdBuild(): Command {
  return new Command("build")
    .description("Build for production (downloads layers via ZIP from backend)")
    .addOption(Options.backendUrl)
    .addOption(Options.force)
    .addOption(Options.offline)
    .addOption(Options.bootstrapSecret)
    .action(async (options: BuildOptions) => {
      const backendUrl = requireBackendUrl(options.backendUrl);
      const sessionSecret = resolveSessionSecret("build");
      const bootstrapSecret = normalizeBootstrapSecret(options.bootstrapSecret);
      const ui = getProcessUi();

      writeHeader("build", [backendUrl, "production"]);
      const { workspaceDir, manifestFromCache, manifestFetchedAt } =
        await setUpWorkspace({
          backendUrl,
          force: !!options.force,
          mode: "build",
          offline: options.offline,
          bootstrapSecret,
        });

      if (manifestFromCache) {
        ui.message(
          "warn",
          `Building from the manifest and layers archive${cachedAge(manifestFetchedAt)}`,
          { detail: "The output may not match the current backend." },
        );
      }

      ui.message("info", "Building for production", {
        detail: `Workspace  ${showWorkspace(workspaceDir)}`,
      });
      writeBlankLine();

      const nodeModulesDir = join(workspaceDir, "node_modules");
      const code = await runCommand("pnpm", ["run", "build"], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          DMS_SESSION_SECRET: sessionSecret,
          NODE_OPTIONS: "--max-old-space-size=4096",
          NODE_PATH: nodeModulesDir,
        },
      });
      writeBlankLine();

      if (code !== 0) {
        throw new CliError({
          title: "The production build failed",
          reason: `pnpm run build exited with code ${code}; its output is above.`,
        });
      }
      ui.message("success", "Built the production frontend");
      ui.message("hint", "Run ajs dms start to start the production server");
    });
}

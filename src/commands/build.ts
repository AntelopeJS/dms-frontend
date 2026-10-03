import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  CancelledError,
  normalizeBootstrapSecret,
  Options,
  parseBackendUrl,
  resolveSessionSecret,
  runCommand,
  setupWorkspace,
} from "../common";
import { error, info, Spinner, success, warning } from "../utils/cli-ui";

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
      if (!options.backendUrl) {
        error("Backend URL is required. Use -b <url> or set DMS_API_BASE_URL.");
        process.exit(1);
      }

      const backendUrl = parseBackendUrl(options.backendUrl);
      const sessionSecret = resolveSessionSecret("build");
      const bootstrapSecret = normalizeBootstrapSecret(options.bootstrapSecret);

      const spinner = new Spinner("Setting up workspace...");
      await spinner.start();

      try {
        const { workspaceDir, manifestFromCache, manifestFetchedAt } =
          await setupWorkspace({
            backendUrl,
            force: !!options.force,
            mode: "build",
            offline: options.offline,
            bootstrapSecret,
            beforeInstall: () => spinner.pause(),
          });

        await spinner.succeed("Workspace ready");

        if (manifestFromCache) {
          warning(
            `Building from cached manifest and layers archive${manifestFetchedAt ? ` (cached on ${manifestFetchedAt})` : ""} — output may not match the current backend`,
          );
        }

        console.error("");
        info("Building for production...");
        console.error(chalk.dim(`  Workspace: ${workspaceDir}`));
        console.error("");

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

        if (code === 0) {
          console.error("");
          success("Build completed successfully!");
          console.error(
            chalk.dim("  Run 'ajs dms start' to start the production server"),
          );
        } else {
          error("Build failed");
        }

        process.exit(code);
      } catch (err: any) {
        if (err instanceof CancelledError) throw err;
        await spinner.fail(`Setup failed: ${err.message}`);
        process.exit(1);
      }
    });
}

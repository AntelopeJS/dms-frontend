import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  getWorkspaceDir,
  Options,
  resolveSessionSecret,
  runCommand,
} from "../common";
import { error, info } from "../utils/cli-ui";

interface StartOptions {
  backendUrl?: string;
  port: string;
}

export function cmdStart(): Command {
  return new Command("start")
    .description("Start the production server from a built workspace")
    .addOption(Options.backendUrl)
    .addOption(Options.port)
    .action(async (options: StartOptions) => {
      if (!options.backendUrl) {
        error("Backend URL is required. Use -b <url> or set DMS_API_BASE_URL.");
        process.exit(1);
      }

      const sessionSecret = resolveSessionSecret("start");

      const workspaceDir = getWorkspaceDir(options.backendUrl);
      const serverPath = join(workspaceDir, "server.mjs");
      const clientPath = join(workspaceDir, "dist", "client", "index.html");

      if (!existsSync(serverPath) || !existsSync(clientPath)) {
        console.log("");
        error("Production build not found!");
        console.log(
          chalk.dim(
            "  Run 'ajs dms build -b " +
              options.backendUrl +
              "' first to create a production build",
          ),
        );
        process.exit(1);
      }

      console.log("");
      info(`Starting production server on port ${chalk.cyan(options.port)}...`);
      console.log(chalk.dim(`  Workspace: ${workspaceDir}`));
      console.log("");

      const code = await runCommand("node", [serverPath], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          PORT: options.port,
          DMS_API_BASE_URL: options.backendUrl,
          DMS_SESSION_SECRET: sessionSecret,
          DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "true",
        },
      });

      process.exit(code);
    });
}

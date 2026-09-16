import chalk from "chalk";
import { Command } from "commander";
import { Options, resolveBootstrapSecret, setupWorkspace } from "../common";
import { info, Spinner, success, warning } from "../utils/cli-ui";

interface PrepareOptions {
  backendUrl?: string;
  force?: boolean;
  offline?: boolean;
  bootstrapSecret?: string;
}

export function cmdPrepare(): Command {
  return new Command("prepare")
    .description(
      "Prepare the generated Vite workspace and frontend-module registry",
    )
    .addOption(Options.backendUrl)
    .addOption(Options.force)
    .addOption(Options.offline)
    .addOption(Options.bootstrapSecret)
    .action(async (options: PrepareOptions) => {
      // The prepare command is often run from CI (e.g. as a `postinstall`
      // hook on a frontend module) where the backend is unreachable or no URL
      // is configured. We don't want CI installs to fail in that case — types
      // can be regenerated later in a dev environment. Warn and exit 0
      // instead of erroring, after falling back to a workspace-less prepare
      // without leaving a partially generated workspace.
      if (!options.backendUrl) {
        warning(
          "Backend URL not set; skipping prepare. Pass -b <url> or set DMS_BACKEND_URL to generate types.",
        );
        process.exit(0);
      }

      const spinner = new Spinner("Setting up workspace...");
      await spinner.start();

      let workspaceDir: string;
      let manifestFromCache: boolean;
      let manifestFetchedAt: string | undefined;
      try {
        const result = await setupWorkspace({
          backendUrl: options.backendUrl,
          force: !!options.force,
          mode: "dev",
          offline: options.offline,
          bootstrapSecret: resolveBootstrapSecret(
            options.bootstrapSecret,
            options.backendUrl,
          ),
        });
        workspaceDir = result.workspaceDir;
        manifestFromCache = result.manifestFromCache;
        manifestFetchedAt = result.manifestFetchedAt;
      } catch (err: any) {
        await spinner.warn(`Skipping prepare: ${err.message}`);
        process.exit(0);
      }

      await spinner.succeed("Workspace ready");

      if (manifestFromCache) {
        const cachedOn = manifestFetchedAt
          ? ` (cached on ${manifestFetchedAt})`
          : "";
        if (options.offline) {
          info(
            `Offline mode — using cached frontend-module manifest${cachedOn}`,
          );
        } else {
          warning(
            `Backend unreachable — using cached frontend-module manifest${cachedOn}`,
          );
        }
      }

      console.log("");
      success(`Vite workspace prepared ${chalk.dim(`(${workspaceDir})`)}`);
      process.exit(0);
    });
}

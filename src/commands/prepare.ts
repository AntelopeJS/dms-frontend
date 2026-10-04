import { getProcessUi } from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  CancelledError,
  Options,
  parseBackendUrl,
  resolveBootstrapSecret,
  type SetupWorkspaceResult,
} from "../common";
import {
  cachedAge,
  failureDetails,
  showWorkspace,
  writeHeader,
} from "../output";
import { setUpWorkspace } from "./workspace-task";

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
      const ui = getProcessUi();
      const hint = ui.symbols.levels.hint;
      // The prepare command is often run from CI (e.g. as a `postinstall`
      // hook on a frontend module) where the backend is unreachable or no URL
      // is configured. We don't want CI installs to fail in that case — types
      // can be regenerated later in a dev environment. Warn and exit 0
      // instead of erroring, after falling back to a workspace-less prepare
      // without leaving a partially generated workspace.
      if (!options.backendUrl) {
        ui.message("warn", "Skipped prepare: no backend URL", {
          details: [
            `${hint} Pass -b <url> or set DMS_API_BASE_URL to generate the types`,
          ],
        });
        return;
      }

      writeHeader("prepare", [options.backendUrl]);
      let result: SetupWorkspaceResult;
      try {
        result = await setUpWorkspace({
          backendUrl: parseBackendUrl(options.backendUrl),
          force: !!options.force,
          mode: "dev",
          offline: options.offline,
          bootstrapSecret: resolveBootstrapSecret(
            options.bootstrapSecret,
            options.backendUrl,
          ),
        });
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        const [title, ...details] = failureDetails(err, ui);
        ui.message("warn", `Skipped prepare: ${title}`, { details });
        return;
      }

      const { workspaceDir, manifestFromCache, manifestFetchedAt } = result;
      if (manifestFromCache) {
        const manifest = `the frontend-module manifest${cachedAge(manifestFetchedAt)}`;
        if (options.offline) {
          ui.message("info", `Offline: using ${manifest}`);
        } else {
          ui.message("warn", `Backend unreachable: using ${manifest}`);
        }
      }

      ui.message("success", "Prepared the Vite workspace", {
        detail: showWorkspace(workspaceDir),
      });
    });
}

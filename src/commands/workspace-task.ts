import { getProcessTasks, getProcessUi } from "@antelopejs/core/cli";
import {
  type SetupWorkspaceOptions,
  type SetupWorkspaceResult,
  setupWorkspace,
} from "../common";

/**
 * Set the workspace up as one task. `pnpm install` writes to the terminal
 * itself, so the task ends before the install starts and the install is
 * announced on its own line instead of running under a spinner.
 *
 * A failure removes the task without a line: whoever catches the error
 * reports it once.
 */
export async function setUpWorkspace(
  options: Omit<SetupWorkspaceOptions, "beforeInstall">,
): Promise<SetupWorkspaceResult> {
  const ui = getProcessUi();
  const task = getProcessTasks().start("Setting up the workspace");
  let hasInstalled = false;
  try {
    const result = await setupWorkspace({
      ...options,
      beforeInstall: async () => {
        task.succeed("Workspace generated");
        ui.message("info", "Installing the workspace dependencies");
        hasInstalled = true;
      },
    });
    if (hasInstalled) ui.message("success", "Workspace ready");
    else task.succeed("Workspace ready");
    return result;
  } catch (error) {
    task.dismiss();
    throw error;
  }
}

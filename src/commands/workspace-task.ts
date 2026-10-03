import { getProcessTasks } from "@antelopejs/core/cli";
import {
  type SetupWorkspaceOptions,
  type SetupWorkspaceResult,
  setupWorkspace,
} from "../common";

/**
 * Set the workspace up as one task. When dependencies have to be installed,
 * the task ends as the install starts, and the install task that follows
 * ends the setup.
 *
 * A failure removes the task without a line: whoever catches the error
 * reports it once.
 */
export async function setUpWorkspace(
  options: Omit<SetupWorkspaceOptions, "beforeInstall">,
): Promise<SetupWorkspaceResult> {
  const task = getProcessTasks().start("Setting up the workspace");
  let isInstalling = false;
  try {
    const result = await setupWorkspace({
      ...options,
      beforeInstall: async () => {
        task.succeed("Workspace generated");
        isInstalling = true;
      },
    });
    if (!isInstalling) task.succeed("Workspace ready");
    return result;
  } catch (error) {
    task.dismiss();
    throw error;
  }
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProcessTasks, getProcessUi } from "@antelopejs/core/cli";
import {
  downloadAndExtractLayers,
  fetchManifest,
  normalizeBootstrapSecret,
  requireBackendUrl,
  UsageError,
} from "../common";
import { endInterruptedTask, writeBlankLine, writeHeader } from "../output";
import { SNAPSHOT_LAYERS_DIR, writeSnapshot } from "../snapshot";

export interface SnapshotOptions {
  backendUrl?: string;
  output: string;
  bootstrapSecret?: string;
}

export async function runSnapshot(options: SnapshotOptions): Promise<void> {
  const startedAt = Date.now();
  const backendUrl = requireBackendUrl(options.backendUrl);
  const bootstrapSecret = normalizeBootstrapSecret(options.bootstrapSecret);
  if (!bootstrapSecret) {
    throw new UsageError({
      title: "A snapshot needs the bootstrap credential",
      reason:
        "Without it the backend withholds the modules' backend proxies, and a build from the snapshot would not route them.",
      fixes: [
        "Set DMS_BOOTSTRAP_SECRET to the backend's frontend.bootstrapSecret",
      ],
    });
  }
  writeHeader("snapshot", [backendUrl]);

  const task = getProcessTasks().start("Fetching the manifest and layers");
  const scratch = mkdtempSync(join(tmpdir(), "dms-snapshot-"));
  try {
    const manifest = await fetchManifest(
      backendUrl,
      undefined,
      bootstrapSecret,
    );
    const layers = join(scratch, SNAPSHOT_LAYERS_DIR);
    await downloadAndExtractLayers(
      backendUrl,
      manifest.pack,
      layers,
      true,
      bootstrapSecret,
    );
    const snapshot = writeSnapshot(
      options.output,
      backendUrl,
      manifest,
      layers,
    );
    task.succeed(
      `Fetched ${manifest.modules.length} frontend module${manifest.modules.length === 1 ? "" : "s"}`,
    );
    writeBlankLine();
    getProcessUi().summary({
      headline: `Took a snapshot of modules ${snapshot.digest}, without private values`,
      artifact: options.output,
      durationMs: Date.now() - startedAt,
      nextSteps: [
        {
          command: `ajs dms build --from ${options.output} --workspace .dms-frontend`,
          description: "without the backend or any secret",
        },
      ],
    });
  } catch (error) {
    endInterruptedTask(task, error, "Snapshot stopped");
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

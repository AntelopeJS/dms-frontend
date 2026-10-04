import { formatDuration, getProcessUi, pluralize } from "@antelopejs/core/cli";
import {
  BackendUnreachableError,
  CancelledError,
  flagOrEnv,
  NoCachedManifestError,
  parseBackendUrl,
  requireBackendUrl,
  resolveBootstrapSecret,
  type SetupWorkspaceResult,
} from "../common";
import {
  cachedAge,
  failureDetails,
  joinParts,
  showWorkspace,
  writeHeader,
} from "../output";
import { setUpWorkspace } from "./workspace-task";

export interface PrepareOptions {
  backendUrl?: string;
  force?: boolean;
  offline?: boolean;
  strict?: boolean;
  bootstrapSecret?: string;
}

const NOT_GENERATED = "The types and the module registry were not generated.";
const STRICT_HINT =
  "prepare never fails an install; add --strict to make this an error.";

/**
 * Whether a failure only means the backend is out of reach, as it is in CI,
 * so a later run with the backend up prepares the workspace. Any other one
 * (a refused credential, an incompatible manifest or renderer range, a
 * mistyped URL) fails again until someone fixes it.
 */
function isSkip(error: unknown): boolean {
  return (
    error instanceof BackendUnreachableError ||
    error instanceof NoCachedManifestError
  );
}

export async function runPrepare(options: PrepareOptions): Promise<void> {
  const startedAt = Date.now();
  const offline = flagOrEnv(options.offline, "DMS_OFFLINE");
  const strict = flagOrEnv(options.strict, "DMS_PREPARE_STRICT");
  const ui = getProcessUi();
  const hint = ui.symbols.levels.hint;
  // The prepare command is often run from CI (e.g. as a `postinstall`
  // hook on a frontend module) where the backend is unreachable or no URL
  // is configured. We don't want CI installs to fail in that case — types
  // can be regenerated later in a dev environment. Warn and exit 0
  // instead of erroring, after falling back to a workspace-less prepare
  // without leaving a partially generated workspace. --strict turns the
  // warning back into the error.
  if (!options.backendUrl) {
    if (strict) requireBackendUrl(options.backendUrl);
    ui.message("warn", "Skipped prepare: no backend URL", {
      details: [
        `${hint} Pass -b <url> or set DMS_API_BASE_URL to generate the types`,
        STRICT_HINT,
      ],
    });
    return;
  }

  let result: SetupWorkspaceResult;
  try {
    const backendUrl = parseBackendUrl(options.backendUrl);
    const bootstrapSecret = resolveBootstrapSecret(
      options.bootstrapSecret,
      options.backendUrl,
    );
    writeHeader("prepare", [backendUrl]);
    result = await setUpWorkspace({
      backendUrl,
      force: !!options.force,
      mode: "dev",
      offline,
      bootstrapSecret,
    });
  } catch (err) {
    if (err instanceof CancelledError || strict) throw err;
    const [title, ...details] = failureDetails(err, ui);
    const outcome = isSkip(err) ? "Skipped prepare" : "Prepare failed";
    ui.message("warn", `${outcome}: ${title}`, {
      details: [...details, NOT_GENERATED, STRICT_HINT],
    });
    return;
  }

  const { workspaceDir, layers, manifestFromCache, manifestFetchedAt } = result;
  if (manifestFromCache) {
    const manifest = `the frontend-module manifest${cachedAge(manifestFetchedAt)}`;
    if (offline) {
      ui.message("info", `Offline: using ${manifest}`);
    } else {
      ui.message("warn", `Backend unreachable: using ${manifest}`);
    }
  }

  const summary = [
    "Prepared the workspace",
    pluralize(layers.length, "module"),
    "types and registry written",
    formatDuration(Date.now() - startedAt),
  ];
  ui.message("success", joinParts(summary, ui), {
    detail: showWorkspace(workspaceDir),
  });
}

import { fork } from "node:child_process";
import { CliError, getProcessUi } from "@antelopejs/core/cli";
import { filledOptions } from "./private-values";
import type { ProjectModulesReply } from "./project-modules-child";
import type {
  ProjectFrontendModule,
  ProjectModulesOptions,
} from "./project-modules";
import type {
  FrontendModuleOptions,
  FrontendModuleValue,
  Manifest,
  OriginRewrite,
  ResolvedLayer,
} from "./workspace";

/**
 * {@link readProjectFrontendModules} in a process of its own, so each read
 * sees the configuration and the modules as they are now.
 *
 * The frontend modules `dev` serves: the project's, as `build` reads them but
 * with `dev: true`, completed with what only the running backend knows. The
 * backend's manifest gives the secrets it holds, which fill the private options
 * each module declares, as `start` fills them from its environment, and the
 * origins it rewrites in development, applied to the options the same way.
 * Which modules are served, and their options, come from the project alone, so
 * a mistake in a module's `frontendModule` shows in `dev` rather than first in
 * production.
 */
export function readProjectModulesFresh(
  options: ProjectModulesOptions,
): Promise<ProjectFrontendModule[]> {
  return new Promise((resolve, reject) => {
    const child = fork(require.resolve("./project-modules-child"), [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    let reply: ProjectModulesReply | undefined;
    child.once("message", (message) => {
      reply = message as ProjectModulesReply;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (!reply) {
        reject(
          new Error(
            `Reading the project's modules stopped (${signal ?? `exit code ${code}`})`,
          ),
        );
        return;
      }
      const ui = getProcessUi();
      for (const message of reply.messages) ui.message(...message);
      if ("modules" in reply) resolve(reply.modules);
      else if ("problem" in reply) reject(new CliError(reply.problem));
      else reject(new Error(reply.failure));
    });
    child.send(options);
  });
}

/**
 * Kept in step with the DMS's own rewrite of its manifest: an origin is only
 * replaced whole, where it ends the string or a path, query or fragment
 * follows, so `http://h:5010` does not match inside `http://h:50100`.
 */
const URL_BOUNDARY = "(?=[/?#]|$)";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each origin of `rewrites` replaced in every string of the options. */
function rewriteOrigins(
  options: FrontendModuleOptions,
  rewrites: readonly OriginRewrite[],
): FrontendModuleOptions {
  if (rewrites.length === 0) return options;
  const replacements = new Map(rewrites.map(({ from, to }) => [from, to]));
  const alternation = [...replacements.keys()]
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(`(?:${alternation})${URL_BOUNDARY}`, "g");
  const rewrite = (value: FrontendModuleValue): FrontendModuleValue => {
    if (typeof value === "string")
      return value.replace(
        pattern,
        (match) => replacements.get(match) ?? match,
      );
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === "object")
      return rewriteObject(value);
    return value;
  };
  const rewriteObject = (value: FrontendModuleOptions): FrontendModuleOptions =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewrite(item)]),
    );
  return rewriteObject(options);
}

/**
 * Warns about each module the project and the backend disagree on: the
 * difference a build would make, seen in development.
 */
export function warnModuleDrift(
  layers: readonly ResolvedLayer[],
  manifest: Manifest,
): void {
  const served = new Set(layers.map((layer) => layer.name ?? ""));
  const registered = new Set(manifest.modules.map((module) => module.name));
  const ui = getProcessUi();
  for (const name of served) {
    if (!registered.has(name))
      ui.message(
        "warn",
        `${name} is served from the project, but the backend does not register it`,
        {
          detail:
            "Its frontendModule returns a registration the running backend did not add: check the module's configuration and startup",
        },
      );
  }
  for (const name of registered) {
    if (!served.has(name))
      ui.message(
        "warn",
        `${name} is registered by the backend, but not in the project: its pages are left out`,
        {
          detail: `A build leaves it out too. Declare its frontendModule (dmsFrontend in its package.json), or add the module to antelope.config.ts`,
        },
      );
  }
}

/**
 * The project's layers with the backend's values: each module's private
 * options filled from the ones the backend serves it, and the backend's
 * development origins applied to its options. A module the backend does not
 * register keeps its private options empty.
 */
export function withBackendValues(
  modules: readonly ProjectFrontendModule[],
  manifest: Manifest,
): ResolvedLayer[] {
  const registered = new Map(
    manifest.modules.map((module) => [module.name, module]),
  );
  return modules.map(({ layer }) => ({
    ...layer,
    options:
      layer.options &&
      rewriteOrigins(layer.options, manifest.originRewrites ?? []),
    privateOptions:
      layer.privateOptions &&
      filledOptions(
        layer.privateOptions,
        registered.get(layer.name ?? "")?.privateOptions,
      ),
  }));
}

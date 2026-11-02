import { join } from "node:path";
import { pathToFileURL } from "node:url";

type ServerTemplate = typeof import("../../templates/vue/server.mjs");

/** The request handler of the server a test built in `workspace`. */
export async function requestHandlerOf(
  workspace: string,
): Promise<ServerTemplate["handleRequestSafely"]> {
  // SAFETY: each caller builds `workspace` from a verbatim copy of `templates/vue` (`cpSync` or `copyStaticTemplates`), so `server.mjs` is the file `ServerTemplate` names.
  const server = (await import(
    pathToFileURL(join(workspace, "server.mjs")).href
  )) as ServerTemplate;
  return server.handleRequestSafely;
}

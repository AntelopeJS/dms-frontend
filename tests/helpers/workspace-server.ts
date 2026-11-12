import { templateModule } from "./template-copy";

type ServerTemplate = typeof import("../../templates/vue/server.mjs");

/** The request handler of the server a test built in `workspace`. */
export async function requestHandlerOf(
  workspace: string,
): Promise<ServerTemplate["handleRequestSafely"]> {
  return (await templateModule(workspace, "server.mjs")).handleRequestSafely;
}

import type { ViteDevServer } from "vite";
import type { renderDmsPage } from "../../templates/vue/ssr-renderer.ts";

/** What a development server loads from the workspace's `ssr-renderer.ts`. */
export interface ServerRenderer {
  renderDmsPage: typeof renderDmsPage;
}

/** The workspace's server renderer, as `server` loads it. */
export async function loadServerRenderer(
  server: ViteDevServer,
): Promise<ServerRenderer> {
  return (await server.ssrLoadModule("/ssr-renderer.ts")) as ServerRenderer;
}

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ViteDevServer } from "vite";
import { isText } from "../../src/internal/guards";

/** The modules of `templates/vue` a test loads from a copy of it, by their path there. */
interface TemplateModules {
  "server.mjs": typeof import("../../templates/vue/server.mjs");
  "server/email.mjs": typeof import("../../templates/vue/server/email.mjs");
  "server/module-server.mjs": typeof import("../../templates/vue/server/module-server.mjs");
  "ssr-renderer.ts": typeof import("../../templates/vue/ssr-renderer.ts");
}

/**
 * A module of a copy of `templates/vue`: imported from the workspace that
 * holds the copy, or loaded by a development server rooted in it.
 */
export async function templateModule<Path extends keyof TemplateModules>(
  copy: string | ViteDevServer,
  path: Path,
): Promise<TemplateModules[Path]> {
  const loaded: unknown = isText(copy)
    ? await import(pathToFileURL(join(copy, path)).href)
    : await copy.ssrLoadModule(`/${path}`);
  // SAFETY: every caller's workspace, or the root of its development server, holds a verbatim copy of `templates/vue` (`cpSync` or `copyStaticTemplates`), so the file at `path` is the one `TemplateModules` types it from.
  return loaded as TemplateModules[Path];
}

// The secret that guards the generated server's HTML render route.
//
// The DMS backend signs every render request it sends to the frontend with
// its `htmlRender.serviceSecret`, and serves that same secret to the renderer
// in the frontend manifest (`privateOptions.htmlRender.serviceSecret`). The
// generated server checks the signature against `DMS_HTML_RENDER_SECRET`, so
// the commands that run it hand the manifest's value over under that name.

import type { ManifestModule } from "./workspace";

const HTML_RENDER_SECRET_ENV = "DMS_HTML_RENDER_SECRET";

/**
 * The render secret the backend published in the manifest, if any. The first
 * module that carries a non-empty one wins: the DMS module is the only one
 * expected to, and a backend configured without a secret serves `null`.
 */
export function manifestHtmlRenderSecret(
  modules: readonly ManifestModule[],
): string | undefined {
  for (const module of modules) {
    const htmlRender = module.privateOptions?.htmlRender;
    if (!htmlRender || typeof htmlRender !== "object") continue;
    if (Array.isArray(htmlRender)) continue;
    const secret = htmlRender.serviceSecret;
    if (typeof secret === "string" && secret !== "") return secret;
  }
  return undefined;
}

/**
 * The value the generated server receives as `DMS_HTML_RENDER_SECRET`. A
 * value set explicitly in the environment (or the project's `.env`) takes
 * precedence over the manifest, so a deployment that already provides the
 * variable keeps the secret it chose.
 */
export function resolveHtmlRenderSecret(
  manifestSecret: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = env[HTML_RENDER_SECRET_ENV];
  if (explicit) return explicit;
  return manifestSecret;
}

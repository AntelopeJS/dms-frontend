// The files the renderer answers itself: in development, the sources and the
// `public/` files Vite serves; in production, the built assets.

import { existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { publicBuildFile } from "./built-files.mjs";
import { serveStaticFile } from "./static-files.mjs";
import { runViteMiddlewares, writeViteError } from "./vite-errors.mjs";

async function answeredByVite(devServer, request, response) {
  const result = await runViteMiddlewares(devServer, request, response);
  if (result.status === "failed") writeViteError(response, result.error);
  return result.status !== "unhandled";
}

/**
 * Send the built file `pathname` names, or `false` when the build has none
 * there. `publicBuildFile` decides which file that is; `serveStaticFile` how
 * it goes out.
 */
function serveAsset(clientRoot, pathname, request, response) {
  const file = publicBuildFile(clientRoot, pathname);
  if (!file) return false;
  serveStaticFile(file, request, response, {
    immutable: pathname.startsWith("/assets/"),
  });
  return true;
}

/**
 * Whether the renderer has a file at `pathname`: a development source Vite
 * serves (under the workspace or its `public/`), or a built asset the
 * production server serves from `clientRoot`. Only a path with an extension
 * names one.
 */
export function hasRendererFile(devServer, clientRoot, requested) {
  let pathname;
  try {
    // As Vite and the asset server read it: `%2E` is a dot.
    pathname = decodeURIComponent(requested);
  } catch {
    return false;
  }
  if (extname(pathname) === "") return false;
  if (!devServer) return publicBuildFile(clientRoot, requested) !== undefined;
  const roots = [devServer.config.root, devServer.config.publicDir].filter(
    Boolean,
  );
  return roots.some((root) => {
    const file = resolve(root, `.${pathname}`);
    return (
      file.startsWith(`${resolve(root)}${sep}`) &&
      existsSync(file) &&
      statSync(file).isFile()
    );
  });
}

/** Vite's files in development, the build's in production; else a 404. */
export async function serveRendererFile(
  devServer,
  clientRoot,
  request,
  response,
  pathname,
) {
  const answered = devServer
    ? await answeredByVite(devServer, request, response)
    : serveAsset(clientRoot, pathname, request, response);
  if (answered) return;
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}

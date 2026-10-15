// Keeping server code out of the browser.
//
// A module's `dms.server.ts` and the files under its `server/` directories run
// in the generated server only: they read private options, sign tokens, talk
// to the backend with its secrets. A client file that imports one of them,
// even statically and through an alias, would ship that code in the client
// bundle. Rollup's manifest only lists entries and dynamic imports, so a check
// on the built output misses a static import; the guard sits in the module
// graph instead, where every resolved file passes.
//
// Kept beside vite.config.ts rather than inside it so the plugin can be
// exercised on its own, the way head-order.mjs is.

import { relative, sep } from "node:path";

const SERVER_ENTRY = /(?:^|[\\/])dms\.server\.[cm]?[jt]sx?$/;

function stripQuery(id) {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

function insideModuleServerDirectory(file, moduleRoots) {
  return moduleRoots.some((root) => {
    const path = relative(root, file);
    if (!path || path.startsWith("..") || path.startsWith(sep)) return false;
    const segments = path.split(/[\\/]/);
    return segments.slice(0, -1).includes("server");
  });
}

/**
 * Whether `id`, a resolved module id, is server code: a module's server entry
 * (`dms.server.*`) or a file under a `server/` directory of a module. Installed
 * packages never are: `node_modules` has its own `server` directories.
 */
export function isServerSource(id, moduleRoots) {
  if (id.startsWith("\0")) return false;
  const file = stripQuery(id);
  if (/[\\/]node_modules[\\/]/.test(file)) return false;
  return (
    SERVER_ENTRY.test(file) || insideModuleServerDirectory(file, moduleRoots)
  );
}

/**
 * Fail a client build, and a client request in development, that loads server
 * code. Server-side rendering and the server modules build load it through
 * SSR, which the guard leaves alone.
 */
export function rejectServerSourcesInClient(moduleRoots) {
  let ssrBuild = false;
  return {
    name: "dms-reject-server-sources-in-client",
    enforce: "pre",
    configResolved(config) {
      ssrBuild = Boolean(config.build.ssr);
    },
    load(id, options) {
      if (ssrBuild || options?.ssr) return null;
      if (!isServerSource(id, moduleRoots)) return null;
      const importers = this.getModuleInfo?.(id)?.importers ?? [];
      const from = importers.length
        ? ` (imported by ${importers.join(", ")})`
        : "";
      this.error(
        `Server code in the client bundle: ${stripQuery(id)}${from}. ` +
          "A dms.server.ts and the files under a module's server/ directory " +
          "run in the server only; import them from a dms.server.ts, never from client code.",
      );
    },
  };
}

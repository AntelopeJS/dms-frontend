import { relative, resolve, sep } from "node:path";

const PRIVATE_FILE_NAMES = new Set([
  "generated-server-options.json",
  ".manifest-cache.json",
]);
const SERVER_ENTRY = /^dms\.server\./;
const MODULES_DIRECTORY = "frontend-modules";
const FORBIDDEN_STATUS = 403;

/**
 * Vite's `server.fs.deny` for the development server: Vite's own defaults,
 * which a `deny` list replaces, and the private files: the generated secrets
 * and the modules' server code are never served.
 */
export const DEV_FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem}",
  "**/.git/**",
  ...PRIVATE_FILE_NAMES,
  "dms.server.*",
  `**/${MODULES_DIRECTORY}/**/server/**`,
];

/**
 * Whether `file`, an absolute path, is private: a generated secret-bearing
 * file, a module's server entry, or a file under a `server/` directory of a
 * module materialized under `root`. Compared without case, as a
 * case-insensitive file system would serve them.
 */
export function isPrivateFile(file, root) {
  const name = (resolve(file).split(/[\\/]/).at(-1) ?? "").toLowerCase();
  if (PRIVATE_FILE_NAMES.has(name) || SERVER_ENTRY.test(name)) return true;
  const segments = relative(root, file).toLowerCase().split(/[\\/]/);
  return (
    segments[0] === MODULES_DIRECTORY &&
    segments.slice(1, -1).includes("server")
  );
}

function stripQuery(id) {
  const query = id.search(/[?#]/);
  return query === -1 ? id : id.slice(0, query);
}

/** The file a request URL names under `root`, `undefined` when it names none. */
function requestedFile(url, root) {
  let pathname;
  try {
    pathname = decodeURIComponent(stripQuery(url ?? ""));
  } catch {
    return undefined;
  }
  if (pathname.startsWith("/@fs/")) return resolve(pathname.slice(4));
  if (pathname.startsWith("/@id/")) pathname = pathname.slice(4);
  return resolve(root, `.${sep}${pathname.replace(/^[\\/]+/, "")}`);
}

/**
 * Answers 403 to private files, and fails a client load of one.
 *
 * The files of the workspace the development server never hands to a
 * browser. Vite's root is the workspace root, where the generated server
 * options (the modules' private options: the backend's secrets) and the
 * cached manifest are written, and the modules' server code is materialized
 * under it. Vite serves any file under its root, as is, `?raw`, `?import` or
 * `?url`. Its `server.fs.deny` list covers most of these, but not every
 * query combination (`?import&raw` got through in Vite 7.2; Vite 8.3 refuses
 * it itself), so a middleware ahead of Vite's own answers 403 by path,
 * whatever the query, and a load guard refuses them to any client request
 * that reaches the transform pipeline another way. `ssrLoadModule`, which
 * loads the server modules, is left alone.
 *
 * The middleware is registered directly, not returned: it runs before Vite's
 * middlewares.
 */
export function denyPrivateFiles() {
  let root = process.cwd();
  return {
    name: "dms-deny-private-files",
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const file = requestedFile(request.url, root);
        if (!file || !isPrivateFile(file, root)) return next();
        response.statusCode = FORBIDDEN_STATUS;
        response.setHeader("content-type", "text/plain; charset=utf-8");
        response.end("Forbidden");
      });
    },
    load(id, options) {
      if (options?.ssr || id.startsWith("\0")) return null;
      if (!isPrivateFile(stripQuery(id), root)) return null;
      this.error(
        `${stripQuery(id)} is private to the server and never served to the browser.`,
      );
    },
  };
}

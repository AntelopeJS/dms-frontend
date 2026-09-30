const INTERNAL_ERROR_STATUS = 500;
const ERROR_CONTENT_TYPE = "text/plain; charset=utf-8";
const VITE_ERROR = Symbol("dms.viteError");

/**
 * In middleware mode, Vite's own error middleware logs an error, sends it to
 * the client overlay, then passes the request on with no error: a module that
 * fails to transform would fall through to page handling and answer 404. This
 * plugin runs just before it, keeps the error on the request and hands it on,
 * so Vite still logs it and shows the overlay.
 */
export function captureViteErrors() {
  return {
    name: "dms-capture-vite-errors",
    apply: "serve",
    configureServer(server) {
      return () =>
        server.middlewares.use((error, request, _response, next) => {
          request[VITE_ERROR] = error;
          next(error);
        });
    },
  };
}

/**
 * Hands a request to Vite's middlewares. Resolves `handled` once Vite answered
 * it, `unhandled` when Vite passed it on, and `failed` with the error when a
 * Vite middleware failed on it.
 */
export function runViteMiddlewares(devServer, request, response) {
  return new Promise((resolve) => {
    devServer.middlewares(request, response, (error) => {
      const failure = error ?? request[VITE_ERROR];
      resolve(
        failure
          ? { status: "failed", error: failure }
          : { status: "unhandled" },
      );
    });
    response.once("finish", () => resolve({ status: "handled" }));
  });
}

/** Answers 500 with Vite's error message instead of rendering a page. */
export function writeViteError(response, error) {
  response.statusCode = INTERNAL_ERROR_STATUS;
  response.setHeader("content-type", ERROR_CONTENT_TYPE);
  response.end(error?.message ?? String(error));
}

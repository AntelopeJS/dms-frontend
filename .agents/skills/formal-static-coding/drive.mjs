import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { publicBuildFile } from "../../../templates/vue/server/built-files.mjs";
import { serveStaticFile } from "../../../templates/vue/server/static-files.mjs";
import { render } from "./contract.mjs";

/** @typedef {import("./contract.mjs").Representation} Representation */
/** @typedef {import("./inputs.mjs").Case} Case */
/**
 * What one visit got: the status, the `Content-Encoding` header, and which
 * file's bytes came back (`undefined` for a HEAD request, which has no body).
 *
 * @typedef {{ status: number, encoding: string | undefined, body: Representation | undefined }} Observation
 */

const VISIT_TIMEOUT_MS = 10_000;
const SCRIPT = "export const probe = 1;\n".repeat(64);
const BODIES = { plain: SCRIPT, br: "brotli bytes", gzip: "gzip bytes" };

/**
 * Which copy a body came from.
 *
 * @param {string} text
 * @returns {Representation | undefined}
 */
function copyOf(text) {
  if (text === BODIES.br) return "br";
  if (text === BODIES.gzip) return "gzip";
  return text === BODIES.plain ? "plain" : undefined;
}

/**
 * The built file that has exactly the copies a case names, under `/assets/`
 * as Vite writes them: the file, plus `.br` and `.gz` copies.
 *
 * @param {import("./contract.mjs").Copies} copies
 */
const assetOf = (copies) => `/assets/app-${copies.br ? "br" : "no"}${copies.gzip ? "gz" : "no"}-abc123.js`;

/**
 * Writes a built directory with the four sets of copies and serves it as
 * `templates/vue/server.mjs` serves `dist/client`: `publicBuildFile` names the
 * file, `serveStaticFile` sends it. The server itself needs a built client to
 * start, which a scratch directory cannot stand in for.
 *
 * @returns {Promise<{ visit: (current: Case) => Promise<Observation>, close: () => Promise<void> }>}
 */
export async function startServer() {
  const root = await mkdtemp(path.join(tmpdir(), "formal-static-coding-"));
  await mkdir(path.join(root, "assets"));
  for (const br of [false, true]) {
    for (const gzip of [false, true]) {
      const file = path.join(root, assetOf({ br, gzip }));
      await writeFile(file, BODIES.plain);
      if (br) await writeFile(`${file}.br`, BODIES.br);
      if (gzip) await writeFile(`${file}.gz`, BODIES.gzip);
    }
  }
  const server = createServer((incoming, answer) => {
    const pathname = new URL(incoming.url ?? "/", "http://frontend").pathname;
    const file = publicBuildFile(root, pathname);
    if (!file) {
      answer.writeHead(404);
      answer.end();
      return;
    }
    serveStaticFile(file, incoming, answer, { immutable: true });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (address === null || !("port" in address)) throw new Error("the server is not listening on a port");
  const { port } = address;

  /** @param {Case} current */
  const visit = ({ copies, header, method }) =>
    new Promise((resolve, reject) => {
      /** @type {Record<string, string>} */
      const headers = {};
      const sent = render(header);
      if (sent !== undefined) headers["accept-encoding"] = sent;
      const outgoing = request({ host: "127.0.0.1", port, method, path: assetOf(copies), headers, agent: false }, (answer) => {
        /** @type {Buffer[]} */
        const chunks = [];
        answer.on("data", (/** @type {Buffer} */ chunk) => chunks.push(chunk));
        answer.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          const encoding = answer.headers["content-encoding"];
          resolve({ status: answer.statusCode ?? 0, encoding: Array.isArray(encoding) ? encoding.join(",") : encoding, body: method === "HEAD" ? undefined : copyOf(text) });
        });
      });
      outgoing.setTimeout(VISIT_TIMEOUT_MS, () => outgoing.destroy(new Error(`${method} ${assetOf(copies)} got no answer in ${VISIT_TIMEOUT_MS} ms`)));
      outgoing.on("error", reject);
      outgoing.end();
    });

  return {
    visit,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await rm(root, { recursive: true, force: true });
    },
  };
}

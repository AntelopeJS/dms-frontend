import { Buffer } from "node:buffer";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * @typedef {object} Exchange
 * @property {number} status
 * @property {Record<string, string | string[]>} headers Lowercase names; `set-cookie` is a list
 * @property {string[]} rawHeaders
 * @property {Buffer} body
 * @property {string} text
 * @property {number} headersAt Milliseconds from the start to the response head
 * @property {number} endedAt Milliseconds from the start to the end of the response
 */

/**
 * One HTTP/1.1 request with the path exactly as given (`fetch` would
 * normalize `..` and `%2e%2e`), on its own connection.
 *
 * @param {string} base The server's URL
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: Buffer | string, chunks?: (Buffer | string)[], timeoutMs?: number, keepAlive?: boolean }} options What to send; `chunks` sends a chunked body
 * @returns {Promise<Exchange>} The answer
 */
export function exchange(base, options) {
  const url = new URL(base);
  const startedAt = Date.now();
  /** @type {Record<string, string>} */
  const headers = { connection: "close" };
  if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
  Object.assign(headers, options.headers);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: url.hostname,
      port: Number(url.port),
      method: options.method ?? "GET",
      path: options.path,
      agent: false,
      headers,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", reject);
    request.on("response", (response) => {
      const headersAt = Date.now() - startedAt;
      /** @type {Buffer[]} */
      const parts = [];
      response.on("data", (/** @type {Buffer} */ part) => parts.push(part));
      response.on("error", reject);
      response.on("end", () => {
        const body = Buffer.concat(parts);
        const answered = Object.fromEntries(
          Object.entries(response.headers).map(([name, value]) => [name, value ?? ""]),
        );
        resolve({
          status: response.statusCode ?? 0,
          headers: answered,
          rawHeaders: response.rawHeaders,
          body,
          text: body.toString("utf8"),
          headersAt,
          endedAt: Date.now() - startedAt,
        });
      });
    });
    if (options.chunks) {
      for (const chunk of options.chunks) request.write(chunk);
      request.end();
    } else request.end(options.body);
  });
}

/**
 * A request written byte by byte on a TCP socket, for targets and framing
 * `http.request` refuses (an absolute-form target, a backslash).
 *
 * @param {string} base The server's URL
 * @param {string} head The request head, lines joined with CRLF and ended by an empty line
 * @returns {Promise<{ status: number, text: string }>} The status line's code and the whole answer
 */
export function rawExchange(base, head) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    /** @type {Buffer[]} */
    const parts = [];
    socket.setTimeout(DEFAULT_TIMEOUT_MS, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(head));
    socket.on("data", (part) => parts.push(part));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(parts).toString("utf8");
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text });
    });
  });
}

/**
 * @param {Exchange} answer An answer
 * @returns {unknown} Its body as JSON, or the text when it is not JSON
 */
export function bodyJson(answer) {
  try {
    return JSON.parse(answer.text);
  } catch {
    return answer.text;
  }
}

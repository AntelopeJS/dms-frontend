import { Buffer } from "node:buffer";
import { brotliDecompressSync, gunzipSync, gzipSync, createGunzip } from "node:zlib";
import { get as httpGet } from "node:http";
import { exchange } from "./proxy-http.mjs";
import { observe, sleep, withSatellite } from "./proxy-satellite.mjs";

/**
 * @param {number} length How many bytes
 * @returns {Buffer} Text of that length
 */
const sentence = (length) => Buffer.from("the quick brown fox jumps over the lazy dog ".repeat(Math.ceil(length / 44)).slice(0, length));

/**
 * @typedef {object} Route
 * @property {string} type
 * @property {Buffer} body
 * @property {Record<string, string>} [headers]
 * @property {number} [status]
 * @property {Buffer} [decoded]
 */

/** The backend's routes by path. @type {Record<string, Route>} */
const ROUTES = {
  "/api/json-1023": { type: "application/json", body: sentence(1023) },
  "/api/json-1024": { type: "application/json", body: sentence(1024) },
  "/api/json-big": { type: "application/json; charset=utf-8", body: sentence(4096), headers: { etag: '"strong-tag"', vary: "Origin", "x-keep": "kept" } },
  "/api/vary-star": { type: "application/json", body: sentence(2048), headers: { vary: "*" } },
  "/api/vary-encoding": { type: "application/json", body: sentence(2048), headers: { vary: "accept-encoding, Origin" } },
  "/api/text": { type: "text/plain", body: sentence(2048) },
  "/api/xml": { type: "application/xml", body: sentence(2048) },
  "/api/xml-text": { type: "text/xml", body: sentence(2048) },
  "/api/js": { type: "application/javascript", body: sentence(2048) },
  "/api/svg": { type: "image/svg+xml", body: sentence(2048) },
  "/api/problem": { type: "application/problem+json", body: sentence(2048) },
  "/api/png": { type: "image/png", body: sentence(2048) },
  "/api/octet": { type: "application/octet-stream", body: sentence(2048) },
  "/api/pdf": { type: "application/pdf", body: sentence(2048) },
  "/api/notransform": { type: "application/json", body: sentence(2048), headers: { "cache-control": "public, no-transform" } },
  "/api/range": { type: "application/json", body: sentence(2048), status: 206, headers: { "content-range": "bytes 0-2047/9999" } },
  "/api/unknown-coding": { type: "application/json", body: sentence(2048), headers: { "content-encoding": "x-custom" } },
  "/api/identity-coding": { type: "application/json", body: sentence(2048), headers: { "content-encoding": "identity" } },
  "/api/gzipped": { type: "application/json", body: gzipSync(sentence(4096)), headers: { "content-encoding": "gzip", etag: '"gz-tag"' }, decoded: sentence(4096) },
  "/api/gzipped-range": { type: "application/json", body: gzipSync(sentence(4096)), status: 206, headers: { "content-encoding": "gzip", "content-range": "bytes 0-9/99" } },
  "/api/no-content": { type: "application/json", body: Buffer.alloc(0), status: 204 },
  "/api/hop": { type: "application/json", body: sentence(2048), headers: { connection: "x-hop, close", "x-hop": "gone", "keep-alive": "timeout=5", "x-keep": "kept" } },
  "/api/error": { type: "application/json", body: Buffer.from('{"message":"error.teapot"}'), status: 418 },
};

/**
 * @param {import("node:http").IncomingMessage} request The request
 * @param {import("node:http").ServerResponse} response The response
 */
function backend(request, response) {
  const path = (request.url ?? "").split("?")[0];
  const route = ROUTES[path];
  request.resume();
  if (path === "/api/chunked-small") {
    response.writeHead(200, { "content-type": "application/json" });
    response.write(sentence(40));
    response.end(sentence(40));
    return;
  }
  if (path === "/api/chunked-image") {
    response.writeHead(200, { "content-type": "image/png" });
    response.end(sentence(40));
    return;
  }
  if (path === "/api/events") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${sentence(2048).toString()}\n\n`);
    return;
  }
  if (!route) {
    response.writeHead(404);
    response.end();
    return;
  }
  /** @type {Record<string, string>} */
  const headers = { "content-type": route.type };
  if (route.status !== 204) headers["content-length"] = String(route.body.length);
  Object.assign(headers, route.headers);
  response.writeHead(route.status ?? 200, headers);
  response.end(request.method === "HEAD" ? undefined : route.body);
}

const BIG = ROUTES["/api/json-big"].body;

/**
 * @param {import("./proxy-http.mjs").Exchange} answer An answer
 * @returns {Buffer} The body, decoded as its Content-Encoding says
 */
function decoded(answer) {
  const encoding = answer.headers["content-encoding"];
  if (encoding === "br") return brotliDecompressSync(answer.body);
  if (encoding === "gzip") return gunzipSync(answer.body);
  return answer.body;
}

const SELECTIONS = [
  ["br", "br"],
  ["gzip", "gzip"],
  ["br, gzip", "br"],
  ["gzip, br", "br"],
  ["gzip;q=1.0, br;q=0.5", "gzip"],
  ["gzip;q=0.5, br;q=0.9", "br"],
  ["br;q=0, gzip", "gzip"],
  ["gzip;q=0, br;q=0", undefined],
  ["*", "br"],
  ["*;q=0.5, gzip;q=0.6", "gzip"],
  ["gzip;q=0, *", "br"],
  ["deflate", undefined],
  ["identity", undefined],
  ["identity;q=1, br;q=0.1", undefined],
  ["gzip;q=abc", undefined],
  ["gzip;q=1.5", undefined],
  ["BR", "br"],
  [undefined, undefined],
];

/**
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {{ backendEndedAt: number | null }} timeline When the backend finished writing
 * @returns {Promise<{ firstDecodedBeforeBackendEnd: boolean, text: string }>} Whether the first part came early
 */
function streamedGzip(server, timeline) {
  return new Promise((resolve, reject) => {
    const request = httpGet(`${server.url}/api/slow-json`, { headers: { "accept-encoding": "gzip" } }, (response) => {
      const gunzip = createGunzip();
      let early = null;
      let text = "";
      gunzip.on("data", (part) => {
        text += part.toString();
        if (early === null) early = timeline.backendEndedAt === null;
      });
      gunzip.on("error", reject);
      gunzip.on("end", () => resolve({ firstDecodedBeforeBackendEnd: early === true, text }));
      response.pipe(gunzip);
    });
    request.on("error", reject);
  });
}

/** @typedef {import("./control.d.ts").JourneyContext} Context */
/** @typedef {import("./proxy-satellite.mjs").Satellite} Server */
/** @typedef {(path: string, encoding: string | undefined, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} Getter */

/**
 * @param {Server} server The server
 * @returns {Getter} A fetch that names the request in its failure
 */
function getter(server) {
  return (path, encoding, method = "GET") =>
    exchange(server.url, { method, path, headers: encoding === undefined ? {} : { "accept-encoding": encoding } }).catch((/** @type {unknown} */ error) => {
      throw new Error(`${method} ${path} (${String(encoding)}): ${error instanceof Error ? error.message : String(error)}`);
    });
}

/**
 * The encoding the proxy picks and the headers that go with it.
 *
 * @param {Context} ctx The journey
 * @param {Getter} get Fetches through the server
 */
async function checkEncodings(ctx, get) {
        /** @type {{ header: string | undefined, expected: string | undefined, got: string | string[] | undefined, equalBody: boolean, vary: string | string[] | undefined, length: string | string[] | null }[]} */
  const rows = [];
    for (const [header, expected] of SELECTIONS) {
      const answer = await get("/api/json-big", header);
      rows.push({ header, expected, got: answer.headers["content-encoding"], equalBody: decoded(answer).equals(BIG), vary: answer.headers.vary, length: answer.headers["content-length"] ?? null });
    }
    observe(ctx, "Accept-Encoding qualities pick Brotli, gzip or nothing", rows, [
      ctx.equal("the encoding chosen for every Accept-Encoding", rows.map((row) => [row.header, row.got]), SELECTIONS.map(([header, expected]) => [header, expected])),
      ctx.equal("every body decodes to the backend's bytes", rows.map((row) => row.equalBody), rows.map(() => true)),
      ctx.equal("every eligible answer carries the backend's Vary and Accept-Encoding, compressed or not", rows.map((row) => row.vary), rows.map(() => "Origin, Accept-Encoding")),
      ctx.equal("a compressed answer has no Content-Length (its length is no longer known)", rows.filter((row) => row.got).map((row) => row.length), rows.filter((row) => row.got).map(() => null)),
    ]);

    const compressed = await get("/api/json-big", "gzip");
    const plain = await get("/api/json-big", undefined);
    observe(ctx, "representation headers of a compressed and an uncompressed answer", { compressed: compressed.headers, plain: plain.headers }, [
      ctx.equal("a strong ETag becomes weak when the proxy compresses", compressed.headers.etag, 'W/"strong-tag"'),
      ctx.equal("the ETag is untouched when the proxy sends the bytes as they are", plain.headers.etag, '"strong-tag"'),
      ctx.equal("the uncompressed answer keeps the backend's Content-Length", plain.headers["content-length"], String(BIG.length)),
      ctx.equal("other headers of the backend are relayed", [compressed.headers["x-keep"], compressed.headers["content-type"]], ["kept", "application/json; charset=utf-8"]),
    ]);

    /** @type {Record<string, import("./proxy-http.mjs").Exchange>} */
  const sizes = {};
    for (const path of ["/api/json-1023", "/api/json-1024"]) sizes[path] = await get(path, "gzip");
    const smallChunked = await get("/api/chunked-small", "gzip");
    const smallImage = await get("/api/chunked-image", "gzip");
    observe(ctx, "the 1 KiB threshold, and the unknown length", { 1023: sizes["/api/json-1023"].headers, 1024: sizes["/api/json-1024"].headers, chunked: smallChunked.headers }, [
      ctx.equal("1023 bytes are not compressed and get no Vary", [sizes["/api/json-1023"].headers["content-encoding"] ?? null, sizes["/api/json-1023"].headers.vary ?? null], [null, null]),
      ctx.equal("1024 bytes are compressed", sizes["/api/json-1024"].headers["content-encoding"], "gzip"),
      ctx.equal("both decode to the backend's bytes", [decoded(sizes["/api/json-1023"]).length, decoded(sizes["/api/json-1024"]).length], [1023, 1024]),
      ctx.equal("a small answer of unknown length is compressed", [smallChunked.headers["content-encoding"], decoded(smallChunked).toString().length], ["gzip", 80]),
      ctx.equal("an unknown length of a type that is never compressed is not", [smallImage.headers["content-encoding"] ?? null, smallImage.headers.vary ?? null], [null, null]),
    ]);
}

/**
 * Which answers the proxy compresses.
 *
 * @param {Context} ctx The journey
 * @param {Getter} get Fetches through the server
 */
async function checkEligibility(ctx, get) {
    /** @type {Record<string, { encoding: string | string[] | null, vary: string | string[] | null }>} */
  const types = {};
    for (const path of ["/api/text", "/api/xml", "/api/xml-text", "/api/js", "/api/svg", "/api/problem", "/api/png", "/api/octet", "/api/pdf", "/api/events"]) {
      const answer = await get(path, "br");
      types[path] = { encoding: answer.headers["content-encoding"] ?? null, vary: answer.headers.vary ?? null };
    }
    observe(ctx, "which content types are compressed", types, [
      ctx.equal("JSON, text, XML, JavaScript and SVG are compressed", ["/api/text", "/api/xml", "/api/xml-text", "/api/js", "/api/svg", "/api/problem"].map((path) => types[path].encoding), ["br", "br", "br", "br", "br", "br"]),
      ctx.equal("an image, a binary, a PDF and an event stream are not, and carry no added Vary", ["/api/png", "/api/octet", "/api/pdf", "/api/events"].map((path) => [types[path].encoding, types[path].vary]), [[null, null], [null, null], [null, null], [null, null]]),
    ]);

    /** @type {Record<string, { status: number, encoding: string | string[] | null, vary: string | string[] | null, bytes: number }>} */
  const exceptions = {};
    for (const path of ["/api/notransform", "/api/range", "/api/unknown-coding", "/api/identity-coding"]) {
      const answer = await get(path, "gzip");
      exceptions[path] = { status: answer.status, encoding: answer.headers["content-encoding"] ?? null, vary: answer.headers.vary ?? null, bytes: answer.body.length };
    }
    const unknown = await get("/api/unknown-coding", "gzip");
    observe(ctx, "answers the proxy does not compress", exceptions, [
      ctx.equal("no-transform is left alone", [exceptions["/api/notransform"].encoding, exceptions["/api/notransform"].bytes], [null, 2048]),
      ctx.equal("a range (206 with Content-Range) is left alone", [exceptions["/api/range"].status, exceptions["/api/range"].encoding, exceptions["/api/range"].bytes], [206, null, 2048]),
      ctx.equal("a body in an encoding the proxy does not know is relayed as it is, with the backend's coding", [unknown.headers["content-encoding"], unknown.body.equals(ROUTES["/api/unknown-coding"].body)], ["x-custom", true]),
      ctx.equal("an explicit identity coding is compressed like no coding", exceptions["/api/identity-coding"].encoding, "gzip"),
    ]);
}

/**
 * Answers whose coding or length the proxy has to repair.
 *
 * @param {Context} ctx The journey
 * @param {Getter} get Fetches through the server
 */
async function checkBackendEncodings(ctx, get) {
    const stale = await get("/api/gzipped", undefined);
    const staleGzip = await get("/api/gzipped", "gzip");
    const staleBr = await get("/api/gzipped", "br");
    const staleRange = await get("/api/gzipped-range", "gzip");
    observe(ctx, "a backend that ignores the request for an uncompressed answer", { stale: stale.headers, staleGzip: staleGzip.headers, staleBr: staleBr.headers, staleRange: { status: staleRange.status, headers: staleRange.headers } }, [
      ctx.equal("the proxy decodes it and removes the stale coding and length for a client that accepts none", [stale.headers["content-encoding"] ?? null, stale.headers["content-length"] ?? null, stale.body.equals(ROUTES["/api/gzipped"].decoded)], [null, null, true]),
      ctx.equal("the ETag is weakened since the bytes changed", stale.headers.etag, 'W/"gz-tag"'),
      ctx.equal("it compresses the decoded body again for a client that accepts gzip", [staleGzip.headers["content-encoding"], decoded(staleGzip).equals(ROUTES["/api/gzipped"].decoded)], ["gzip", true]),
      ctx.equal("and with Brotli when the client prefers it", [staleBr.headers["content-encoding"], decoded(staleBr).equals(ROUTES["/api/gzipped"].decoded)], ["br", true]),
      ctx.equal("a decoded range from an encoded body answers 502", staleRange.status, 502),
    ]);

    const head = await get("/api/json-big", "gzip", "HEAD");
    const headSmall = await get("/api/json-1023", "gzip", "HEAD");
    const none = await get("/api/no-content", "gzip");
    observe(ctx, "HEAD and bodiless answers keep their representation headers", { head: head.headers, none: { status: none.status, headers: none.headers } }, [
      ctx.equal("a HEAD answer has no body", [head.status, head.body.length], [200, 0]),
      ctx.equal("a HEAD answer keeps the backend's Content-Length and no coding", [head.headers["content-length"], head.headers["content-encoding"] ?? null], [String(BIG.length), null]),
      ctx.equal("a HEAD of an answer under the threshold also keeps its length", headSmall.headers["content-length"], "1023"),
      ctx.equal("a 204 has no body and no coding", [none.status, none.body.length, none.headers["content-encoding"] ?? null], [204, 0, null]),
    ]);
}

/**
 * The backend's Vary and hop-by-hop headers.
 *
 * @param {Context} ctx The journey
 * @param {Getter} get Fetches through the server
 */
async function checkHeaders(ctx, get) {
    /** @type {Record<string, string | string[] | undefined>} */
  const vary = {};
    for (const path of ["/api/vary-star", "/api/vary-encoding"]) vary[path] = (await get(path, "gzip")).headers.vary;
    observe(ctx, "the backend's Vary", vary, [
      ctx.equal("Vary: * stays", vary["/api/vary-star"], "*"),
      ctx.equal("an Accept-Encoding the backend already listed is not repeated", vary["/api/vary-encoding"], "accept-encoding, Origin"),
    ]);

    const hop = await get("/api/hop", undefined);
    const error = await get("/api/error", "gzip");
    observe(ctx, "hop-by-hop headers and error answers", { hop: hop.headers, error: { status: error.status, text: error.text } }, [
      ctx.equal("a header named by the backend's Connection header is removed, others are kept", [hop.headers["x-hop"] ?? null, hop.headers["keep-alive"] ?? null, hop.headers["x-keep"]], [null, null, "kept"]),
      ctx.equal("the backend's own connection options are not the client's", hop.headers.connection !== "x-hop, close", true),
      ctx.equal("a backend error status and body are relayed", [error.status, error.text], [418, '{"message":"error.teapot"}']),
    ]);
}

export const journeys = [
  {
    id: "proxy-answers",
    title: "the proxy compresses eligible answers by the client's qualities, leaves the rest alone, and keeps the representation headers right",
    entryPoint: "GET/HEAD through /api/** of a second `ajs dms start` whose backend answers many content types",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /** @type {{ backendEndedAt: number | null }} */
      const timeline = { backendEndedAt: null };
      /** @type {import("./proxy-satellite.mjs").BackendHandler} */
      const answering = (request, response) => {
        if (request.url === "/api/slow-json") {
          request.resume();
          response.writeHead(200, { "content-type": "application/json" });
          void (async () => {
            for (const part of ["alpha-", "beta-", "gamma"]) {
              response.write(part);
              await sleep(500);
            }
            timeline.backendEndedAt = Date.now();
            response.end();
          })();
          return;
        }
        backend(request, response);
      };
      await withSatellite(ctx, { backend: answering }, async (server) => {
        const get = getter(server);
        await checkEncodings(ctx, get);
        await checkEligibility(ctx, get);
        await checkBackendEncodings(ctx, get);
        await checkHeaders(ctx, get);

        const streamed = await streamedGzip(server, timeline);
        observe(ctx, "streaming compression delivers each part as the backend writes it", streamed, [
          ctx.equal("the whole body arrives", streamed.text, "alpha-beta-gamma"),
          ctx.equal("the first decoded part arrived while the backend was still writing", streamed.firstDecodedBeforeBackendEnd, true),
        ]);
      });
    },
  },
];

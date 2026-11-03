import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, sleep, withSatellite } from "./proxy-satellite.mjs";

const LIMIT = 1000;
const TOO_LARGE = { message: "Payload Too Large" };
const LINGER_MIN_MS = 4_500;
const LINGER_MAX_MS = 7_500;
const UPLOAD_LIMIT = 500 * 1024 * 1024;
const PROXIES = JSON.stringify([
  { path: "/cap/**", auth: "none", maxBodyBytes: LIMIT },
  { path: "/open/**", auth: "none" },
  { path: "/zero/**", auth: "none", maxBodyBytes: 0 },
  { path: "/negative/**", auth: "none", maxBodyBytes: -1 },
  { path: "/fraction/**", auth: "none", maxBodyBytes: 1.5 },
  { path: "/text/**", auth: "none", maxBodyBytes: "10" },
  { path: "/auth/**", auth: "bogus" },
]);

/**
 * Sends a request head and a part of the body on a socket, then watches.
 *
 * @param {string} base The server
 * @param {{ method: string, path: string, contentLength: number, sent: number, holdMs: number }} options What to send
 * @returns {Promise<{ head: string, headAt: number | null, closedAt: number | null, status: number }>} What came back
 */
function stalledUpload(base, options) {
  const url = new URL(base);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const socket = connect(Number(url.port), url.hostname);
    let received = "";
    /** @type {number | null} */
    let headAt = null;
    /** @type {number | null} */
    let closedAt = null;
    socket.on("connect", () => {
      socket.write(`${options.method} ${options.path} HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: ${options.contentLength}\r\n\r\n`);
      socket.write(Buffer.alloc(options.sent, 0x61));
    });
    socket.on("data", (part) => {
      received += part.toString("latin1");
      if (headAt === null && received.includes("\r\n\r\n")) headAt = Date.now() - startedAt;
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      closedAt = Date.now() - startedAt;
    });
    setTimeout(() => {
      socket.destroy();
      resolve({ head: received.split("\r\n\r\n")[0], headAt, closedAt, status: Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? 0) });
    }, options.holdMs);
  });
}

export const journeys = [
  {
    id: "proxy-limits",
    title: "maxBodyBytes: a declared length over the limit is refused before a byte is sent on, a chunked body is cut off, and the 413 reaches the client",
    entryPoint: "uploads through an operator-declared proxy of a second `ajs dms start`, and through the DMS's own /file-storage/upload/**",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /** @type {{ backendEndedAt: number | null }} */
      const timeline = { backendEndedAt: null };
      /** @type {import("./proxy-satellite.mjs").BackendHandler} */
      const backend = async (request, response) => {
        if (request.url === "/open/slow-download") {
          response.writeHead(200, { "content-type": "application/octet-stream" });
          for (let part = 0; part < 3; part += 1) {
            response.write(Buffer.alloc(4096, 0x66));
            await sleep(600);
          }
          response.end();
          timeline.backendEndedAt = Date.now();
          return;
        }
        await new Promise((resolve) => {
          request.on("end", resolve);
          request.on("close", resolve);
          request.resume();
        });
        if (response.writableEnded || response.destroyed) return;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
      };
      await withSatellite(ctx, { backend, env: { DMS_BACKEND_PROXIES: PROXIES } }, async (server) => {
        const log = server.log();
        /** @type {Record<number, { status: number, body: unknown, connection: string | string[] | undefined, type: string | string[] | undefined, backendBytes: number | null }>} */
        const attempts = {};
        for (const size of [0, LIMIT - 1, LIMIT, LIMIT + 1]) {
          const before = server.backend.to("/cap/declared").length;
          const answer = await exchange(server.url, { method: "PUT", path: "/cap/declared", body: Buffer.alloc(size, 0x62) });
          const seen = server.backend.to("/cap/declared")[before];
          attempts[size] = { status: answer.status, body: bodyJson(answer), connection: answer.headers.connection, type: answer.headers["content-type"], backendBytes: seen ? seen.body.length : null };
        }
        observe(ctx, "a declared Content-Length against maxBodyBytes=1000", attempts, [
          ctx.equal("an empty body passes", [attempts[0].status, attempts[0].backendBytes], [200, 0]),
          ctx.equal("one byte below the limit passes whole", [attempts[LIMIT - 1].status, attempts[LIMIT - 1].backendBytes], [200, LIMIT - 1]),
          ctx.equal("exactly the limit passes whole", [attempts[LIMIT].status, attempts[LIMIT].backendBytes], [200, LIMIT]),
          ctx.equal("one byte above the limit answers 413 with the documented body", [attempts[LIMIT + 1].status, attempts[LIMIT + 1].body, attempts[LIMIT + 1].type], [413, TOO_LARGE, "application/json"]),
          ctx.equal("the 413 closes the connection", attempts[LIMIT + 1].connection, "close"),
          ctx.equal("the backend never saw the refused request", attempts[LIMIT + 1].backendBytes, null),
        ]);

        /** @type {Record<number, { status: number, body: unknown, backendBytes: number | null, backendComplete: boolean | null }>} */
        const chunked = {};
        for (const size of [LIMIT - 1, LIMIT, LIMIT + 1]) {
          const before = server.backend.to("/cap/chunked").length;
          const half = Math.floor(size / 2);
          const answer = await exchange(server.url, {
            method: "POST",
            path: "/cap/chunked",
            headers: { "transfer-encoding": "chunked" },
            chunks: [Buffer.alloc(half, 0x63), Buffer.alloc(size - half, 0x63)],
          });
          await sleep(300);
          const seen = server.backend.to("/cap/chunked")[before];
          chunked[size] = { status: answer.status, body: bodyJson(answer), backendBytes: seen ? seen.body.length : null, backendComplete: seen ? seen.complete : null };
        }
        observe(ctx, "a chunked body against maxBodyBytes=1000", chunked, [
          ctx.equal("one byte below the limit passes whole", [chunked[LIMIT - 1].status, chunked[LIMIT - 1].backendBytes], [200, LIMIT - 1]),
          ctx.equal("exactly the limit passes whole", [chunked[LIMIT].status, chunked[LIMIT].backendBytes], [200, LIMIT]),
          ctx.equal("one byte above the limit is cut off with the 413", [chunked[LIMIT + 1].status, chunked[LIMIT + 1].body], [413, TOO_LARGE]),
          ctx.equal("the backend never received the whole refused body", chunked[LIMIT + 1].backendComplete === true, false),
        ]);

        const flood = await exchange(server.url, {
          method: "POST",
          path: "/cap/flood",
          headers: { "transfer-encoding": "chunked" },
          chunks: Array.from({ length: 64 }, () => randomBytes(64 * 1024)),
        });
        observe(ctx, "a client still sending 4 MiB when the limit is hit receives the 413, not a reset", { status: flood.status, body: bodyJson(flood), endedAt: flood.endedAt }, [
          ctx.equal("the 413 arrives with its body", [flood.status, bodyJson(flood)], [413, TOO_LARGE]),
        ]);

        const lingering = await stalledUpload(server.url, { method: "PUT", path: "/cap/linger", contentLength: 10_000_000, sent: 5000, holdMs: LINGER_MAX_MS + 1500 });
        observe(ctx, "a refused body that is not fully sent is drained for 5 seconds at most", lingering, [
          ctx.equal("the 413 head arrives at once", [lingering.status, lingering.headAt !== null && lingering.headAt < 1500], [413, true]),
          ctx.holds(`the connection is closed by the server after about 5 s (between ${LINGER_MIN_MS} and ${LINGER_MAX_MS} ms)`, lingering.closedAt !== null && lingering.closedAt >= LINGER_MIN_MS && lingering.closedAt <= LINGER_MAX_MS, `closed at ${lingering.closedAt} ms`),
        ]);

        const body = randomBytes(3 * 1024 * 1024);
        const open = await exchange(server.url, { method: "PUT", path: "/open/big", body });
        const seenOpen = server.backend.to("/open/big")[0];
        const sentDigest = createHash("sha256").update(body).digest("hex");
        const receivedDigest = createHash("sha256").update(seenOpen.body).digest("hex");
        observe(ctx, "no cap by default: 3 MiB passes byte for byte", { status: open.status, bytes: seenOpen.body.length, sentDigest, receivedDigest }, [
          ctx.equal("the proxy without maxBodyBytes passes 3 MiB", [open.status, seenOpen.body.length], [200, body.length]),
          ctx.equal("the bytes are identical", receivedDigest, sentDigest),
        ]);

        const streaming = await streamUpload(server);
        observe(ctx, "the request body is streamed to the backend as it comes", streaming, [
          ctx.holds("the backend holds the first part while the client has not sent the rest", streaming.backendBytesBeforeRest === 4096, `backend had ${streaming.backendBytesBeforeRest} bytes`),
          ctx.equal("the whole body arrives at the end", streaming.backendBytesAfter, 8192),
        ]);

        const download = await streamDownload(server, timeline);
        observe(ctx, "the answer is streamed back as the backend writes it", download, [
          ctx.holds("the client had the first part while the backend was still writing", download.firstPartBeforeBackendEnded === true, JSON.stringify(download)),
          ctx.equal("the whole answer arrives", download.bytes, 3 * 4096),
        ]);

        const flags = {
          zero: await exchange(server.url, { method: "PUT", path: "/zero/x", body: "z" }),
          negative: await exchange(server.url, { method: "PUT", path: "/negative/x", body: "z" }),
          fraction: await exchange(server.url, { method: "PUT", path: "/fraction/x", body: "z" }),
        };
        const invalid = ["/zero/**", "/negative/**", "/fraction/**"].map((path) => log.includes(`declares the backend proxy "${path}", which is ignored: maxBodyBytes is not a positive whole number of bytes.`));
        observe(ctx, "an invalid maxBodyBytes ignores the declaration with a warning", { log: log.split("\n").filter((line) => /ignored|Ignoring/.test(line)), statuses: Object.fromEntries(Object.entries(flags).map(([name, answer]) => [name, answer.status])) }, [
          ctx.equal("0, -1 and 1.5 each warn that maxBodyBytes is not a positive whole number", invalid, [true, true, true]),
          ctx.equal("the ignored proxies are not proxies: their paths are pages, and a POST-like method on a page is a 404", Object.values(flags).map((answer) => answer.status), [404, 404, 404]),
          ctx.holds("a maxBodyBytes that is not a number and an unknown auth mode are reported as unusable entries", /Ignoring 2 entries of DMS_BACKEND_PROXIES: not a backend proxy declaration/.test(log), log.split("\n").find((line) => line.includes("Ignoring 2 entries")) ?? "no such line"),
        ]);
      });

      const real = await exchange(ctx.state.webUrl, { method: "GET", path: "/dms-preview" });
      const refused = await stalledUpload(ctx.state.webUrl, { method: "PUT", path: "/file-storage/upload/verify", contentLength: UPLOAD_LIMIT + 1, sent: 2048, holdMs: 2500 });
      const atLimit = await stalledUpload(ctx.state.webUrl, { method: "PUT", path: "/file-storage/upload/verify", contentLength: UPLOAD_LIMIT, sent: 2048, holdMs: 2500 });
      const belowLimit = await stalledUpload(ctx.state.webUrl, { method: "PUT", path: "/file-storage/upload/verify", contentLength: UPLOAD_LIMIT - 1, sent: 2048, holdMs: 2500 });
      observe(ctx, "the DMS's /file-storage/upload/** is capped at 500 MiB", { page: real.status, refused, atLimit, belowLimit }, [
        ctx.equal("a declared 500 MiB + 1 byte is refused at once with 413", [refused.status, refused.headAt !== null && refused.headAt < 1500], [413, true]),
        ctx.equal("a declared 500 MiB exactly is passed to the backend, which answers 404 for this unknown route", atLimit.status, 404),
        ctx.equal("a declared 500 MiB - 1 byte is passed on too", belowLimit.status, 404),
      ]);
    },
  },
];

/**
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @returns {Promise<{ backendBytesBeforeRest: number, backendBytesAfter: number }>} What the backend held when
 */
async function streamUpload(server) {
  const url = new URL(server.url);
  const socket = connect(Number(url.port), url.hostname);
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`PUT /open/stream HTTP/1.1\r\nHost: ${url.host}\r\nContent-Length: 8192\r\nConnection: close\r\n\r\n`);
  socket.write(Buffer.alloc(4096, 0x64));
  await sleep(800);
  const seen = server.backend.to("/open/stream")[0];
  const backendBytesBeforeRest = seen ? seen.body.length : -1;
  socket.write(Buffer.alloc(4096, 0x65));
  await new Promise((resolve) => {
    socket.on("data", () => {});
    socket.on("close", resolve);
    socket.on("error", resolve);
  });
  await sleep(200);
  return { backendBytesBeforeRest, backendBytesAfter: server.backend.to("/open/stream")[0].body.length };
}

/**
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {{ backendEndedAt: number | null }} timeline When the backend finished writing
 * @returns {Promise<{ bytes: number, firstPartBeforeBackendEnded: boolean }>} Whether the first part was early
 */
function streamDownload(server, timeline) {
  const url = new URL(server.url);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let received = Buffer.alloc(0);
    /** @type {boolean | null} */
    let early = null;
    socket.on("connect", () => socket.write(`GET /open/slow-download HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`));
    socket.on("data", (part) => {
      received = Buffer.concat([received, part]);
      if (early === null && received.includes("ffffffffff")) early = timeline.backendEndedAt === null;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const head = received.indexOf("\r\n\r\n") + 4;
      resolve({ bytes: decodeChunked(received.subarray(head)).length, firstPartBeforeBackendEnded: early === true });
    });
  });
}

/**
 * @param {Buffer} data A chunked body
 * @returns {Buffer} The decoded body
 */
function decodeChunked(data) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const end = data.indexOf("\r\n", offset);
    if (end < 0) break;
    const size = Number.parseInt(data.subarray(offset, end).toString(), 16);
    if (!size) break;
    parts.push(data.subarray(end + 2, end + 2 + size));
    offset = end + 2 + size + 2;
  }
  return Buffer.concat(parts);
}

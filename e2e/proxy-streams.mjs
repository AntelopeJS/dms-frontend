import { get as httpGet } from "node:http";
import { exchange } from "./proxy-http.mjs";
import { observe, sleep, withSatellite } from "./proxy-satellite.mjs";
import { standalone } from "./standalone.mjs";

const WAIT_STEP_MS = 100;

/**
 * @param {() => boolean} condition What to wait for
 * @param {number} timeoutMs How long
 * @returns {Promise<boolean>} Whether it held in time
 */
async function eventually(condition, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await sleep(WAIT_STEP_MS);
  return condition();
}

/**
 * Opens an event stream and records each event with its arrival time.
 *
 * @param {string} url The stream's URL
 * @param {Record<string, string>} headers Request headers
 * @returns {{ events: { at: number, text: string }[], headers: Promise<Record<string, unknown>>, ended: () => boolean, errored: () => boolean, abort: () => void }} The stream
 */
function listen(url, headers) {
  /** @type {{ at: number, text: string }[]} */
  const events = [];
  let ended = false;
  let errored = false;
  const startedAt = Date.now();
  /** @type {(value: Record<string, unknown>) => void} */
  let resolveHeaders = () => undefined;
  /** @type {Promise<Record<string, unknown>>} */
  const headersPromise = new Promise((resolve) => {
    resolveHeaders = resolve;
  });
  const request = httpGet(url, { headers }, (response) => {
    resolveHeaders({ status: response.statusCode, ...response.headers });
    response.on("data", (/** @type {Buffer} */ part) => events.push({ at: Date.now() - startedAt, text: part.toString() }));
    response.on("end", () => {
      ended = true;
    });
    response.on("error", () => {
      errored = true;
    });
    response.on("aborted", () => {
      errored = true;
    });
  });
  request.on("error", () => {
    errored = true;
  });
  return { events, headers: headersPromise, ended: () => ended, errored: () => errored || ended, abort: () => request.destroy() };
}

export const journeys = [
  {
    id: "proxy-streams",
    title: "an event stream is relayed as written; a client that leaves closes its backend request; a broken backend stream ends only that response",
    entryPoint: "GET text/event-stream through /api/** of a second `ajs dms start`",
    ...standalone,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /** @type {import("node:http").ServerResponse[]} */
      const open = [];
      /** @type {import("./proxy-satellite.mjs").BackendHandler} */
      const backend = (request, response) => {
        request.resume();
        if (request.url === "/api/stream") {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
          open.push(response);
          let count = 0;
          const timer = setInterval(() => {
            count += 1;
            response.write(count % 3 === 0 ? ": keepalive\n\n" : `data: event-${count}\n\n`);
          }, 300);
          response.on("close", () => clearInterval(timer));
          return;
        }
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("pong");
      };
      await withSatellite(ctx, { backend }, async (server) => {
        const stream = listen(`${server.url}/api/stream`, { accept: "text/event-stream", "accept-encoding": "gzip, br" });
        const head = await stream.headers;
        await sleep(1500);
        const early = stream.events.map((event) => event.text);
        observe(ctx, "events arrive while the backend is still writing", { head, events: stream.events }, [
          ctx.equal("the stream is relayed with its type, uncompressed", [head.status, head["content-type"], head["content-encoding"] ?? null], [200, "text/event-stream", null]),
          ctx.equal("the first events arrive one by one as written", early.slice(0, 2), ["data: event-1\n\n", "data: event-2\n\n"]),
          ctx.holds("an event arrives within 400 ms of the backend writing it", stream.events[0].at < 700, `first event at ${stream.events[0].at} ms`),
          ctx.equal("the stream is still open", stream.ended(), false),
        ]);

        const seen = server.backend.to("/api/stream")[0];
        stream.abort();
        const closed = await eventually(() => seen.aborted, 4000);
        observe(ctx, "a client that leaves closes its backend request", { aborted: seen.aborted }, [
          ctx.equal("the backend's response is closed after the client left", closed, true),
        ]);

        const second = listen(`${server.url}/api/stream`, { accept: "text/event-stream" });
        await second.headers;
        await sleep(700);
        const stuck = open.at(-1);
        stuck.socket.destroy();
        const ended = await eventually(() => second.errored(), 4000);
        const ping = await exchange(server.url, { path: "/api/ping" });
        observe(ctx, "a backend stream that breaks ends the client's response, and the server keeps serving", { ended, ping: { status: ping.status, text: ping.text }, child: server.child.exitCode }, [
          ctx.equal("the client's response ends", ended, true),
          ctx.equal("the next request is served", [ping.status, ping.text], [200, "pong"]),
          ctx.equal("the server process is still running", server.child.exitCode, null),
        ]);
        second.abort();
      });
    },
  },
];

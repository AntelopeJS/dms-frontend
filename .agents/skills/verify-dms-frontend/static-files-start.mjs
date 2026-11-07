import { listAt, textAt } from "./json.mjs";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { exchange, rawExchange } from "./proxy-http.mjs";
import { observe, sleep, startSatellite, withSatellite } from "./proxy-satellite.mjs";
import { standalone } from "./standalone.mjs";

const RETRY_FIRST_MIN_MS = 1700;
const RETRY_FIRST_MAX_MS = 4500;
const RETRY_SECOND_MIN_MS = 3700;
const RETRY_SECOND_MAX_MS = 8000;

/**
 * @param {string} directory A directory
 * @returns {string} A digest of every file's path, size and modification time below it
 */
function fingerprint(directory) {
  /** @type {string[]} */
  const entries = [];
  const walk = (/** @type {string} */ path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const stats = statSync(full);
        entries.push(`${full} ${stats.size} ${stats.mtimeMs}`);
      }
    }
  };
  walk(directory);
  return createHash("sha256").update(entries.sort((left, right) => left.localeCompare(right)).join("\n")).digest("hex");
}

/**
 * @param {import("./proxy-satellite.mjs").Seen[]} requests Requests to the fake backend
 * @returns {import("./proxy-satellite.mjs").Seen[]} The ones that report the served modules
 */
function reports(requests) {
  return requests.filter((seen) => seen.method === "POST" && seen.url === "/dms/frontend/ready");
}

export const journeys = [
  {
    id: "static-files-start",
    title: "start serves the build as it is, reports what it serves to the backend, and stops on SIGINT and SIGTERM",
    entryPoint: "`ajs dms start` against a backend of the test's own, from a read-only copy of the run's workspace",
    ...standalone,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const secret = ctx.state.secrets.DMS_BOOTSTRAP_SECRET;
      /** @type {unknown} */
      const manifest = JSON.parse(readFileSync(join(ctx.state.renderer ?? "", "package.json"), "utf8"));
      const version = textAt(manifest, "version");
      /** @type {number[]} */
      const stamps = [];
      await withSatellite(ctx, {
        readOnly: true,
        backend: (request, response) => {
          request.resume();
          if (request.url === "/dms/frontend/ready") {
            stamps.push(Date.now());
            response.writeHead(stamps.length < 3 ? 503 : 200, { "content-type": "application/json" });
            response.end("{}");
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        },
      }, async (server) => {
        const before = fingerprint(server.workspace);
        const page = await exchange(server.url, { path: "/dms-preview", headers: { accept: "text/html" } });
        await sleep(9000);
        const after = fingerprint(server.workspace);
        const posted = reports(server.backend.requests);
        /** @type {unknown} */
        const body = JSON.parse(posted[0].body.toString("utf8"));
        const gaps = stamps.slice(1).map((stamp, index) => stamp - stamps[index]);
        observe(ctx, "a read-only workspace; the ready report and its retries", { body, headers: posted[0].headers, gaps, log: server.log() }, [
          ctx.equal("the server starts from a workspace it cannot write and serves a page", page.status, 200),
          ctx.equal("it wrote nothing into the workspace", after, before),
          ctx.equal("the ready report is a POST to /dms/frontend/ready with the bootstrap credential", [posted[0].method, posted[0].url, posted[0].headers["x-dms-bootstrap"], posted[0].headers["content-type"]], ["POST", "/dms/frontend/ready", secret, "application/json"]),
          ctx.equal("it names the version of the frontend itself", JSON.stringify(body).includes(`"${version}"`), true),
          ctx.equal("it names each module the build serves", listAt(body, "modules").map((module) => textAt(module, "name") ?? "").sort((left, right) => left.localeCompare(right)), ["@antelopejs/dms-frontend-vue", "playground-frontend"]),
          ctx.equal("a 503 is retried: two retries, then the 200 ends them", posted.length, 3),
          ctx.holds(`the first retry comes after about 2 s (${RETRY_FIRST_MIN_MS} to ${RETRY_FIRST_MAX_MS} ms)`, gaps[0] >= RETRY_FIRST_MIN_MS && gaps[0] <= RETRY_FIRST_MAX_MS, gaps[0]),
          ctx.holds(`the next delay doubles (${RETRY_SECOND_MIN_MS} to ${RETRY_SECOND_MAX_MS} ms)`, gaps[1] >= RETRY_SECOND_MIN_MS && gaps[1] <= RETRY_SECOND_MAX_MS, gaps[1]),
          ctx.holds("the server announces the report once the backend answered", server.log().includes(`Reported 2 modules to the backend (dms-frontend ${version})`), server.log().split("\n").filter((line) => line.includes("Reported")).join(" | ")),
        ]);
      });

      await withSatellite(ctx, {
        backend: (request, response) => {
          request.resume();
          response.writeHead(request.url === "/dms/frontend/ready" ? 401 : 200, { "content-type": "application/json" });
          response.end("{}");
        },
      }, async (server) => {
        await sleep(6000);
        const posted = reports(server.backend.requests).length;
        observe(ctx, "a refused credential ends the retries", { posted, log: server.log() }, [
          ctx.equal("one report only", posted, 1),
          ctx.holds("the refusal is explained", server.log().includes("The backend refused the ready report"), server.log().split("\n").filter((line) => line.includes("refused")).join(" | ")),
        ]);
      });

      await withSatellite(ctx, {}, async (server) => {
        const http2 = await rawExchange(server.url, "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n");
        const upgrade = await exchange(server.url, { path: "/dms-preview", headers: { connection: "Upgrade, HTTP2-Settings", upgrade: "h2c", "http2-settings": "AAMAAABkAAQAAP__" } });
        const statusLine = await rawExchange(server.url, "GET /dms-preview HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
        observe(ctx, "HTTP/1.1 only", { http2: http2.text.slice(0, 120), upgrade: upgrade.status }, [
          ctx.equal("an HTTP/2 prior-knowledge connection is not served as HTTP/2", http2.status === 200, false),
          ctx.equal("an h2c upgrade is ignored: the answer is plain HTTP/1.1", [upgrade.status, upgrade.headers.upgrade ?? null], [200, null]),
          ctx.holds("the status line is HTTP/1.1", statusLine.text.startsWith("HTTP/1.1 200"), statusLine.text.slice(0, 20)),
        ]);
      });

      for (const [signal, exitCode, message] of [["SIGINT", 130, "Stopped the production server · ran"], ["SIGTERM", 143, "Stopped the production server (SIGTERM) · ran"]]) {
        const server = await startSatellite(ctx, {});
        server.child.kill(signal);
        const code = await Promise.race([server.exited, sleep(15_000).then(() => "running")]);
        const log = server.log();
        await server.stop();
        observe(ctx, `${signal} stops the server`, { code, log: log.slice(-300) }, [
          ctx.equal("it exits with the conventional signal code", code, exitCode),
          ctx.holds("it reports that it stopped", log.includes(message), log.slice(-200)),
        ]);
      }

      const noSecret = await startSatellite(ctx, { env: { DMS_SESSION_SECRET: undefined }, expectExit: true });
      const noSecretCode = await Promise.race([noSecret.exited, sleep(30_000).then(() => "running")]);
      const noSecretLog = noSecret.log();
      await noSecret.stop();
      const shortSecret = await startSatellite(ctx, { env: { DMS_SESSION_SECRET: "x".repeat(31) }, expectExit: true });
      const shortCode = await Promise.race([shortSecret.exited, sleep(30_000).then(() => "running")]);
      const shortLog = shortSecret.log();
      await shortSecret.stop();
      const edgeSecret = await startSatellite(ctx, { env: { DMS_SESSION_SECRET: "y".repeat(32) } });
      const edgePage = await exchange(edgeSecret.url, { path: "/dms-preview" });
      await edgeSecret.stop();
      observe(ctx, "DMS_SESSION_SECRET is required, 32 characters or more", { noSecret: noSecretLog.slice(-300), short: shortLog.slice(-300) }, [
        ctx.holds("without it start refuses to run", noSecretCode !== 0 && noSecretCode !== "running" && /DMS_SESSION_SECRET/.test(noSecretLog), `${noSecretCode} ${noSecretLog.slice(-200)}`),
        ctx.holds("with 31 characters it refuses too", shortCode !== 0 && shortCode !== "running" && /DMS_SESSION_SECRET/.test(shortLog), `${shortCode} ${shortLog.slice(-200)}`),
        ctx.equal("with 32 characters it serves", edgePage.status, 200),
      ]);

      const bare = await startSatellite(ctx, { emptyWorkspace: true, expectExit: true });
      const bareCode = await Promise.race([bare.exited, sleep(30_000).then(() => "running")]);
      const bareLog = bare.log();
      await bare.stop();
      observe(ctx, "start without a build", { code: bareCode, log: bareLog }, [
        ctx.equal("it exits with 1", bareCode, 1),
        ctx.holds("it says there is no build and what to run", bareLog.includes("No production build to serve") && bareLog.includes("Build it first: ajs dms build"), bareLog.slice(-300)),
      ]);
    },
  },
];

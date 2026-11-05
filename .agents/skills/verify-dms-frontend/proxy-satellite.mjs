import { Buffer } from "node:buffer";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { exchange } from "./proxy-http.mjs";
import { numberAt } from "./json.mjs";

const READY_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
const STOP_TIMEOUT_MS = 10_000;
const BUNDLE = "dist/server-modules/server-modules.generated.js";
const ORIGINAL_BUNDLE = "dist/server-modules/original-modules.js";
const EXTRA_BUNDLE = "dist/server-modules/extra-modules.js";

let counter = 0;

/**
 * @param {number} ms Milliseconds
 * @returns {Promise<void>} Resolves after `ms`
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {import("node:net").Server} server A listening server
 * @returns {number} The port it listens on
 */
function listeningPort(server) {
  const port = numberAt(server.address(), "port");
  if (port === undefined) throw new Error("the server does not listen on a port");
  return port;
}

/**
 * A port the kernel hands out.
 *
 * @returns {Promise<number>} A free port
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = listeningPort(probe);
      probe.close(() => resolve(port));
    });
  });
}

/**
 * @typedef {object} Seen
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {Buffer} body
 * @property {boolean} complete Whether the whole request body arrived
 * @property {boolean} aborted Whether the client side closed before the response ended
 */

/**
 * @typedef {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse, seen: Seen) => void | Promise<void>} BackendHandler
 */

/**
 * @typedef {object} FakeBackend
 * @property {string} url
 * @property {number} port
 * @property {Seen[]} requests Every request, in order of arrival
 * @property {(path: string) => Seen[]} to Requests whose path (without query) is `path`
 * @property {() => Promise<void>} close
 */

/**
 * A backend of the test's own: records each request and answers with `handler`.
 *
 * @param {BackendHandler} [handler] Answers; 200 `{"ok":true}` by default
 * @returns {Promise<FakeBackend>} The listening backend
 */
export async function startFakeBackend(handler) {
  /** @type {Seen[]} */
  const requests = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  const server = createServer((request, response) => {
    /** @type {Seen} */
    const seen = {
      method: request.method ?? "",
      url: request.url ?? "",
      headers: request.headers,
      body: Buffer.alloc(0),
      complete: false,
      aborted: false,
    };
    requests.push(seen);
    /** @type {Buffer[]} */
    const parts = [];
    request.on("data", (/** @type {Buffer} */ part) => {
      parts.push(part);
      seen.body = Buffer.concat(parts);
    });
    request.on("end", () => {
      seen.complete = true;
    });
    response.on("close", () => {
      if (!response.writableFinished) seen.aborted = true;
    });
    const answer = handler ?? ((_, reply) => {
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end('{"ok":true}');
    });
    Promise.resolve(answer(request, response, seen)).catch(() => response.destroy());
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = listeningPort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    to: (path) => requests.filter((seen) => seen.url.split("?")[0] === path),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Hard-links the built workspace into `target`, `node_modules` linked as a
 * directory, so a satellite can change a generated file without touching the
 * run's own workspace.
 *
 * @param {string} source The run's workspace
 * @param {string} target The copy
 */
function copyWorkspace(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name === "node_modules") symlinkSync(join(source, name), join(target, name));
    else execFileSync("cp", ["-al", join(source, name), join(target, name)]);
  }
}

/**
 * @param {string} workspace The satellite's workspace
 * @param {string} relative A file in it
 * @param {string} content New content, written to a new file so the run's own stays as it is
 */
function replaceFile(workspace, relative, content) {
  const file = join(workspace, relative);
  rmSync(file, { force: true });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content);
}

/**
 * The environment of a satellite: the run's, without the process manager's
 * own variables, with the satellite's ports and backend.
 *
 * @param {Context} ctx The journey
 * @param {Record<string, string>} values The satellite's ports and backend
 * @param {Record<string, string | undefined>} extra Variables the test sets; `undefined` removes one
 * @returns {NodeJS.ProcessEnv} The environment
 */
function satelliteEnvironment(ctx, values, extra) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(DMS_|ANTELOPEJS_|PORT$|HOST$|NODE_ENV$)/.test(name)) env[name] = value;
  }
  Object.assign(env, {
    HOME: ctx.state.home,
    USERPROFILE: ctx.state.home,
    CI: "1",
    NO_COLOR: "1",
    AJS_NO_UPDATE_CHECK: "1",
    NO_UPDATE_NOTIFIER: "1",
    ...ctx.state.secrets,
    ...values,
  });
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/** @typedef {import("./control.d.ts").JourneyContext} Context */

/**
 * @typedef {object} SatelliteOptions
 * @property {BackendHandler} [backend] The fake backend's handler
 * @property {Record<string, string | undefined>} [env] Variables of the server
 * @property {{ source: string, keepOriginal?: boolean }} [modules] ES module source exporting `modules`, an array of `{ id, priority, setup }` that the server loads next to (or, without `keepOriginal`, instead of) the build's own
 * @property {Record<string, string | Buffer>} [files] Workspace files to replace or add, by relative path
 * @property {string[]} [remove] Workspace paths to delete
 * @property {boolean} [readOnly] Make the workspace read-only before `start`
 * @property {string[]} [args] More arguments for `start`
 * @property {boolean} [expectExit] The server is expected to stop by itself
 * @property {FakeBackend} [sharedBackend] A backend that outlives the server, to start several servers against it
 * @property {string} [apiHost] A host name for the backend URL the server is given, such as `localhost`
 * @property {boolean} [emptyWorkspace] Serve an empty directory: no build
 * @property {number} [port] The port to ask for, a free one by default
 */

/**
 * @typedef {object} Satellite
 * @property {string} url The frontend server's URL
 * @property {number} port
 * @property {string} workspace
 * @property {FakeBackend} backend
 * @property {() => string} log Everything the server printed
 * @property {() => Promise<void>} stop
 * @property {import("node:child_process").ChildProcess} child
 * @property {Promise<number | null>} exited Resolves with the exit code
 * @property {(path: string, headers?: Record<string, string>) => ReturnType<typeof exchange>} get
 */

/**
 * @param {string} workspace The satellite's workspace
 * @param {{ source: string, keepOriginal?: boolean }} modules The modules to load
 */
function installModules(workspace, modules) {
  const original = readFileSync(join(workspace, BUNDLE), "utf8");
  replaceFile(workspace, EXTRA_BUNDLE, modules.source);
  if (modules.keepOriginal) {
    replaceFile(workspace, ORIGINAL_BUNDLE, original);
    replaceFile(
      workspace,
      BUNDLE,
      'import { serverModules as original } from "./original-modules.js";\nimport { modules } from "./extra-modules.js";\nexport const serverModules = [...modules, ...original];\n',
    );
  } else {
    replaceFile(workspace, BUNDLE, 'import { modules } from "./extra-modules.js";\nexport const serverModules = modules;\n');
  }
}

/**
 * @param {Context} ctx The journey
 * @param {SatelliteOptions} options What differs from the run's server
 * @param {string} workspace Where the satellite's workspace goes
 */
function prepareWorkspace(ctx, options, workspace) {
  if (options.emptyWorkspace) mkdirSync(workspace, { recursive: true });
  else copyWorkspace(join(ctx.state.runPlayground ?? "", ".dms-frontend"), workspace);
  if (options.modules) installModules(workspace, options.modules);
  for (const relative of options.remove ?? []) rmSync(join(workspace, relative), { force: true, recursive: true });
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    replaceFile(workspace, relative, content);
  }
}

/**
 * Waits until the server has printed its routing report and stopped printing.
 *
 * @param {Satellite} satellite The starting server
 * @returns {Promise<void>} Resolves when it is ready
 */
async function awaitReady(satellite) {
  const { child, backend, log } = satellite;
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let settled = "";
  for (;;) {
    if (child.exitCode !== null) {
      await backend.close();
      throw new Error(`the satellite server exited with ${child.exitCode}: ${log().slice(-600)}`);
    }
    const text = log();
    if (text.includes("Routing:") && text === settled) break;
    settled = text.includes("Routing:") ? text : "";
    if (Date.now() > deadline) {
      await satellite.stop();
      throw new Error(`the satellite server was not ready: ${text.slice(-600)}`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * Starts the run's built frontend (`ajs dms start`) a second time on a free
 * port against a backend of the test's own, from a hard-linked copy of the
 * run's workspace, so the frontend server's behaviour is observed in
 * isolation.
 *
 * @param {Context} ctx The journey
 * @param {SatelliteOptions} [options] What differs from the run's server
 * @returns {Promise<Satellite>} The running server
 */
export async function startSatellite(ctx, options = {}) {
  counter += 1;
  const scratch = join(ctx.state.dir, "satellites", `${ctx.journey}-${counter}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const workspace = join(scratch, ".dms-frontend");
  prepareWorkspace(ctx, options, workspace);
  const backend = options.sharedBackend ?? (await startFakeBackend(options.backend));
  const port = options.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const apiUrl = options.apiHost ? backend.url.replace("127.0.0.1", options.apiHost) : backend.url;
  const env = satelliteEnvironment(
    ctx,
    { DMS_API_BASE_URL: apiUrl, DMS_CLIENT_BASE_URL: url },
    options.env ?? {},
  );
  const logFile = join(scratch, "server.log");
  const out = openSync(logFile, "w");
  if (options.readOnly) {
    execFileSync("chmod", ["-R", "a-w", workspace]);
  }
  const child = spawn(
    process.execPath,
    [
      join(ctx.state.renderer ?? "", "dist/index.js"),
      "start",
      "-e",
      "docs",
      "-b",
      apiUrl,
      "-p",
      String(port),
      "--workspace",
      workspace,
      ...(options.args ?? []),
    ],
    { cwd: ctx.state.runPlayground, env, stdio: ["ignore", out, out] },
  );
  closeSync(out);
  /** @type {Promise<number | null>} */
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const log = () => readFileSync(logFile, "utf8");
  let stopped = false;
  /** @type {Satellite} */
  const satellite = {
    url,
    port,
    workspace,
    backend,
    log,
    child,
    exited,
    get: (path, headers = {}) => exchange(url, { path, headers }),
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      if (!options.sharedBackend) await backend.close();
      if (options.readOnly && existsSync(workspace)) {
        execFileSync("chmod", ["-R", "u+w", workspace]);
      }
      writeFileSync(join(scratch, "backend-requests.json"), JSON.stringify(
        backend.requests.map((seen) => ({ method: seen.method, url: seen.url, headers: seen.headers, bodyBytes: seen.body.length })),
        null,
        2,
      ));
    },
  };
  if (options.expectExit) return satellite;
  await awaitReady(satellite);
  return satellite;
}

/**
 * Runs `body` with a satellite and always stops it.
 *
 * @template T
 * @param {Context} ctx The journey
 * @param {SatelliteOptions} options See `startSatellite`
 * @param {(satellite: Satellite) => Promise<T>} body What to do with it
 * @returns {Promise<T>} What `body` returns
 */
export async function withSatellite(ctx, options, body) {
  const satellite = await startSatellite(ctx, options);
  try {
    return await body(satellite);
  } finally {
    await satellite.stop();
  }
}

/**
 * Records a step with evidence: the data is written next to the checks.
 *
 * @param {Context} ctx The journey
 * @param {string} label What the step verifies
 * @param {unknown} evidence What was observed, as JSON
 * @param {import("./control.d.ts").Check[]} checks The checks
 * @param {{ critical?: boolean }} [options] Whether a failure ends the journey
 * @returns {boolean} Whether every check passed
 */
export function observe(ctx, label, evidence, checks, options) {
  const folder = ctx.step(label);
  writeFileSync(join(folder, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return ctx.record(folder, checks, options);
}

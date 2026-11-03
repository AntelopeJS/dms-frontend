import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { at } from "./json.mjs";
import { listedWorkspaces } from "./cli-json.mjs";
import { startCliBackend } from "./cli-backend.mjs";
import { serviceToken } from "./web.mjs";
import { writeModule } from "./workspace-fixtures.mjs";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { freePort, holdPort, observe, runCli, scratch, startCli } from "./cli-run.mjs";
import { lanAddresses, accepts } from "./build-network.mjs";
import { buildProjectFolder, writeBuildProject } from "./build-project.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const READY_MS = 180_000;

/**
 * Starts `ajs dms dev` against `backendUrl` with the run's playground as the project.
 *
 * @param {import("./cli-run.mjs").Context} ctx The journey
 * @param {string | null} backendUrl The backend; null leaves -b out
 * @param {{ project?: string, cwd?: string, args?: string[], env?: Record<string, string | undefined>, home: string, port?: number | null }} options Variations
 * @returns {Promise<import("./cli-run.mjs").RunningCli & { port: number, local: string }>} The running server, once ready
 */
async function dev(ctx, backendUrl, options) {
  const port = options.port === undefined ? 0 : options.port;
  const args = ["dev", "-e", "docs", ...(backendUrl === null ? [] : ["-b", backendUrl]), "--project", options.project ?? ctx.state.runPlayground, ...(port === null ? [] : ["-p", String(port)]), ...(options.args ?? [])];
  const cli = startCli(ctx, args, { cwd: options.cwd ?? scratch(ctx, "cwd"), home: options.home, env: options.env });
  try {
    await cli.waitFor("ready in", READY_MS);
  } catch (error) {
    await cli.stop("SIGKILL");
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  const local = /Local:\s+(http:\/\/\S+)/.exec(cli.output())?.[1] ?? "";
  return { ...cli, port: Number(new URL(local || "http://x:0").port), local };
}

/**
 * Writes the registry a running `ajs project dev` leaves in `.antelope/dev.json`.
 *
 * @param {string} project The project folder
 * @param {number} pid The process it names
 * @param {number | null} port The api port; null writes a server list without an api endpoint
 */
function writeRegistry(project, pid, port) {
  mkdirSync(join(project, ".antelope"), { recursive: true });
  const servers = port === null ? {} : { api: { endpoints: [{ protocol: "http", host: "127.0.0.1", port }] } };
  writeFileSync(join(project, ".antelope", "dev.json"), JSON.stringify({ pid, servers }));
}

/**
 * @returns {number} The pid of a process that has ended
 */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

export const journeys = [
  {
    id: "dev-arguments",
    title: "dev needs a backend url and a session secret of 32 characters or none at all, and says so before it does anything",
    entryPoint: "ajs dms dev without a backend, with bad ports and secrets",
    async run(/** @type {Context} */ ctx) {
      const cwd = scratch(ctx, "cwd");
      const home = scratch(ctx, "home");
      const nowhere = await runCli(ctx, ["dev"], { cwd, home });
      const page = exampleOutput(docsPage(ctx, "3.cli/2.dev.md"), "ajs dms dev");
      const secrets = {
        short: await runCli(ctx, ["dev", "-b", "http://127.0.0.1:9"], { cwd, home, env: { DMS_SESSION_SECRET: "short" } }),
        empty: await runCli(ctx, ["dev", "-b", "http://127.0.0.1:9"], { cwd, home, env: { DMS_SESSION_SECRET: "" } }),
        short31: await runCli(ctx, ["dev", "-b", "http://127.0.0.1:9"], { cwd, home, env: { DMS_SESSION_SECRET: "s".repeat(31) } }),
      };
      const port = await runCli(ctx, ["dev", "-b", "http://127.0.0.1:9", "-p", "65536"], { cwd, home });
      const badUrl = await runCli(ctx, ["dev", "-b", "localhost:5010"], { cwd, home });
      const reason = "  dev generates an ephemeral secret only when the variable is not set at all.\n  → Create one: openssl rand -hex 32, then set it in the environment or ./.env\n";
      observe(ctx, "refusals", { nowhere, secrets, port, badUrl }, [
        ctx.equal("no backend and no running project: the page's text", [nowhere.stdout, nowhere.stderr.trimEnd()], ["", page ?? "<no block>"]),
        ctx.equal("it is a failure of the command", nowhere.code === 1 || nowhere.code === 2, true),
        ctx.equal("a short secret is refused: exit 2, the length, dev's own reason", [secrets.short.code, secrets.short.stderr], [2, `✖ DMS_SESSION_SECRET is too short: 5 characters, at least 32 needed\n${reason}`]),
        ctx.equal("an empty secret is refused", [secrets.empty.code, secrets.empty.stderr], [2, `✖ DMS_SESSION_SECRET is empty\n${reason}`]),
        ctx.equal("31 characters are refused", [secrets.short31.code, secrets.short31.stderr.split("\n")[0]], [2, "✖ DMS_SESSION_SECRET is too short: 31 characters, at least 32 needed"]),
        ctx.equal("a port out of range", [port.code, port.stderr.split("\n")[0]], [2, "✖ Invalid port '65536'"]),
        ctx.equal("a url without a scheme", [badUrl.code, badUrl.stderr.split("\n").includes("✖ Invalid backend URL 'localhost:5010'")], [2, true]),
      ]);
    },
  },
  {
    id: "dev-server",
    title: "dev serves the project's modules on 127.0.0.1, names who answers each path, keys its workspace on the backend url, and stops with 130",
    entryPoint: "ajs dms dev -b <backend> -p <port> against a backend of the journey's own",
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      const home = scratch(ctx, "home");
      try {
        const port = await freePort();
        const server = await dev(ctx, backend.url, { home, port });
        const block = server.output();
        const lan = lanAddresses();
        try {
          const owners = {};
          for (const path of ["/api/dms/nothing", "/dms/anything", "/assets/missing.js", "/this-page-does-not-exist"]) {
            const answer = await fetch(`${server.local.slice(0, -1)}${path}`, { redirect: "manual" });
            owners[path] = answer.headers.get("x-dms-route-owner");
          }
          const workspaces = listedWorkspaces((await runCli(ctx, ["workspaces", "--json"], { home })).stdout);
          observe(ctx, "a running dev server", { block, owners, workspaces, requests: backend.requests.map((request) => request.url) }, [
            ctx.equal("header: the backend, and development", block.split("\n")[0], `ajs dms dev  ${backend.url} · development`),
            ctx.holds("ready, with the port asked for and no busy-port warning", /✔ Dev server ready in \d/.test(block) && server.port === port && !block.includes("is busy"), block),
            ctx.equal("Local, Backend lines; no Network line: it listens on 127.0.0.1", [/^ {2}➜ {2}Local: {5}(\S+)$/m.exec(block)?.[1], /^ {5}Backend: {3}(.*)$/m.exec(block)?.[1], block.includes("Network:")], [`http://localhost:${port}/`, backend.url, false]),
            ctx.equal("loopback accepts, no LAN address does", [await accepts(port, "127.0.0.1"), ...(await Promise.all(lan.map((address) => accepts(port, address))))], [true, ...lan.map(() => false)]),
            ctx.equal("x-dms-route-owner: the backend proxy, the renderer's assets, a page", owners, { "/api/dms/nothing": "backend:/api/**", "/dms/anything": "backend:/dms/**", "/assets/missing.js": "renderer", "/this-page-does-not-exist": "page" }),
            ctx.equal("the backend was asked for the manifest with the dev server's address, as the client url", new URL(backend.to("/dms/frontend")[0].url, "http://x").searchParams.get("clientUrl"), `http://localhost:${port}`),
            ctx.equal("without -b the workspace would be keyed on the project; with -b it is keyed on the url", workspaces.map((entry) => [entry.backendUrl, entry.key]), [[backend.url, { type: "url" }]]),
            ctx.equal("the dev server tells the backend which modules it serves", backend.to("/dms/frontend/ready").length >= 1, true),
            ctx.holds("a warning names each project module the backend does not register", block.includes("▲ playground-frontend is served from the project, but the backend does not register it\n  Its frontendModule returns a registration the running backend did not add: check the module's configuration and startup\n"), block),
          ]);
        } finally {
          const stopped = await server.stop("SIGINT");
          observe(ctx, "Ctrl+C", { stopped }, [
            ctx.equal("exit code 130", stopped.code, 130),
            ctx.holds("the last line says the dev server stopped and how long it ran", /■ Stopped the dev server · ran \d/.test(server.output().trimEnd().split("\n").at(-1) ?? ""), server.output().slice(-200)),
          ]);
        }
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "dev-ports-and-host",
    title: "dev moves to the next free port and says so, -p 0 asks for any free port without calling it busy, HOST opens it to the network",
    entryPoint: "ajs dms dev -p <busy port>, -p 0, HOST=0.0.0.0",
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      const home = scratch(ctx, "home");
      try {
        const held = await holdPort("0.0.0.0");
        const moved = await dev(ctx, backend.url, { home, port: held.port });
        const movedBlock = moved.output();
        await moved.stop("SIGINT");
        await held.release();
        observe(ctx, "a busy port", { movedBlock }, [
          ctx.holds("the warning names both ports", movedBlock.includes(`▲ Port ${held.port} is busy, using ${moved.port}\n`), movedBlock),
          ctx.holds("it took one of the next 20 ports", moved.port > held.port && moved.port <= held.port + 20, `${held.port} -> ${moved.port}`),
          ctx.equal("the Local url shows the port it took", /Local: +(\S+)/.exec(movedBlock)?.[1], `http://localhost:${moved.port}/`),
        ]);

        const open = await dev(ctx, backend.url, { home, port: await freePort(), env: { HOST: "0.0.0.0" } });
        const lan = lanAddresses();
        const openBlock = open.output();
        const reachable = await Promise.all(lan.map((address) => accepts(open.port, address)));
        await open.stop("SIGINT");
        observe(ctx, "HOST=0.0.0.0", { openBlock, lan }, [
          ctx.equal("every LAN address of this machine accepts", reachable, lan.map(() => true)),
          ctx.equal("the ready block lists a Network url per address, three at most", (openBlock.match(/Network:/g) ?? []).length > 0 || lan.length === 0, true),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "dev-backend-down",
    title: "dev falls back to the last manifest it cached when the backend is down, with a warning; --offline uses it without asking; a refused credential never does",
    entryPoint: "ajs dms dev after a first run, with the backend closed, --offline, and answering 401",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const port = await freePort();
      const backend = await startCliBackend({ port });
      const url = backend.url;
      const first = await dev(ctx, url, { home });
      await first.stop("SIGINT");
      await backend.close();
      const down = await dev(ctx, url, { home });
      const downBlock = down.output();
      await down.stop("SIGINT");
      const offline = await dev(ctx, url, { home, args: ["--offline"] });
      const offlineBlock = offline.output();
      await offline.stop("SIGINT");
      const envOffline = await dev(ctx, url, { home, env: { DMS_OFFLINE: "1" } });
      const envBlock = envOffline.output();
      await envOffline.stop("SIGINT");
      const refusing = await startCliBackend({ port });
      refusing.behaviour.manifest = { status: 401, body: {} };
      const refused = await runCli(ctx, ["dev", "-e", "docs", "-b", url, "--project", ctx.state.runPlayground, "-p", "0"], { cwd: scratch(ctx, "cwd"), home, timeoutMs: 120_000 });
      await refusing.close();
      const lonely = await runCli(ctx, ["dev", "-e", "docs", "-b", `http://127.0.0.1:${await freePort()}`, "--project", ctx.state.runPlayground, "-p", "0"], { cwd: scratch(ctx, "cwd"), home, timeoutMs: 120_000 });
      observe(ctx, "cache and outages", { downBlock, offlineBlock, envBlock, refused, lonely }, [
        ctx.holds("backend closed: the cache stands in, with the warning and what fails", downBlock.includes("▲ Backend unreachable: using the layers manifest cached ") && downBlock.includes("API calls fail until the backend is up."), downBlock),
        ctx.holds("--offline says so as information and does not warn about the backend", offlineBlock.includes("ℹ Offline: using the layers manifest cached ") && !offlineBlock.includes("Backend unreachable"), offlineBlock),
        ctx.holds("DMS_OFFLINE=1 is --offline", envBlock.includes("ℹ Offline: using the layers manifest cached "), envBlock),
        ctx.holds("a 401 never falls back to the cache: the command fails", refused.code === 1 && !refused.stderr.includes("using the layers manifest") && refused.stderr.includes("✖ "), refused.stderr),
        ctx.holds("a url that never served a manifest has no cache to use: the command fails", lonely.code === 1 && lonely.stderr.includes("✖ "), lonely.stderr),
      ]);
    },
  },
  {
    id: "dev-discovery",
    title: "dev without -b finds the backend of the enclosing project in .antelope/dev.json, keys its workspace on that project, and stops at the first file it finds",
    entryPoint: "ajs dms dev from inside a folder holding .antelope/dev.json",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const first = await startCliBackend();
      const project = scratch(ctx, "app");
      const inner = join(project, "packages", "inner");
      mkdirSync(inner, { recursive: true });
      writeRegistry(project, process.pid, first.port);
      const server = await dev(ctx, null, { home, cwd: inner });
      const block = server.output();
      await server.stop("SIGINT");
      const listing = listedWorkspaces((await runCli(ctx, ["workspaces", "--json"], { home })).stdout);
      observe(ctx, "a discovered backend", { block, listing }, [
        ctx.equal("the header names the discovered backend", block.split("\n")[0], `ajs dms dev  ${first.url} · development`),
        ctx.holds("it says where the backend was found", block.includes(`ℹ Backend discovered from ${project}\n`), block),
        ctx.equal("the workspace is keyed on the project directory, not the url", listing.map((entry) => [entry.backendUrl, entry.key]), [[first.url, { type: "project", path: project }]]),
      ]);
      await first.close();

      const second = await startCliBackend();
      writeRegistry(project, process.pid, second.port);
      const again = await dev(ctx, null, { home, cwd: inner });
      const againBlock = again.output();
      await again.stop("SIGINT");
      const relisted = listedWorkspaces((await runCli(ctx, ["workspaces", "--json"], { home })).stdout);
      observe(ctx, "the backend lands on another port", { againBlock, relisted }, [
        ctx.equal("the same workspace serves it: one directory, no new install", [relisted.map((entry) => entry.dir), againBlock.includes("Installed"), againBlock.split("\n")[0]], [listing.map((entry) => entry.dir), false, `ajs dms dev  ${second.url} · development`]),
      ]);

      writeFileSync(join(inner, ".env"), `DMS_API_BASE_URL=${second.url}\n`);
      const explicit = await dev(ctx, null, { home, cwd: inner });
      const explicitBlock = explicit.output();
      await explicit.stop("SIGINT");
      const keyed = listedWorkspaces((await runCli(ctx, ["workspaces", "--json"], { home })).stdout);
      observe(ctx, "DMS_API_BASE_URL in ./.env", { explicitBlock, keyed }, [
        ctx.holds("an explicit backend ends discovery: no discovery line", !explicitBlock.includes("Backend discovered"), explicitBlock),
        ctx.equal("and keys a second workspace on the url", keyed.map((entry) => String(at(entry.key, "type"))).sort((left, right) => left.localeCompare(right)), ["project", "url"]),
      ]);
      rmSync(join(inner, ".env"));
      await second.close();

      /** @type {Record<string, import("./cli-run.mjs").CliResult>} */
      const cases = {};
      /**
       * @param {string} name The case
       * @param {(dir: string) => void} prepare Writes the registry
       */
      const failing = async (name, prepare) => {
        const dir = scratch(ctx, name);
        prepare(dir);
        cases[name] = await runCli(ctx, ["dev", "--project", ctx.state.runPlayground], { cwd: dir, home });
      };
      await failing("stale", (dir) => writeRegistry(dir, deadPid(), 1));
      await failing("malformed", (dir) => {
        mkdirSync(join(dir, ".antelope"), { recursive: true });
        writeFileSync(join(dir, ".antelope", "dev.json"), "{ nope");
      });
      await failing("no-api", (dir) => writeRegistry(dir, process.pid, null));
      const shadowed = scratch(ctx, "shadowed");
      writeRegistry(shadowed, process.pid, 1);
      const shadowing = join(shadowed, "child");
      mkdirSync(shadowing, { recursive: true });
      writeRegistry(shadowing, deadPid(), 1);
      cases.shadow = await runCli(ctx, ["dev", "--project", ctx.state.runPlayground], { cwd: shadowing, home });
      const stalePid = /pid (\d+)/.exec(cases.stale.stderr)?.[1];
      observe(ctx, "discovery failures", cases, [
        ctx.equal("a registry whose process has ended", [cases.stale.stdout, cases.stale.stderr], ["", `✖ Found ./.antelope/dev.json but its process (pid ${stalePid}) is no longer running\n  → Start the backend with 'ajs project dev', or pass -b <url> explicitly\n`]),
        ctx.equal("a registry that does not parse", cases.malformed.stderr, "✖ Found ./.antelope/dev.json but could not parse it\n  → Restart the backend with 'ajs project dev' to rewrite it, or pass -b <url> explicitly\n"),
        ctx.holds("the no-api failure names the project and the missing endpoint", cases["no-api"].stderr.startsWith("✖ Found a running antelope project at ") && cases["no-api"].stderr.includes("exposes no 'api' server endpoint"), cases["no-api"].stderr),
        ctx.holds("the first file found decides: a stale child file is not skipped for a live parent's", cases.shadow.stderr.includes("is no longer running"), cases.shadow.stderr),
        ctx.equal("all four are failures of the command", Object.values(cases).every((entry) => entry.code === 1 || entry.code === 2), true),
      ]);
    },
  },
  {
    id: "dev-public-files",
    title: "a file added to a module's public/ is served at once and not served any more once removed",
    entryPoint: "ajs dms dev with a project whose module has a public/ directory, a file added and removed while it runs",
    async run(/** @type {Context} */ ctx) {
      const fixture = writeBuildProject(buildProjectFolder(ctx, "hot"));
      const backend = await startCliBackend();
      const home = scratch(ctx, "home");
      try {
        const server = await dev(ctx, backend.url, { home, project: fixture.project });
        try {
          const file = join(fixture.project, "fx", "frontend-vue", "public", "hello.txt");
          const get = async () => {
            const answer = await fetch(`${server.local}hello.txt`);
            return [answer.status, answer.status === 200 ? await answer.text() : ""];
          };
          const before = await get();
          mkdirSync(join(file, ".."), { recursive: true });
          writeFileSync(file, "hello from public\n");
          let added = await get();
          for (let attempt = 0; attempt < 40 && added[0] !== 200; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            added = await get();
          }
          rmSync(file);
          let removed = await get();
          for (let attempt = 0; attempt < 40 && removed[0] !== 404; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            removed = await get();
          }
          observe(ctx, "public/", { before, added, removed }, [
            ctx.equal("before the file exists: 404", before[0], 404),
            ctx.equal("after it is written: 200 with its content", added, [200, "hello from public\n"]),
            ctx.equal("after it is removed: 404 again", removed[0], 404),
          ]);
        } finally {
          await server.stop("SIGINT");
        }
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "dev-port-zero",
    title: "dev -p 0 asks for any free port and does not call it busy",
    entryPoint: "ajs dms dev -p 0",
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      try {
        const any = await dev(ctx, backend.url, { home: scratch(ctx, "home"), port: 0 });
        const anyBlock = any.output();
        await any.stop("SIGINT");
        observe(ctx, "-p 0", { anyBlock }, [
          ctx.holds("any free port is not a busy port: no warning", !anyBlock.includes("is busy"), anyBlock),
          ctx.equal("the server runs on a real port", any.port > 0, true),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "dev-secret-precedence",
    title: "a variable that sets the e-mail render secret wins over the one the manifest publishes (the docs disagree: see the issue draft dms-frontend-secret-precedence-docs-contradict)",
    entryPoint: "ajs dms dev -b <backend> with DMS_HTML_RENDER_SECRET set and a manifest that publishes htmlRender.serviceSecret",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const module = writeModule(join(scratch(ctx, "module"), "mod"), { name: "@fixture/secret", privateOptions: undefined });
      const published = { ...module, privateOptions: { htmlRender: { serviceSecret: "manifest-render-secret-0123456789" } } };
      const backend = await startCliBackend({ modules: [published] });
      try {
        const server = await dev(ctx, backend.url, { home, env: { DMS_HTML_RENDER_SECRET: "variable-render-secret-0123456789" } });
        try {
          const block = server.output();
          const post = (/** @type {string} */ secret) =>
            fetch(`${server.local}api/html/render`, { method: "POST", headers: { "content-type": "application/json", "x-dms-service-token": serviceToken(secret) }, body: JSON.stringify({ templateName: "EmailAdminInvite", props: { email: "a@b.c", signupLink: "http://x/y", expiresInDays: 1 } }) }).then((answer) => answer.status);
          const withManifest = await post("manifest-render-secret-0123456789");
          const withVariable = await post("variable-render-secret-0123456789");
          observe(ctx, "both set", { block, withManifest, withVariable }, [
            ctx.equal("the ready block says the secret came from the environment", /^ {5}Secrets: {3}(.*)$/m.exec(block)?.[1], "DMS_HTML_RENDER_SECRET from the environment"),
            ctx.equal("a token signed with the variable's value renders", withVariable, 200),
            ctx.equal("a token signed with the manifest's value is refused", withManifest, 401),
          ]);
        } finally {
          await server.stop("SIGINT");
        }
      } finally {
        await backend.close();
      }
    },
  },
];

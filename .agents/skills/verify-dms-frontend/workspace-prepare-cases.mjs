import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { startCliBackend } from "./cli-backend.mjs";
import { serve } from "./build-server.mjs";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { freePort, observe, runCli, scratch } from "./cli-run.mjs";
import { workspacesRoot, writeModule } from "./workspace-fixtures.mjs";
import { SKIPPED_HINT, NOT_GENERATED, workspaceFor } from "./workspace-prepare-output.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const journeys = [
  {
    id: "prepare-failures",
    title: "prepare without --strict warns and exits 0 whenever it cannot prepare; --strict exits 1, or 2 for a missing or invalid url",
    entryPoint: "ajs dms prepare [-b <url>] [--strict] against missing, closed, refusing and broken backends",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const closedPort = await freePort();
      const closed = `http://localhost:${closedPort}`;
      const backend = await startCliBackend();
      try {
        const cases = [
          { name: "no url", args: ["prepare"], skip: true, text: `▲ Skipped prepare: no backend URL\n  → Pass -b <url> or set DMS_API_BASE_URL to generate the types\n${SKIPPED_HINT}`, strictCode: 2, strictText: "✖ Backend URL is required\n  → Pass -b <url> or set DMS_API_BASE_URL\n" },
          { name: "invalid url", args: ["prepare", "-b", "localhost:5010"], text: `▲ Prepare failed: Invalid backend URL 'localhost:5010'\n  → Include the scheme: -b http://localhost:5010\n${NOT_GENERATED}${SKIPPED_HINT}`, strictCode: 2, strictText: "✖ Invalid backend URL 'localhost:5010'\n  → Include the scheme: -b http://localhost:5010\n" },
        ];
        const results = [];
        const checks = [];
        for (const entry of cases) {
          const lenient = await runCli(ctx, entry.args, { home });
          const strict = await runCli(ctx, [...entry.args, "--strict"], { home });
          results.push({ entry, lenient, strict });
          checks.push(
            ctx.equal(`${entry.name}: warns on stderr and exits 0`, [lenient.code, lenient.stdout, lenient.stderr], [0, "", entry.text]),
            ctx.equal(`${entry.name}: --strict exits ${entry.strictCode}`, [strict.code, strict.stderr], [entry.strictCode, entry.strictText]),
          );
        }
        observe(ctx, "no or invalid url", results, checks);

        const down = await runCli(ctx, ["prepare", "-b", closed], { home });
        const downStrict = await runCli(ctx, ["prepare", "-b", closed, "--strict"], { home });
        const page = exampleOutput(docsPage(ctx, "3.cli/5.prepare.md"), "ajs dms prepare -b http://localhost:5999");
        const pageText = (page ?? "").replaceAll("5999", String(closedPort));
        observe(ctx, "a backend that is not there", { down, downStrict, page }, [
          ctx.equal("skipped, exit 0, with the page's words", [down.code, down.stderr.trimEnd()], [0, pageText]),
          ctx.equal("strict: exit 1, no install, the same title", [downStrict.code, downStrict.stderr.split("\n").slice(0, 3)], [1, [`ajs dms prepare  ${closed}`, `✖ Cannot reach the DMS backend at ${closed}`, "  Connection refused (ECONNREFUSED)."]]),
        ]);

        const refusals = [
          { name: "401 refuses the credential", status: 401, body: {}, title: "requires a bootstrap credential (401)" },
          { name: "403 refuses the credential", status: 403, body: {}, title: "requires a bootstrap credential (403)" },
          { name: "a manifest of version 3", status: 200, body: { version: 3, modules: [] }, title: "version 3" },
          { name: "a manifest of version 1", status: 200, body: { version: 1, modules: [] }, title: "version 1" },
          { name: "a manifest with no version", status: 200, body: { modules: [] }, title: "without a protocol version" },
          { name: "a module of another renderer", status: 200, body: { version: 2, modules: [{ name: "x", renderer: { name: "react", version: "18" }, path: "/x", priority: 1 }] }, title: "incompatible renderer modules: x" },
          { name: "a 500", status: 500, body: {}, title: "500" },
          { name: "a 404", status: 404, body: {}, title: "404" },
        ];
        const failures = [];
        const failureChecks = [];
        for (const refusal of refusals) {
          backend.behaviour.manifest = { status: refusal.status, body: refusal.body };
          const lenient = await runCli(ctx, ["prepare", "-b", backend.url], { home });
          const strict = await runCli(ctx, ["prepare", "-b", backend.url, "--strict"], { home });
          failures.push({ refusal, lenient, strict });
          failureChecks.push(
            ctx.holds(`${refusal.name}: "Prepare failed", the registry was not generated, exit 0`, lenient.code === 0 && lenient.stderr.includes("▲ Prepare failed: ") && lenient.stderr.includes(refusal.title) && lenient.stderr.endsWith(`${NOT_GENERATED}${SKIPPED_HINT}`), lenient.stderr),
            ctx.equal(`${refusal.name}: --strict exits 1`, strict.code, 1),
          );
        }
        observe(ctx, "a backend that answers badly", failures, failureChecks);
        observe(ctx, "no workspace is left behind by the failures", { listing: existsSync(workspacesRoot(home)) ? readdirSync(workspacesRoot(home)) : [] }, [
          ctx.equal("nothing was installed or cached", existsSync(workspacesRoot(home)) ? readdirSync(workspacesRoot(home)).filter((name) => existsSync(join(workspacesRoot(home), name, "node_modules"))) : [], []),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "prepare-cache",
    title: "prepare falls back to the cached manifest when the backend is out of reach or failing, never after a refusal; --offline and DMS_OFFLINE never ask the backend",
    entryPoint: "ajs dms prepare -b <url> after a first successful run, with the backend failing, refusing, closed",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const backend = await startCliBackend();
      try {
        const url = backend.url;
        const first = await runCli(ctx, ["prepare", "-b", url, "--strict"], { home });
        const calls = () => backend.to("/dms/frontend").length;
        await ctx.verify("a first run caches the manifest", [ctx.equal("exit 0", first.code, 0)], { critical: true });

        backend.behaviour.manifest = { status: 500, body: {} };
        const failing = await runCli(ctx, ["prepare", "-b", url, "--strict"], { home });
        observe(ctx, "a failing backend", { failing }, [
          ctx.equal("the cache stands in, with a warning, and strict still succeeds", [failing.code, failing.stderr.includes("▲ Backend unreachable: using the frontend-module manifest cached just now\n"), failing.stderr.includes("✔ Prepared the workspace · 0 modules")], [0, true, true]),
        ]);
        const statuses = [401, 403];
        /** @type {import("./cli-run.mjs").CliResult[]} */
        const unauthorized = [];
        for (const status of statuses) {
          backend.behaviour.manifest = { status, body: {} };
          unauthorized.push(await runCli(ctx, ["prepare", "-b", url], { home }));
        }
        backend.behaviour.manifest = { status: 200, body: { version: 3, modules: [] } };
        const newer = await runCli(ctx, ["prepare", "-b", url], { home });
        observe(ctx, "a refusal never falls back", { unauthorized, newer }, [
          ...statuses.map((status, index) => ctx.holds(`${status}: failed, the cache is not used`, unauthorized[index].code === 0 && unauthorized[index].stderr.includes("▲ Prepare failed: ") && !unauthorized[index].stderr.includes("using the frontend-module manifest") && !unauthorized[index].stderr.includes("✔ Prepared"), unauthorized[index].stderr)),
          ctx.holds("a manifest of another version: failed, the cache is not used", newer.stderr.includes("▲ Prepare failed: ") && !newer.stderr.includes("using the frontend-module manifest"), newer.stderr),
        ]);

        const offline = {
          flag: calls(),
        };
        const before = calls();
        const withFlag = await runCli(ctx, ["prepare", "-b", url, "--offline"], { home });
        const withEnv = await runCli(ctx, ["prepare", "-b", url], { home, env: { DMS_OFFLINE: "1" } });
        const afterOffline = calls();
        backend.behaviour.manifest = { status: 200, body: { version: 2, modules: [] } };
        const envOff = await runCli(ctx, ["prepare", "-b", url], { home, env: { DMS_OFFLINE: "off" } });
        observe(ctx, "offline", { offline, withFlag, withEnv, envOff }, [
          ctx.equal("--offline and DMS_OFFLINE=1 never ask the backend", afterOffline - before, 0),
          ctx.equal("--offline says it uses the cache, as information", [withFlag.code, withFlag.stderr.includes("ℹ Offline: using the frontend-module manifest cached just now\n"), withFlag.stderr.includes("▲ Backend unreachable")], [0, true, false]),
          ctx.equal("DMS_OFFLINE=1 is --offline", [withEnv.code, withEnv.stderr.includes("ℹ Offline: using the frontend-module manifest cached just now\n")], [0, true]),
          ctx.equal("DMS_OFFLINE=off asks the backend", [calls() - afterOffline, envOff.stderr.includes("Offline")], [1, false]),
        ]);

        const fresh = `http://127.0.0.1:${await freePort()}`;
        const lonely = await runCli(ctx, ["prepare", "-b", fresh, "--offline"], { home });
        const lonelyStrict = await runCli(ctx, ["prepare", "-b", fresh, "--offline", "--strict"], { home });
        observe(ctx, "offline without a cache", { lonely, lonelyStrict }, [
          ctx.equal("skipped, exit 0", [lonely.code, lonely.stderr.includes("▲ Skipped prepare: No cached manifest for this workspace\n  → Run once with the backend reachable before using --offline\n")], [0, true]),
          ctx.equal("strict: exit 1", lonelyStrict.code, 1),
          ctx.equal("nothing was installed or cached for the other url", [existsSync(join(workspaceFor(home, fresh), "node_modules")), existsSync(join(workspaceFor(home, fresh), ".manifest-cache.json"))], [false, false]),
        ]);
      } finally {
        await backend.close();
      }
      const gone = await runCli(ctx, ["prepare", "-b", backend.url], { home });
      const moduleDir = join(scratch(ctx, "module"), "mod");
      const withModule = await startCliBackend({ modules: [writeModule(moduleDir, { engines: ">=0.10.0 <0.11.0" })] });
      const second = await runCli(ctx, ["prepare", "-b", withModule.url, "--strict"], { home });
      await withModule.close();
      const { rmSync } = await import("node:fs");
      rmSync(moduleDir, { recursive: true, force: true });
      const stale = await runCli(ctx, ["prepare", "-b", withModule.url], { home });
      observe(ctx, "the backend is closed", { gone, second, stale }, [
        ctx.holds("closed backend with a cache: unreachable warning, prepared from the cache", gone.code === 0 && gone.stderr.includes("▲ Backend unreachable: using the frontend-module manifest cached ") && gone.stderr.includes("✔ Prepared the workspace"), gone.stderr),
        ctx.equal("a module with a cache prepared", second.code, 0),
        ctx.holds("a cached module whose source directory is gone: failure that says to start the backend", stale.code === 0 && stale.stderr.includes("references layer paths that no longer exist") && stale.stderr.includes("→ Start the backend and run again to refresh the cache") && stale.stderr.includes(moduleDir), stale.stderr),
      ]);
    },
  },
  {
    id: "prepare-discovered-credential",
    title: "prepare reads the development credential from .antelope/dms-dev.json for the project's own backend only, and an explicit credential always wins",
    entryPoint: "ajs dms prepare -b <url> from a folder holding .antelope/dev.json and .antelope/dms-dev.json",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const own = await startCliBackend();
      const other = await startCliBackend();
      const project = scratch(ctx, "app");
      const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
      /**
       * @param {number} pid The process the credential belongs to
       */
      const handshake = (pid) => {
        mkdirSync(join(project, ".antelope"), { recursive: true });
        writeFileSync(join(project, ".antelope", "dev.json"), JSON.stringify({ pid: process.pid, servers: { api: { endpoints: [{ protocol: "http", host: "127.0.0.1", port: own.port }] } } }));
        writeFileSync(join(project, ".antelope", "dms-dev.json"), JSON.stringify({ pid, bootstrapSecret: "dev-credential" }));
      };
      /**
       * @param {import("./cli-backend.mjs").CliBackend} backend The backend asked
       * @param {string[]} args More arguments
       * @param {Record<string, string | undefined>} [env] More variables
       */
      const sent = async (backend, args, env) => {
        const before = backend.to("/dms/frontend").length;
        const result = await runCli(ctx, ["prepare", "-b", backend.url, ...args], { cwd: project, home, env });
        const requests = backend.to("/dms/frontend").slice(before);
        return { result, headers: requests.map((request) => request.headers["x-dms-bootstrap"]) };
      };
      try {
        handshake(process.pid);
        const ownRun = await sent(own, []);
        const spelled = await runCli(ctx, ["prepare", "-b", own.url.replace("127.0.0.1", "localhost")], { cwd: project, home });
        const spelledSeen = own.to("/dms/frontend").at(-1)?.headers["x-dms-bootstrap"];
        const otherRun = await sent(other, []);
        const explicit = await sent(own, ["--bootstrap-secret", "explicit"]);
        const viaEnv = await sent(own, [], { DMS_BOOTSTRAP_SECRET: "from-env" });
        handshake(deadPid);
        const stale = await sent(own, []);
        observe(ctx, "which credential goes where", { ownRun, otherRun, explicit, viaEnv, stale }, [
          ctx.equal("the project's own backend gets the development credential", ownRun.headers, ["dev-credential"]),
          ctx.equal("also when the url is spelled localhost", [spelled.code, spelledSeen], [0, "dev-credential"]),
          ctx.equal("another backend never gets it", otherRun.headers, [undefined]),
          ctx.equal("--bootstrap-secret wins", explicit.headers, ["explicit"]),
          ctx.equal("DMS_BOOTSTRAP_SECRET wins", viaEnv.headers, ["from-env"]),
          ctx.equal("a credential whose backend process has ended is not used", stale.headers, [undefined]),
        ]);
      } finally {
        await own.close();
        await other.close();
      }
    },
  },
  {
    id: "prepare-trailing-slash",
    title: "a backend url with a trailing slash reaches the same endpoints as the one without",
    entryPoint: "ajs dms prepare -b <url>/ and ajs dms start -b <url>/ against a backend of the journey's own",
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      const home = scratch(ctx, "home");
      try {
        const prepared = await runCli(ctx, ["prepare", "-b", `${backend.url}/`, "--strict"], { home });
        const paths = backend.requests.map((request) => request.url.split("?")[0]);
        observe(ctx, "prepare", { prepared, paths }, [
          ctx.equal("the manifest is asked for at /dms/frontend", paths, ["/dms/frontend"]),
          ctx.equal("so the run does not need a cache to succeed", [prepared.code, prepared.stderr.includes("Backend unreachable")], [0, false]),
        ]);
        const server = await serve(ctx, `${backend.url}/`);
        await server.waitFor("Reported 2 modules", 20000).catch(() => undefined);
        await server.stop("SIGINT");
        const reported = backend.requests.slice(paths.length).map((request) => request.url.split("?")[0]);
        observe(ctx, "start", { reported }, [ctx.equal("the ready report goes to /dms/frontend/ready", reported.slice(0, 1), ["/dms/frontend/ready"])]);
      } finally {
        await backend.close();
      }
    },
  },
];

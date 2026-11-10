import { join } from "node:path";
import { accepts, lanAddresses } from "./build-network.mjs";
import { at, isText, keysOf, listAt, parseJson, textAt } from "./json.mjs";
import { startCliBackend } from "./cli-backend.mjs";
import { docsPage } from "./cli-docs.mjs";
import { freePort, holdPort, observe, scratch } from "./cli-run.mjs";
import { BOOTSTRAP_SECRET, RELAY_SECRET, RENDER_SECRET, SESSION_SECRET, builtWorkspace, serve, snapshot, whileServing } from "./build-server.mjs";
import { writeFileSync } from "node:fs";
import { rendererVersion } from "./cli-json.mjs";
import { standalone } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const SECOND = 1000;

export const journeys = [
  {
    id: "start-ready",
    title: "start prints its ready block, serves on the port asked, reports its modules to the backend, and exits 130 on Ctrl+C",
    entryPoint: "ajs dms start -b <backend> -p <port> from the run's playground",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      try {
        const server = await serve(ctx, backend.url);
        const lines = server.output().split("\n");
        const block = server.output();
        await whileServing(server, async () => {
          const index = await fetch(`${server.local}dms-preview`, { redirect: "manual" });
          observe(ctx, "the ready block", { output: block }, [
            ctx.holds("the header: backend, environment, age of the build", /^ajs dms start {2}http:\/\/127\.0\.0\.1:\d+ · docs · built (just now|\d+ min ago|\d+ h ago|\d+ days? ago)$/.test(lines[0]) && lines[0].includes(backend.url), lines[0]),
            ctx.holds("ready in a duration", /^✔ Production server ready in \d+(\.\d+)?(ms|s)$/m.test(block), block),
            ctx.equal("Local is localhost on the port asked", /^ {2}➜ {2}Local: {5}(\S+)$/m.exec(block)?.[1], `http://localhost:${server.port}/`),
            ctx.equal("Backend and Workspace lines", [/^ {5}Backend: {3}(.*)$/m.exec(block)?.[1], /^ {5}Workspace: (.*)$/m.exec(block)?.[1]], [backend.url, builtWorkspace(ctx)]),
            ctx.equal("both secrets of the environment are named, never their values", [/^ {5}Secrets: {3}(.*)$/m.exec(block)?.[1], block.includes(RENDER_SECRET), block.includes(RELAY_SECRET), block.includes(SESSION_SECRET), block.includes(BOOTSTRAP_SECRET)], ["DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the environment", false, false, false, false]),
            ctx.holds("the Ctrl+C hint closes the block", block.includes("     Ctrl+C to stop\n"), block),
            ctx.holds("the routing summary: renderer files, module routes, the proxies", /^Routing: renderer files, then \d+ module routes, then the backend proxies below, then the pages$/m.test(block) && /^ {2}\/api\/\*\* {2,}-> backend \(session\), declared by antelopejs__dms-frontend-vue$/m.test(block) && /^ {2}\/dms\/\*\* {2,}-> backend \(session\), declared by antelopejs__dms-frontend-vue$/m.test(block), block),
            ctx.equal("the server answers on that port", index.status < 500, true),
            ctx.equal("no warning about secrets, NODE_ENV or modules", block.includes("▲"), false),
          ]);
        });
        const stopped = await server.exited;
        const reports = backend.to("/dms/frontend/ready");
        const body = parseJson(reports[0]?.body ?? "");
        observe(ctx, "Ctrl+C and the ready report", { stopped, output: server.output(), reports }, [
          ctx.equal("SIGINT ends the server with exit code 130", [stopped.code, stopped.signal], [130, null]),
          ctx.holds("the last line says it stopped, and for how long it ran", /^■ Stopped the production server · ran \d+(\.\d+)?(ms|s)$/m.test(server.output().trimEnd().split("\n").at(-1) ?? ""), server.output().slice(-200)),
          ctx.equal("one ready report, POST, with the bootstrap secret in x-dms-bootstrap", [reports.length, reports[0]?.method, reports[0]?.headers["x-dms-bootstrap"], reports[0]?.headers["content-type"]], [1, "POST", BOOTSTRAP_SECRET, "application/json"]),
          ctx.equal("it carries the version of the renderer", textAt(body, "version"), rendererVersion(ctx)),
          ctx.equal("it lists the modules the build holds, each with its version", listAt(body, "modules").map((module) => [textAt(module, "name"), isText(at(module, "version"))])
              .sort((left, right) => String(left[0]).localeCompare(String(right[0]))), [["@antelopejs/dms-frontend-vue", true], ["playground-frontend", true]]),
          ctx.equal("the body has only modules and version", keysOf(body).sort((left, right) => left.localeCompare(right)), ["modules", "version"]),
          ctx.holds("the CLI said what it reported", block.includes(`ℹ [DMS] Reported 2 modules to the backend (dms-frontend ${rendererVersion(ctx)})`), block),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "start-ready-report-retries",
    title: "the ready report is repeated after 2 s, then 4 s while the backend is starting, ends on any other answer, and finds a backend that comes up later",
    entryPoint: "ajs dms start against a backend that answers 503, 401, 404, or is not there yet",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const flaky = await startCliBackend();
      flaky.behaviour.ready = (index) => (index < 2 ? 503 : 204);
      try {
        const server = await serve(ctx, flaky.url);
        await whileServing(server, async () => {
          await server.waitFor("Reported 2 modules", 30 * SECOND);
          const times = flaky.to("/dms/frontend/ready").map((request) => request.at);
          const gaps = [times[1] - times[0], times[2] - times[1]];
          observe(ctx, "503 twice, then 204", { times, gaps, output: server.output() }, [
            ctx.equal("three reports", times.length, 3),
            ctx.holds("the first retry comes after 2 seconds", gaps[0] >= 1900 && gaps[0] < 3500, `${gaps[0]} ms`),
            ctx.holds("the next delay doubles to 4 seconds", gaps[1] >= 3900 && gaps[1] < 6000, `${gaps[1]} ms`),
            ctx.equal("the success is said once", server.output().split("Reported 2 modules").length - 1, 1),
          ]);
        });
      } finally {
        await flaky.close();
      }

      const refusing = await startCliBackend();
      refusing.behaviour.ready = () => 401;
      try {
        const server = await serve(ctx, refusing.url);
        await whileServing(server, async () => {
          await server.waitFor("refused the ready report", 20 * SECOND);
          await new Promise((resolve) => setTimeout(resolve, 5 * SECOND));
          observe(ctx, "401", { output: server.output() }, [
            ctx.equal("one report, no retry", refusing.to("/dms/frontend/ready").length, 1),
            ctx.holds("a warning that names the fix", server.output().includes("▲ [DMS] The backend refused the ready report: it cannot check this build's module versions\n  → Set DMS_BOOTSTRAP_SECRET to the backend's frontend.bootstrapSecret\n"), server.output()),
          ]);
        });
      } finally {
        await refusing.close();
      }

      const missing = await startCliBackend();
      missing.behaviour.ready = () => 404;
      try {
        const server = await serve(ctx, missing.url);
        await whileServing(server, async () => {
          await server.waitFor("refused the ready report", 20 * SECOND);
          await new Promise((resolve) => setTimeout(resolve, 3 * SECOND));
          observe(ctx, "404", {}, [ctx.equal("any answer below 500 ends the retries", missing.to("/dms/frontend/ready").length, 1)]);
        });
      } finally {
        await missing.close();
      }

      const port = await freePort();
      const server = await serve(ctx, `http://127.0.0.1:${port}`);
      let late;
      try {
        await new Promise((resolve) => setTimeout(resolve, 3 * SECOND));
        late = await startCliBackend({ port });
        await server.waitFor("Reported 2 modules", 30 * SECOND);
        observe(ctx, "a backend that was not there at start", { output: server.output(), requests: late.requests }, [
          ctx.equal("the server was ready without it", server.output().includes("✔ Production server ready"), true),
          ctx.equal("the report arrived once the backend listened", late.to("/dms/frontend/ready").length >= 1, true),
        ]);
      } finally {
        await server.stop("SIGINT");
        await late?.close();
      }
    },
  },
  {
    id: "start-addresses-and-ports",
    title: "start binds 0.0.0.0 unless HOST says otherwise, stops on a busy port, reads PORT and ./.env, and writes nothing into the workspace",
    entryPoint: "ajs dms start with HOST, PORT, -p, a busy port and a .env in the working directory",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      try {
        const before = snapshot(builtWorkspace(ctx));
        const open = await serve(ctx, backend.url);
        const lan = lanAddresses();
        const listing = open.output();
        await whileServing(open, async () => {
          observe(ctx, "default address", { lan, output: listing }, [
            ctx.equal("it accepts connections on 127.0.0.1", await accepts(open.port, "127.0.0.1"), true),
            ctx.equal("and on every LAN address of this machine", await Promise.all(lan.map((address) => accepts(open.port, address))), lan.map(() => true)),
            ctx.equal("a Network line per LAN address, up to 3", (listing.match(/^ {2}➜ {2}Network:/gm) ?? []).length > 0 || lan.length === 0, true),
          ]);
        });
        const local = await serve(ctx, backend.url, { env: { HOST: "127.0.0.1" } });
        const localOutput = local.output();
        await whileServing(local, async () => {
          observe(ctx, "HOST=127.0.0.1", { output: localOutput }, [
            ctx.equal("loopback accepts", await accepts(local.port, "127.0.0.1"), true),
            ctx.equal("no LAN address accepts", await Promise.all(lan.map((address) => accepts(local.port, address))), lan.map(() => false)),
            ctx.equal("no Network line", localOutput.includes("Network:"), false),
          ]);
        });
        const after = snapshot(builtWorkspace(ctx));
        observe(ctx, "the workspace", { before: before.length, after: after.length }, [
          ctx.equal("start wrote nothing into the build: same files, sizes, modification times", after, before),
        ]);

        const busy = await holdPort("127.0.0.1");
        const clash = await serve(ctx, backend.url, { port: busy.port, ready: "already in use" });
        const clashOutput = clash.output();
        await clash.exited;
        await busy.release();
        observe(ctx, "a busy port", { clashOutput }, [
          ctx.holds("start stops with the title and the fix, even when the other process listens on loopback only", clashOutput.includes(`✖ Port ${busy.port} is already in use\n  → Stop the process listening on it, or pass another port: -p <port>`), clashOutput),
          ctx.equal("the server did not start", clashOutput.includes("Production server ready"), false),
        ]);

        const fromEnv = await freePort();
        const viaPort = await serve(ctx, backend.url, { port: null, env: { PORT: String(fromEnv) } });
        await whileServing(viaPort, async () => {
          observe(ctx, "PORT", {}, [ctx.equal("PORT is -p", viaPort.port, fromEnv)]);
        });
        const flagPort = await freePort();
        const flagWins = await serve(ctx, backend.url, { port: flagPort, env: { PORT: String(fromEnv) } });
        await whileServing(flagWins, async () => {
          observe(ctx, "-p and PORT", {}, [ctx.equal("-p wins over PORT", flagWins.port, flagPort)]);
        });
        const dotenvPort = await freePort();
        const cwd = scratch(ctx, "dotenv-cwd");
        writeFileSync(join(cwd, ".env"), `PORT=${dotenvPort}\n`);
        const viaFile = await serve(ctx, backend.url, { port: null, cwd });
        await whileServing(viaFile, async () => {
          observe(ctx, "./.env", {}, [ctx.equal("PORT from ./.env of the working directory", viaFile.port, dotenvPort)]);
        });
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "start-secrets-and-environment",
    title: "start names the secrets it runs without, warns when NODE_ENV is not production, and -q prints only the Local url",
    entryPoint: "ajs dms start with and without DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET, NODE_ENV, -q",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      const secretLines = "▲ DMS_HTML_RENDER_SECRET is not set: e-mail renders will be refused\n▲ DMS_OAUTH_RELAY_SECRET is not set: OAuth sign-in will be refused by the backend\n  → Set them in the server's environment, with the values the backend uses\n";
      const troubleshooting = docsPage(ctx, "9.troubleshooting.md");
      try {
        const none = await serve(ctx, backend.url, { env: { DMS_HTML_RENDER_SECRET: undefined, DMS_OAUTH_RELAY_SECRET: undefined } });
        const noneOutput = none.output();
        await none.stop();
        const onlyRender = await serve(ctx, backend.url, { env: { DMS_OAUTH_RELAY_SECRET: undefined } });
        const onlyRenderOutput = onlyRender.output();
        await onlyRender.stop();
        observe(ctx, "secrets the server runs without", { noneOutput, onlyRenderOutput }, [
          ctx.holds("both missing: one warning each, one hint, before the server starts", noneOutput.includes(secretLines) && noneOutput.indexOf(secretLines) < noneOutput.indexOf("✔ Production server ready"), noneOutput),
          ctx.holds("both missing: no Secrets line", !noneOutput.includes("Secrets:"), noneOutput),
          ctx.holds("the troubleshooting page words the warning the same", troubleshooting.includes("▲ DMS_HTML_RENDER_SECRET is not set: e-mail renders will be refused") && troubleshooting.includes("▲ DMS_OAUTH_RELAY_SECRET is not set: OAuth sign-in will be refused by the backend"), "page"),
          ctx.holds("only the relay secret missing: its warning alone, with the singular hint", onlyRenderOutput.includes("▲ DMS_OAUTH_RELAY_SECRET is not set: OAuth sign-in will be refused by the backend\n  → Set it in the server's environment, with the value the backend uses\n") && !onlyRenderOutput.includes("DMS_HTML_RENDER_SECRET is not set"), onlyRenderOutput),
          ctx.equal("only the relay secret missing: the Secrets line names the one that is set", /^ {5}Secrets: {3}(.*)$/m.exec(onlyRenderOutput)?.[1], "DMS_HTML_RENDER_SECRET from the environment"),
        ]);

        const development = await serve(ctx, backend.url, { env: { NODE_ENV: "development" } });
        const developmentOutput = development.output();
        await development.stop();
        const fromFile = scratch(ctx, "node-env-cwd");
        writeFileSync(join(fromFile, ".env"), "NODE_ENV=staging\n");
        const staging = await serve(ctx, backend.url, { cwd: fromFile });
        const stagingOutput = staging.output();
        await staging.stop();
        const production = await serve(ctx, backend.url, { env: { NODE_ENV: "production" } });
        const productionOutput = production.output();
        await production.stop();
        const empty = await serve(ctx, backend.url, { env: { NODE_ENV: "" } });
        const emptyOutput = empty.output();
        await empty.stop();
        const warning = (value) => `▲ NODE_ENV is ${value}: the server renders with the development builds of Vue and its libraries\n  → Unset it for start, or set it to production\n`;
        observe(ctx, "NODE_ENV", { developmentOutput, stagingOutput }, [
          ctx.holds("development: the warning, the server still starts", developmentOutput.includes(warning("development")) && developmentOutput.includes("✔ Production server ready"), developmentOutput),
          ctx.holds("a value from ./.env counts", stagingOutput.includes(warning("staging")), stagingOutput),
          ctx.equal("production and an empty value give no warning", [productionOutput.includes("NODE_ENV"), emptyOutput.includes("NODE_ENV")], [false, false]),
          ctx.holds("the start page words the warning the same", docsPage(ctx, "3.cli/4.start.md").includes(warning("development").replace("\n  →", "\n  →")), "page"),
        ]);

      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "start-quiet",
    title: "start -q prints only the Local url once ready",
    entryPoint: "ajs dms start -q, and ANTELOPEJS_QUIET=1",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const backend = await startCliBackend();
      try {
        const quiet = await serve(ctx, backend.url, { args: ["-q"], ready: "Local:" });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const quietOutput = quiet.output();
        await quiet.stop();
        const viaEnv = await serve(ctx, backend.url, { env: { ANTELOPEJS_QUIET: "1" }, ready: "Local:" });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const envOutput = viaEnv.output();
        await viaEnv.stop();
        const only = (port) => [`  ➜  Local: http://localhost:${port}/`];
        observe(ctx, "quiet", { quietOutput, envOutput }, [
          ctx.equal("-q: only the Local url is printed", quietOutput.split("\n").filter(Boolean), only(quiet.port)),
          ctx.equal("ANTELOPEJS_QUIET=1: only the Local url is printed", envOutput.split("\n").filter(Boolean), only(viaEnv.port)),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
];

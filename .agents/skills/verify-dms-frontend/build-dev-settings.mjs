import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { at } from "./json.mjs";
import { listedWorkspaces } from "./cli-json.mjs";
import { startCliBackend } from "./cli-backend.mjs";
import { serviceToken } from "./web.mjs";
import { startFakeBackend } from "./proxy-satellite.mjs";
import { fakeAuthBackend, signIn } from "./proxy-signin.mjs";
import { writeModule } from "./workspace-fixtures.mjs";
import { observe, runCli, scratch } from "./cli-run.mjs";
import { buildProjectFolder, writeBuildProject } from "./build-project.mjs";
import { dev, writeRegistry, deadPid } from "./build-dev-launch.mjs";
import { standalone } from "./standalone.mjs";
import { docsPage } from "./cli-docs.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const journeys = [
  {
    id: "dev-discovery",
    title: "dev without -b finds the backend of the enclosing project in .antelope/dev.json, keys its workspace on that project, and stops at the first file it finds",
    entryPoint: "ajs dms dev from inside a folder holding .antelope/dev.json",
    ...standalone,
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
    ...standalone,
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
    ...standalone,
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
    title: "the e-mail render secret the manifest publishes for a module of the project wins over DMS_HTML_RENDER_SECRET, as the configuration page says and the dev page does not contradict (AntelopeJS/dms-frontend#282)",
    entryPoint: "ajs dms dev -b <backend> with DMS_HTML_RENDER_SECRET set and a manifest that publishes htmlRender.serviceSecret for the playground's @antelopejs/dms-frontend-vue",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const configuration = docsPage(ctx, "4.configuration.md");
      const devPage = docsPage(ctx, "3.cli/2.dev.md");
      observe(ctx, "docs", { configuration: configuration.includes("The manifest value wins over a variable you set"), devPage: devPage.includes("wins over the manifest") }, [
        ctx.holds("the configuration page says the manifest value wins", configuration.includes("The manifest value wins over a variable you set"), "4.configuration.md"),
        ctx.holds("the dev page does not say a variable wins over the manifest", !devPage.includes("wins over the manifest"), "3.cli/2.dev.md"),
      ]);
      const module = writeModule(join(scratch(ctx, "module"), "mod"), { name: "@antelopejs/dms-frontend-vue", privateOptions: undefined });
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
            ctx.equal("the ready block says the secret came from the manifest", /^ {5}Secrets: {3}(.*)$/m.exec(block)?.[1], "DMS_HTML_RENDER_SECRET from the manifest"),
            ctx.equal("a token signed with the manifest's value renders", withManifest, 200),
            ctx.equal("a token signed with the variable's value is refused", withVariable, 401),
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
    id: "dev-cookie-secure",
    title: "the dev server's session cookie is not Secure unless DMS_COOKIE_SECURE says so",
    entryPoint: "POST /auth/login on ajs dms dev, with DMS_COOKIE_SECURE unset, false and true",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const { handler } = fakeAuthBackend((request, response) => {
        const path = (request.url ?? "").split("?")[0];
        response.writeHead(path === "/dms/frontend" ? 200 : path === "/dms/frontend/ready" ? 204 : 404, { "content-type": "application/json" });
        response.end(path === "/dms/frontend" ? JSON.stringify({ version: 2, modules: [] }) : "{}");
      });
      const backend = await startFakeBackend(handler);
      try {
        /** @type {Record<string, string | undefined>} */
        const lines = {};
        for (const [label, value] of [["unset", undefined], ["false", "false"], ["true", "true"]]) {
          const server = await dev(ctx, backend.url, { home: scratch(ctx, `home-${label}`), env: { DMS_COOKIE_SECURE: value } });
          try {
            const login = await signIn({ url: server.local.replace(/\/$/, "") });
            lines[label] = login.cookies.find((cookie) => cookie.startsWith("dms_session_"));
          } finally {
            await server.stop("SIGINT");
          }
        }
        const flags = (/** @type {string | undefined} */ line) => (line ?? "").split("; ").slice(1);
        observe(ctx, "the session cookie", lines, [
          ctx.equal("unset: HttpOnly and SameSite=Lax, no Secure", flags(lines.unset), ["Path=/", "HttpOnly", "SameSite=Lax"]),
          ctx.equal("false: no Secure", flags(lines.false), ["Path=/", "HttpOnly", "SameSite=Lax"]),
          ctx.equal("true: Secure", flags(lines.true), ["Path=/", "HttpOnly", "SameSite=Lax", "Secure"]),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
];

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnvironment, observe, scratch } from "./cli-run.mjs";
import { RENDERER_RANGE } from "./renderer-range.mjs";
import { startDev } from "./routing-dev.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const CACHE = ".antelope/cache";
const GIT_ROUTE = "/api/_fxgit/ping";

/**
 * A git repository of a DMS module whose frontend registers a server route, committed on `main`.
 *
 * @param {Context} ctx The journey
 * @param {string} dir Where to create it
 * @returns {{ code: number | null, output: string }} How `git` ended
 */
function gitModule(ctx, dir) {
  mkdirSync(join(dir, "frontend-vue"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx-git", version: "1.0.0", main: "index.js", dmsFrontend: "frontend.js" }));
  writeFileSync(join(dir, "index.js"), "exports.construct = () => {};\nexports.destroy = () => {};\nexports.start = () => {};\nexports.stop = () => {};\n");
  writeFileSync(join(dir, "frontend.js"), 'exports.frontendModule = () => ({ name: "fx-git", sourcePath: require("node:path").join(__dirname, "frontend-vue"), renderer: { name: "vue", version: "3" } });\n');
  writeFileSync(join(dir, "frontend-vue", "package.json"), JSON.stringify({ name: "fx-git-frontend-vue", version: "1.0.0", type: "module", engines: { "@antelopejs/dms-frontend": RENDERER_RANGE } }));
  writeFileSync(join(dir, "frontend-vue", "dms.frontend.ts"), "export default { setup() {} };\n");
  writeFileSync(join(dir, "frontend-vue", "dms.server.ts"), `import { defineDmsServer } from "#dms/server";\n\nexport default defineDmsServer((server) => {\n  server.registerRoute("GET", "${GIT_ROUTE}", () => ({ ok: true }));\n});\n`);
  const env = cliEnvironment(ctx, ctx.state.home, { GIT_AUTHOR_NAME: "fx", GIT_AUTHOR_EMAIL: "fx@verify.local", GIT_COMMITTER_NAME: "fx", GIT_COMMITTER_EMAIL: "fx@verify.local" });
  const steps = [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "fx"]].map((args) => spawnSync("git", args, { cwd: dir, env, encoding: "utf8" }));
  return { code: steps.find((step) => step.status !== 0)?.status ?? 0, output: steps.map((step) => `${step.stdout}${step.stderr}`).join("") };
}

/**
 * A fresh project that lists `@antelopejs/dms` from npm, at the version this checkout installs, and the git module.
 *
 * @param {Context} ctx The journey
 * @param {string} dir The project folder
 * @param {string} remote The git module's repository
 * @returns {string} The `@antelopejs/dms` version it asks for
 */
function project(ctx, dir, remote) {
  const version = String(JSON.parse(readFileSync(join(ctx.state.renderer ?? "", "node_modules", "@antelopejs", "dms", "package.json"), "utf8")).version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fx-dev", private: true }));
  const dms = { source: { type: "package", package: "@antelopejs/dms", version }, config: { auth: { jwtSecret: "dev" }, htmlRender: { serviceSecret: "dev" } } };
  const git = { source: { type: "git", remote, branch: "main" } };
  writeFileSync(join(dir, "antelope.config.ts"), `export default ${JSON.stringify({ name: "fx-dev", cacheFolder: CACHE, modules: { dms, "fx-git": git }, environments: { docs: {} } }, null, 2)};\n`);
  return version;
}

export const journeys = [
  {
    id: "dev-serves-modules-from-the-core-cache-and-git",
    title: "ajs dms dev serves the pages and routes of a module core installed from npm into its versioned cache and of a module installed from git",
    entryPoint: "ajs project build in a fresh project listing @antelopejs/dms from npm and a git module, then ajs dms dev there against the run's backend",
    async run(/** @type {Context} */ ctx) {
      const remote = scratch(ctx, "fx-git");
      const git = gitModule(ctx, remote);
      const dir = scratch(ctx, "project");
      const version = project(ctx, dir, remote);
      const core = join(ctx.state.renderer ?? "", "node_modules", "@antelopejs", "core", "dist", "core", "cli", "index.js");
      const build = spawnSync(process.execPath, [core, "project", "build"], { cwd: dir, env: cliEnvironment(ctx, ctx.state.home), encoding: "utf8", timeout: 600_000 });
      const cached = existsSync(join(dir, CACHE)) ? readdirSync(join(dir, CACHE), { recursive: true }).map(String) : [];
      observe(
        ctx,
        "core installs both modules",
        { git, build: `${build.stdout}${build.stderr}`.slice(-3000), cached: cached.filter((path) => path.split("/").length <= 2) },
        [
          ctx.equal("git commits the module", git.code, 0),
          ctx.holds("core loads the two modules", /Loaded 2 modules/.test(`${build.stdout}${build.stderr}`), `${build.stdout}${build.stderr}`.slice(-600)),
          ctx.holds("@antelopejs/dms sits in its versioned cache folder", cached.includes(`@antelopejs/dms@${version}`), cached.slice(0, 20).join(", ")),
        ],
        { critical: true },
      );
      const server = await startDev(ctx, {}, "", dir);
      try {
        const log = server.log();
        const route = await fetch(`${server.url}${GIT_ROUTE}`, { signal: AbortSignal.timeout(30_000) });
        const routeBody = await route.text();
        const page = await fetch(`${server.url}/auth`, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(30_000) });
        observe(ctx, "ajs dms dev in the project", { log, route: { status: route.status, body: routeBody }, page: page.status }, [
          ctx.equal("no module is reported as not installed", log.includes("is not installed"), false),
          ctx.holds("both module sources are watched", /Watching 2 layer sources/.test(log), /Watching .*/.exec(log)?.[0] ?? log.slice(-400)),
          ctx.holds("the dms module's backend proxies are routed", /\/dms\/\*\*\s+-> backend \(session\), declared by antelopejs__dms-frontend-vue/.test(log), log.slice(-800)),
          ctx.equal("the git module's server route answers", [route.status, routeBody], [200, '{"ok":true}']),
          ctx.equal("the dms module's sign-in page renders", page.status, 200),
        ]);
      } finally {
        await server.stop();
      }
    },
  },
];

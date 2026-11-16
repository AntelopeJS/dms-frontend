import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { observe, runCli, scratch, startCli } from "./cli-run.mjs";
import { BROKEN_COMPONENT, buildProjectFolder, writeBuildProject } from "./build-project.mjs";
import { serve, whileServing } from "./build-server.mjs";
import { startFakeBackend } from "./proxy-satellite.mjs";
import { exchange } from "./proxy-http.mjs";
import { fakeAuthBackend, signIn } from "./proxy-signin.mjs";
import { BUILD_TIMEOUT_MS, untimed } from "./build-run-output.mjs";
import { standalone } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const journeys = [
  {
    id: "build-arguments",
    title: "build checks DMS_ENTRY_WEIGHT_WARNING before it does anything, and reads the project and environment it is given",
    entryPoint: "DMS_ENTRY_WEIGHT_WARNING=<value> ajs dms build, --project, -e",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const cwd = scratch(ctx, "cwd");
      const values = ["abc", "-1", "NaN", "12KB"];
      const results = [];
      for (const value of values) {
        results.push(await runCli(ctx, ["build", "--workspace", join(cwd, `ws-${value}`)], { cwd, env: { DMS_ENTRY_WEIGHT_WARNING: value } }));
      }
      const fix = "  → Set DMS_ENTRY_WEIGHT_WARNING=50, or 0 to turn the warning off\n";
      const checks = values.map((value, index) =>
        ctx.equal(`${JSON.stringify(value)}: exit 1 before any header or workspace`, [results[index].code, results[index].stderr, existsSync(join(cwd, `ws-${value}`))], [1, `✖ DMS_ENTRY_WEIGHT_WARNING is not a size\n  It is ${JSON.stringify(value)}; it takes a number of KB of Brotli.\n${fix}`, false]),
      );
      observe(ctx, "values that are no size", { results }, checks);
      const missing = await runCli(ctx, ["build", "--project", join(cwd, "no-such-project"), "--workspace", join(cwd, "ws-missing")], { cwd });
      observe(ctx, "a project that is not there", { missing }, [
        ctx.holds("exit 1 with a message on stderr, nothing on stdout", missing.code === 1 && missing.stdout === "" && missing.stderr.startsWith("ajs dms build  ") && missing.stderr.includes("✖ "), missing.stderr),
      ]);
    },
  },
  {
    id: "build-failure",
    title: "a build step that fails stops the build with exit 1 and points at the file in the module, not its copy in the workspace",
    entryPoint: "ajs dms build --project <project> with a module whose component does not compile",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const bad = writeBuildProject(buildProjectFolder(ctx, "bad"), { component: BROKEN_COMPONENT });
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const failed = await runCli(ctx, ["build", "--project", bad.project, "--workspace", workspace], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      const verbose = await runCli(ctx, ["build", "--project", bad.project, "--workspace", workspace, "--verbose"], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      const lines = untimed(failed.stderr);
      observe(ctx, "a component that does not compile", { failed, verbose }, [
        ctx.equal("exit 1, nothing on stdout", [failed.code, failed.stdout], [1, ""]),
        ctx.equal("header: the project and the default environment", lines[0], `ajs dms build  ${bad.project} · production`),
        ctx.holds("the failing step is marked and named", lines.includes("✖ Client bundle failed") && lines.includes("✖ Vite could not build the client bundle"), failed.stderr),
        ctx.holds("the error points at the component in the module with line and column, not at the workspace copy", failed.stderr.includes(`[plugin vite:vue] ${bad.component}:6:10`) && !failed.stderr.includes(`${workspace}/frontend-modules`), failed.stderr),
        ctx.holds("it says how to see everything", failed.stderr.includes("  Run with --verbose for the full Vite output.\n"), failed.stderr),
        ctx.equal("the steps after the failure did not run", lines.filter((line) => line.startsWith("✔ Built the SSR")).length, 0),
        ctx.holds("--verbose streams the step output, names the steps, and omits the hint", verbose.code === 1 && verbose.stderr.length > failed.stderr.length && !verbose.stderr.includes("Run with --verbose for the full Vite output."), verbose.stderr.slice(0, 800)),
      ]);
    },
  },
  {
    id: "build-entry-weight-default",
    title: "with no threshold set, a module that adds more than 50 KB of Brotli to the client entry is warned about and one that adds less is not",
    entryPoint: "ajs dms build --project <project> without DMS_ENTRY_WEIGHT_WARNING, for a module that adds about 70 KB and one that adds about 25 KB",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      /**
       * @param {string} name The project folder
       * @param {number} kilobytes About how much Brotli the module adds to the entry (hex text compresses to half)
       */
      const weigh = async (name, kilobytes) => {
        const entry = `import type { DmsFrontendModule } from "#dms/frontend-module";
import { blob } from "./blob";

const fixture: DmsFrontendModule = {
  setup() {
    Reflect.set(globalThis, "fxBlob", blob);
  },
};

export default fixture;
`;
        const files = { "blob.ts": `export const blob = "${randomBytes(kilobytes * 1024).toString("hex")}";\n` };
        const project = writeBuildProject(buildProjectFolder(ctx, name), { entry, files });
        const workspace = join(scratch(ctx, `ws-${name}`), "workspace");
        const run = await runCli(ctx, ["build", "--project", project.project, "--workspace", workspace], { cwd: scratch(ctx, `cwd-${name}`), home: ctx.state.home, env: { DMS_ENTRY_WEIGHT_WARNING: "" }, timeoutMs: BUILD_TIMEOUT_MS });
        return { run, lines: untimed(run.stderr) };
      };
      const heavy = await weigh("weight-heavy", 200);
      const light = await weigh("weight-light", 35);
      const warned = (/** @type {string[]} */ lines) => lines.filter((line) => line.startsWith("▲ fx-frontend adds "));
      observe(ctx, "default threshold", { heavy: heavy.run, light: light.run }, [
        ctx.equal("both builds succeed", [heavy.run.code, light.run.code], [0, 0]),
        ctx.holds("the 70 KB module is warned about, with its size", warned(heavy.lines).length === 1 && /^▲ fx-frontend adds ([5-9]\d) KB Brotli to the client entry$/.test(warned(heavy.lines)[0]), warned(heavy.lines).join("\n")),
        ctx.holds("and the threshold is named as 50 KB", heavy.lines.includes("  The threshold is 50 KB (DMS_ENTRY_WEIGHT_WARNING, in KB; 0 turns the warning off)"), heavy.run.stderr.slice(-600)),
        ctx.equal("the 25 KB module is not", warned(light.lines), []),
      ]);
    },
  },
  {
    id: "build-locale-error",
    title: "a locale message vue-i18n cannot compile stops the build with exit 1, names the file and the count, and --verbose keeps the key and the message to write instead",
    entryPoint: "ajs dms build --project <project> with a module whose en-GB catalog holds an unescaped @",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const locales = { "billing-en-GB.json": JSON.stringify({ auth: { email: { placeholder: "first.last@example.com" } }, fine: "plain text" }) };
      const bad = writeBuildProject(buildProjectFolder(ctx, "locale"), { locales });
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const failed = await runCli(ctx, ["build", "--project", bad.project, "--workspace", workspace], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      const verbose = await runCli(ctx, ["build", "--project", bad.project, "--workspace", workspace, "--verbose"], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      const lines = untimed(failed.stderr);
      const file = join(bad.project, "fx", "frontend-vue", "i18n", "locales", "billing-en-GB.json");
      observe(ctx, "an uncompilable message", { failed, verbose }, [
        ctx.equal("exit 1, nothing on stdout", [failed.code, failed.stdout], [1, ""]),
        ctx.equal("the failure names the file, the count and the compiler", lines.filter((line) => line.startsWith("✖ ")), [`✖ Invalid locale file ${file}: 1 message(s) vue-i18n cannot compile:`]),
        ctx.equal("the build did not reach the bundles", lines.filter((line) => line.startsWith("✔ Built the")).length, 0),
        ctx.holds("--verbose still names the key and the message to write instead", verbose.stderr.includes("  auth.email.placeholder: Invalid linked format in \"first.last@example.com\". Write a literal @ as {'@'}: \"first.last{'@'}example.com\"."), verbose.stderr),
        ctx.equal("the message that compiles is not named", verbose.stderr.includes("fine:"), false),
      ]);
    },
  },
  {
    id: "build-locale-error-names-the-key",
    title: "the default output of a failed locale build names the key and the message to write instead, as the page shows",
    entryPoint: "ajs dms build --project <project> with a module whose en-GB catalog holds an unescaped @",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const locales = { "billing-en-GB.json": JSON.stringify({ auth: { email: { placeholder: "first.last@example.com" } } }) };
      const bad = writeBuildProject(buildProjectFolder(ctx, "locale-key"), { locales });
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const failed = await runCli(ctx, ["build", "--project", bad.project, "--workspace", workspace], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      observe(ctx, "the default output", { failed }, [
        ctx.holds("the key and the message to write are in the output", failed.stderr.includes("auth.email.placeholder: Invalid linked format in \"first.last@example.com\". Write a literal @ as {'@'}: \"first.last{'@'}example.com\"."), failed.stderr),
      ]);
    },
  },
  {
    id: "build-access-redirect",
    title: "a page visit the backend refuses with a typed 403 goes to the path a module registered for its code, document or Inertia, and a refused destination shows the error page",
    entryPoint: "registerAccessRedirect in a built module, then GET pages the backend refuses with 403",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const entry = `import type { DmsFrontendModule } from "#dms/frontend-module";

const fixture: DmsFrontendModule = {
  setup(sdk) {
    sdk.registerAccessRedirect("fx.errors.blocked", "/elsewhere");
    sdk.registerAccessRedirect("fx.errors.blocked", "/never-used");
    sdk.registerAccessRedirect("fx.errors.away", "https://other.example.test/x");
  },
};

export default fixture;
`;
      const project = writeBuildProject(buildProjectFolder(ctx, "access"), { entry });
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const built = await runCli(ctx, ["build", "--project", project.project, "--workspace", workspace], { cwd: scratch(ctx, "cwd"), home: ctx.state.home, timeoutMs: BUILD_TIMEOUT_MS });
      /** @type {Record<string, string>} */
      const codes = { "/gated": "fx.errors.blocked", "/elsewhere": "fx.errors.blocked", "/json": JSON.stringify({ message: "fx.errors.blocked" }), "/away": "fx.errors.away", "/unregistered": "fx.errors.unknown" };
      const { handler } = fakeAuthBackend((request, response) => {
        const url = new URL(request.url ?? "/", "http://backend.local");
        const refused = url.pathname === "/dms/page" ? codes[url.searchParams.get("path") ?? ""] : undefined;
        if (refused === undefined) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(403, { "content-type": refused.startsWith("{") ? "application/json" : "text/plain" });
        response.end(refused);
      });
      const backend = await startFakeBackend(handler);
      try {
        const server = await serve(ctx, backend.url, { project: false, cwd: project.project, args: ["--workspace", workspace] });
        await whileServing(server, async () => {
          const base = server.url.replace(/\/$/, "");
          const login = await signIn({ url: base });
          const visit = (/** @type {string} */ path, /** @type {Record<string, string>} */ headers) => exchange(base, { path, headers: { ...headers, cookie: login.cookie } });
          const document = await visit("/gated", { accept: "text/html" });
          const json = await visit("/json", { accept: "text/html" });
          const inertia = await visit("/gated", { "x-inertia": "true" });
          const looped = await visit("/elsewhere", { accept: "text/html" });
          const away = await visit("/away", { accept: "text/html" });
          const awayInertia = await visit("/away", { "x-inertia": "true" });
          const unregistered = await visit("/unregistered", { accept: "text/html" });
          const api = await visit("/gated", { accept: "application/json" });
          observe(ctx, "typed refusals", { built: built.code, document: document.status, json: json.status, inertia: inertia.status, looped: looped.status, away: away.status, awayInertia: awayInertia.status, unregistered: unregistered.status }, [
            ctx.equal("the module builds", built.code, 0),
            ctx.equal("a document visit refused with a registered code is redirected before anything renders", [document.status, document.headers.location, document.text], [302, "/elsewhere", ""]),
            ctx.equal("the first registration of a code wins", document.headers.location, "/elsewhere"),
            ctx.equal("the code may come as JSON, as { message }", [json.status, json.headers.location], [302, "/elsewhere"]),
            ctx.equal("an Inertia visit gets the same redirect", [inertia.status, inertia.headers.location], [302, "/elsewhere"]),
            ctx.holds("a destination that is itself refused shows the error page, not a loop", looped.status !== 302 && looped.headers.location === undefined, `${looped.status} ${String(looped.headers.location)}`),
            ctx.equal("a destination on another origin is not followed by the server", [away.status, away.headers.location], [403, undefined]),
            ctx.equal("an Inertia visit to another origin would be a full visit, which is not offered either", awayInertia.headers["x-inertia-location"], undefined),
            ctx.equal("a code nobody registered shows the error page", [unregistered.status, unregistered.headers.location], [403, undefined]),
            ctx.equal("a request that is no page visit is not redirected", [api.status, api.headers.location], [403, undefined]),
          ]);
        });
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "build-interrupt",
    title: "Ctrl+C during a build stops it with exit code 130 and says how long it ran",
    entryPoint: "ajs dms build, interrupted with SIGINT while a step runs",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const workspace = join(scratch(ctx, "ws"), "workspace");
      const cli = startCli(ctx, ["build", "-e", "docs", "--workspace", workspace], { cwd: ctx.state.runPlayground, home: ctx.state.home });
      await cli.waitFor("Building for production", BUILD_TIMEOUT_MS);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const stopped = await cli.stop("SIGINT");
      const lines = cli.stderr().split("\n").filter(Boolean);
      observe(ctx, "interrupted", { stopped, stderr: cli.stderr() }, [
        ctx.equal("exit code 130, not killed by the signal", [stopped.code, stopped.signal], [130, null]),
        ctx.holds("the last line names the build and how long it ran", /^■ Stopped the production build · ran \d+(\.\d+)?(ms|s)$/.test(lines.at(-1) ?? ""), cli.stderr().slice(-300)),
        ctx.equal("the build did not finish", cli.stderr().includes("Built the production frontend"), false),
      ]);
    },
  },
];

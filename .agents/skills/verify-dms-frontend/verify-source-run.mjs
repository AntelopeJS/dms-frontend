import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rendererVersion, versionOf } from "./cli-json.mjs";
import { observe, runCli, scratch } from "./cli-run.mjs";
import { SYNTAX_ERROR_COMPONENT, TYPE_ERROR_COMPONENT, projectFolder, writeModule, writeProject } from "./verify-source-fixtures.mjs";
import { standalone } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const TIMEOUT_MS = 600_000;

/**
 * @param {string} text Output
 * @returns {string} Output without timings, package counts and sizes
 */
export function untimed(text) {
  return text
    .replace(/^Verified (\d+) modules · .*$/gm, "Verified $1 modules")
    .replace(/ \d+(\.\d+)?m?s$/gm, "")
    .replace(/Installed \d+ packages/g, "Installed <n> packages")
    .replace(/\d+ KB (JS|locale)/g, "<n> KB $1");
}

/**
 * @param {string} tmp A temporary directory
 * @returns {string[]} What a run left in it, Node's own compile cache aside
 */
function leftovers(tmp) {
  return readdirSync(tmp).filter((name) => name !== "node-compile-cache");
}

/**
 * @param {import("./cli-run.mjs").Context} ctx The journey
 * @returns {string | undefined} The version of the `@antelopejs/dms` the run installed
 */
function installedDms(ctx) {
  return versionOf(join(ctx.state.runPlayground, "..", "package.json"));
}

/**
 * @param {import("./cli-run.mjs").Context} ctx The journey
 * @param {string} cwd Where to run
 * @param {string[]} args Arguments after `verify-source`
 * @param {Record<string, string | undefined>} [env] More variables
 * @returns {Promise<import("./cli-run.mjs").CliResult & { tmp: string }>} The run and the temporary directory it used
 */
async function verify(ctx, cwd, args, env = {}) {
  const tmp = scratch(ctx, `tmp-${ctx.steps.length}-${Math.random().toString(16).slice(2, 8)}`);
  const result = await runCli(ctx, ["verify-source", ...args], { cwd, home: ctx.state.home, env: { TMPDIR: tmp, ...env }, timeoutMs: TIMEOUT_MS });
  return { ...result, tmp };
}

export const journeys = [
  {
    id: "verify-source-usage",
    title: "verify-source refuses what it cannot verify before it installs anything: a core layer that is not one, no @antelopejs/dms, bad paths, an excluded release",
    entryPoint: "ajs dms verify-source with --layer, -m, --local-package and a module whose engines exclude this release",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const good = writeProject(projectFolder(ctx, "usage-ok"));
      const excluded = writeProject(projectFolder(ctx, "usage-engines"), { engines: ">=0.5.0 <0.6.0" });
      const empty = scratch(ctx, "no-dms");
      mkdirSync(projectFolder(ctx, "usage-none"), { recursive: true });
      const cases = {
        layer: await verify(ctx, good.project, ["--layer", good.module]),
        layerShort: await verify(ctx, good.project, ["-l", good.module]),
        notInstalled: await verify(ctx, empty, ["-m", good.module]),
        missingPath: await verify(ctx, good.project, ["-m", join(empty, "nonexistent")]),
        noPackage: await verify(ctx, good.project, ["-m", empty]),
        noModule: await verify(ctx, projectFolder(ctx, "usage-none"), []),
        excludedFromProject: await verify(ctx, excluded.project, []),
        excludedFromModule: await verify(ctx, excluded.module, []),
        excludedExplicit: await verify(ctx, excluded.project, ["-m", excluded.module]),
        localPackageMalformed: await verify(ctx, good.project, ["-m", good.module, "--local-package", "no-equals-sign"]),
      };
      const release = rendererVersion(ctx);
      const excludedText = `✖ These frontend modules do not run on @antelopejs/dms-frontend ${release}\n  fx-frontend-vue (@PATH@) supports >=0.5.0 <0.6.0\n  → Install a @antelopejs/dms-frontend release in their ranges, or upgrade the modules\n`;
      const header = `ajs dms verify-source  2 modules\nℹ Verifying against @antelopejs/dms ${installedDms(ctx)} (installed in this project)\n`;
      const layerText = "✖ ./frontend-vue is not the DMS core layer\n  --layer is for verifying an unpublished DMS core layer, @antelopejs/dms-frontend-vue, and ./frontend-vue holds fx-frontend-vue. Without it, frontend modules are verified on the core layer of the @antelopejs/dms installed in the project.\n  → Drop -l and pass the folder with -m: ajs dms verify-source -m ./frontend-vue\n";
      observe(ctx, "refusals", cases, [
        ctx.equal("--layer on a module that is not the core layer: exit 2 and the command that verifies it with -m", [cases.layer.code, cases.layer.stdout, cases.layer.stderr], [2, "", layerText]),
        ctx.equal("-l is --layer", [cases.layerShort.code, cases.layerShort.stderr], [2, layerText]),
        ctx.equal("no @antelopejs/dms from the working directory: exit 2 and the command that adds it", [cases.notInstalled.code, cases.notInstalled.stderr], [2, "✖ @antelopejs/dms is not installed in this project\n  Frontend modules are verified on top of the DMS core layer that @antelopejs/dms ships, and Node finds no @antelopejs/dms from the current directory.\n  → Add it as a development dependency: pnpm add -D @antelopejs/dms\n"]),
        ctx.equal("a module path that does not exist", [cases.missingPath.code, cases.missingPath.stderr], [2, `✖ Module path not found: ${join(empty, "nonexistent")}\n  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)\n`]),
        ctx.equal("a project with neither ./dms.frontend.ts nor ./frontend-vue/dms.frontend.ts: exit 2 and what to do", [cases.noModule.code, cases.noModule.stderr], [2, "✖ No frontend module to verify\n  Neither . nor its frontend-vue directory contains dms.frontend.ts.\n  → Run the command from the frontend module, or pass its root with -m\n"]),
        ctx.equal("a folder with no package.json", [cases.noPackage.code, cases.noPackage.stderr], [2, `✖ No package.json in ${empty}\n  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)\n`]),
        ctx.equal("without -m the project's ./frontend-vue is the module; the range check runs before anything is installed", [cases.excludedFromProject.code, cases.excludedFromProject.stdout, cases.excludedFromProject.stderr], [1, "", header + excludedText.replace("@PATH@", "./frontend-vue")]),
        ctx.equal("without -m, the working directory is the module when it holds dms.frontend.ts", [cases.excludedFromModule.code, cases.excludedFromModule.stderr], [1, header + excludedText.replace("@PATH@", ".")]),
        ctx.equal("-m names the module", [cases.excludedExplicit.code, cases.excludedExplicit.stderr], [1, header + excludedText.replace("@PATH@", "./frontend-vue")]),
        ctx.equal("a refused run leaves the temporary directory empty", Object.values(cases).map((entry) => leftovers(entry.tmp)), Object.values(cases).map(() => [])),
        ctx.holds("--local-package without name=path is a usage error", cases.localPackageMalformed.code === 2 && cases.localPackageMalformed.stderr.startsWith("✖ "), cases.localPackageMalformed.stderr),
      ]);
    },
  },
  {
    id: "verify-source-pass",
    title: "verify-source builds and type-checks a module on the core layer without a backend: every step in the page's output, exit 0, no temporary workspace left",
    entryPoint: "ajs dms verify-source from a project folder holding frontend-vue",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const fixture = writeProject(projectFolder(ctx, "pass"));
      const run = await verify(ctx, fixture.project, []);
      const lines = untimed(run.stderr).split("\n");
      const tasks = lines.filter((line) => line.startsWith("✔ "));
      observe(ctx, "a run", run, [
        ctx.equal("exit 0, nothing on stdout", [run.code, run.stdout], [0, ""]),
        ctx.equal("the header counts the core layer and the module", lines[0], "ajs dms verify-source  2 modules"),
        ctx.equal("the core layer comes from the installed @antelopejs/dms", lines[1], `ℹ Verifying against @antelopejs/dms ${installedDms(ctx)} (installed in this project)`),
        ctx.equal("the steps the page lists, each once", tasks.sort(), [
          "✔ Built the SSR bundle",
          "✔ Built the client bundle",
          "✔ Built the e-mail bundle",
          "✔ Built the server modules",
          "✔ Client bundle checked",
          "✔ E-mail contracts hold · 8 templates · <n> KB JS (limit 256 KB) · <n> KB locale data",
          "✔ Generated the type declarations",
          "✔ Installed <n> packages",
          "✔ Materialized 2 modules",
          "✔ 1 server module, <n> KB JS",
          "✔ Type check passed",
        ].sort()),
        ctx.equal("the last line", lines.filter(Boolean).at(-1), "Verified 2 modules"),
        ctx.equal("no failure and no ✖ line", run.stderr.includes("✖"), false),
        ctx.equal("the temporary workspace is removed when the run ends", leftovers(run.tmp), []),
        ctx.equal("the module's folder is left as it was", readdirSync(fixture.module).sort(), ["app", "dms.frontend.ts", "package.json"]),
      ]);
      const email = /E-mail contracts hold · 8 templates · (\d+) KB JS \(limit 256 KB\)/.exec(run.stderr);
      await ctx.verify("the e-mail bundle stays under its 256 KB limit", [ctx.holds("JS size under the limit", email !== null && Number(email[1]) < 256, email?.[0] ?? run.stderr.slice(-300))]);
    },
  },
  {
    id: "verify-source-failures",
    title: "verify-source stops with exit 1 on a type error, a template that does not compile, or a server module that imports application code, and points at the file in the module",
    entryPoint: "ajs dms verify-source -m <module> with a faulty module, with and without --verbose",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const typed = writeProject(projectFolder(ctx, "type"), { component: TYPE_ERROR_COMPONENT });
      const syntax = writeProject(projectFolder(ctx, "syntax"), { component: SYNTAX_ERROR_COMPONENT });
      const server = writeProject(projectFolder(ctx, "server"), { files: { "dms.server.ts": 'import fixture from "./dms.frontend";\nexport default { fixture };\n' } });
      const type = await verify(ctx, typed.project, []);
      const verbose = await verify(ctx, typed.project, ["--verbose"]);
      const compile = await verify(ctx, syntax.project, []);
      const guard = await verify(ctx, server.project, []);
      observe(ctx, "a type error", { type, verbose }, [
        ctx.equal("exit 1, nothing on stdout", [type.code, type.stdout], [1, ""]),
        ctx.holds("the failure names the file of the module you passed, with line and column, not its copy in the workspace", /✖ [^\n]*\.\/frontend-vue\/app\/components\/Callout\.vue:2:\d+/.test(type.stderr) && !type.stderr.includes(".dms-frontend") && !type.stderr.includes(type.tmp), type.stderr),
        ctx.holds("it says what is wrong", type.stderr.includes("not a number") || type.stderr.includes("string"), type.stderr),
        ctx.equal("it does not print the success summary", type.stderr.includes("Verified"), false),
        ctx.equal("the temporary workspace is removed after a failure too", leftovers(type.tmp), []),
        ctx.holds("--verbose streams the output of the steps, and the failure", verbose.code === 1 && verbose.stderr.length > type.stderr.length && /Callout\.vue/.test(verbose.stderr), verbose.stderr.slice(0, 600)),
      ]);
      observe(ctx, "a template that does not compile", compile, [
        ctx.equal("exit 1", compile.code, 1),
        ctx.holds("the failure names the component of the module", compile.stderr.includes("./frontend-vue/app/components/Callout.vue") && !compile.stderr.includes(compile.tmp), compile.stderr),
        ctx.equal("the temporary workspace is removed", leftovers(compile.tmp), []),
      ]);
      observe(ctx, "a server module that imports application code", guard, [
        ctx.equal("exit 1, no success summary", [guard.code, guard.stderr.includes("Verified")], [1, false]),
        ctx.holds("the failure names the server module or the component it imports", /dms\.server\.ts|Callout\.vue/.test(guard.stderr), guard.stderr),
      ]);
    },
  },
  {
    id: "verify-source-local-package",
    title: "--local-package binds a local build of a package into the workspace, and -m can be repeated",
    entryPoint: "ajs dms verify-source -m <a> -m <b> --local-package fx-lib=<dir>",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const root = join(projectFolder(ctx, "local"), "..", "local-package");
      mkdirSync(join(root, "lib"), { recursive: true });
      writeFileSync(join(root, "lib", "package.json"), JSON.stringify({ name: "fx-lib", version: "1.0.0", type: "module", main: "index.js", types: "index.d.ts" }));
      writeFileSync(join(root, "lib", "index.js"), "export const greet = () => 'hello';\n");
      writeFileSync(join(root, "lib", "index.d.ts"), "export declare const greet: () => string;\n");
      const project = projectFolder(ctx, "local");
      writeModule(join(project, "first"), { name: "first-frontend-vue" });
      writeModule(join(project, "second"), {
        name: "second-frontend-vue",
        dependencies: { "fx-lib": "1.0.0" },
        component: '<script setup lang="ts">\nimport { greet } from "fx-lib";\nconst text: string = greet();\n</script>\n\n<template>\n  <aside>{{ text }}</aside>\n</template>\n',
      });
      const unbound = await verify(ctx, project, ["-m", "./first", "-m", "./second"]);
      const bound = await verify(ctx, project, ["-m", "./first", "-m", "./second", "--local-package", `fx-lib=${join(root, "lib")}`]);
      observe(ctx, "binding", { unbound, bound }, [
        ctx.holds("without the binding, fx-lib is looked up in the registry and the run fails", unbound.code === 1 && unbound.stderr.includes("fx-lib"), unbound.stderr),
        ctx.equal("-m twice verifies both, with the core layer: 3 modules", bound.stderr.split("\n")[0], "ajs dms verify-source  3 modules"),
        ctx.equal("with the binding it passes", [bound.code, bound.stderr.includes("Materialized 3 modules")], [0, true]),
      ]);
    },
  },
  {
    id: "verify-source-email-limit",
    title: "verify-source keeps the e-mail bundle under 256 KiB of JavaScript: a module that stays under passes and one that goes over fails naming the size and the limit",
    entryPoint: "ajs dms verify-source -m <module> with a dms.email.ts that carries about 90 KB and about 140 KB of JavaScript",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      /**
       * @param {string} name The project folder
       * @param {number} kilobytes About how much JavaScript the e-mail template adds
       */
      const withEmail = (name, kilobytes) =>
        writeProject(projectFolder(ctx, name), {
          files: {
            "dms.email.ts": 'export const serverEmailTemplates = { Heavy: () => import("./emails/Heavy.vue") };\n',
            "emails/Heavy.vue": '<script setup lang="ts">\nimport { text } from "./heavy";\n</script>\n\n<template>\n  <EBody>{{ text }}</EBody>\n</template>\n',
            "emails/heavy.ts": `export const text = ${JSON.stringify("x".repeat(kilobytes * 1024))};\n`,
          },
        });
      const under = await verify(ctx, withEmail("email-under", 90).project, []);
      const over = await verify(ctx, withEmail("email-over", 140).project, []);
      const size = /E-mail contracts hold · \d+ templates · (\d+) KB JS \(limit 256 KB\)/.exec(under.stderr);
      const overSize = /✖ The e-mail bundle is (\d+) KB of JavaScript\n {2}The limit is 256 KB\./.exec(over.stderr);
      await ctx.verify("a bundle under the limit passes and reports its size", [
        ctx.equal("exit 0", under.code, 0),
        ctx.holds("the size is between 200 KB and 256 KB", size !== null && Number(size[1]) > 200 && Number(size[1]) < 256, size?.[0] ?? under.stderr.slice(-300)),
      ]);
      await ctx.verify("a bundle over the limit fails with its size and the limit", [
        ctx.equal("exit 1", over.code, 1),
        ctx.holds("the failure names a size above 256 KB and the limit", overSize !== null && Number(overSize[1]) > 256, over.stderr.slice(-400)),
        ctx.equal("no success summary", over.stderr.includes("Verified"), false),
      ]);
    },
  },
];

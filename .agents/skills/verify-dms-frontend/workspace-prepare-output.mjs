import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { at, isText, keysOf, listAt, textAt } from "./json.mjs";
import { listedWorkspaces, readJson, rendererVersion } from "./cli-json.mjs";
import { startCliBackend } from "./cli-backend.mjs";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { observe, runCli, scratch } from "./cli-run.mjs";
import { META_FILE, sha256, workspacesRoot, writeModule } from "./workspace-fixtures.mjs";
import { standalone } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const SKIPPED_HINT = "  prepare never fails an install; add --strict to make this an error.\n";
export const NOT_GENERATED = "  The types and the module registry were not generated.\n";

/**
 * @param {string} path A file or directory
 * @returns {string} Its permission bits, octal
 */
function mode(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

/**
 * @param {string} home The home directory
 * @param {string} url A backend url
 * @returns {string} The workspace directory for it
 */
export function workspaceFor(home, url) {
  return join(workspacesRoot(home), sha256(url));
}

export const journeys = [
  {
    id: "prepare-workspace",
    title: "prepare against a backend writes a 0700 workspace keyed on the canonical url, a 0600 manifest cache, and reinstalls only with --force",
    entryPoint: "ajs dms prepare -b <url> against a backend of the journey's own",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const backend = await startCliBackend();
      try {
        const url = backend.url;
        const dir = workspaceFor(home, url);
        const first = await runCli(ctx, ["prepare", "-b", url], { home });
        const lines = first.stderr.split("\n");
        const requests = backend.to("/dms/frontend");
        const meta = readJson(join(dir, META_FILE));
        const cache = readJson(join(dir, ".manifest-cache.json"));
        observe(ctx, "a first prepare", { first, requests }, [
          ctx.equal("exit 0, nothing on stdout", [first.code, first.stdout], [0, ""]),
          ctx.equal("the header names the command and the backend", lines[0], `ajs dms prepare  ${url}`),
          ctx.equal("the tasks", [lines[1], /^✔ Installed \d+ packages \d/.test(lines[2])], ["✔ Workspace generated", true]),
          ctx.holds("the summary: 0 modules, the types and registry, the duration", /^✔ Prepared the workspace · 0 modules · types and registry written · \d/.test(lines[3]), lines[3]),
          ctx.equal("the workspace path is the last line", lines[4], `  ~/.antelopejs/dms-frontend/${sha256(url)}`),
          ctx.equal("the backend saw one manifest request for the vue renderer, 3, without credential", [requests.length, requests[0]?.url, requests[0]?.headers["x-dms-bootstrap"]], [1, "/dms/frontend?renderer=vue&rendererVersion=3", undefined]),
          ctx.equal("the workspace directory is owner-only", mode(dir), "700"),
          ctx.equal("the metadata records the canonical url as key", [textAt(meta, "backendUrl"), textAt(meta, "workspaceKey"), Math.abs(Date.parse(textAt(meta, "updatedAt") ?? "") - Date.now()) < 120_000], [url, url, true]),
          ctx.equal("the manifest cache is owner-only and holds the manifest as served", [mode(join(dir, ".manifest-cache.json")), at(cache, "manifest"), isText(at(cache, "fetchedAt"))], ["600", { modules: [] }, true]),
          ctx.equal("the registry and the generated options exist, the options holding no private value", [existsSync(join(dir, "frontend-modules.generated.ts")), at(readJson(join(dir, "generated-server-options.json")), "modules"), mode(join(dir, "generated-server-options.json"))], [true, {}, "644"]),
        ]);

        const listing = listedWorkspaces((await runCli(ctx, ["workspaces", "--json"], { home })).stdout);
        const again = await runCli(ctx, ["prepare", "-b", url], { home });
        const forced = await runCli(ctx, ["prepare", "-b", url, "--force"], { home });
        const listingAfter = listedWorkspaces((await runCli(ctx, ["workspaces", "--json"], { home })).stdout);
        observe(ctx, "the same workspace again", { listing, again, forced }, [
          ctx.equal("workspaces lists it, keyed on the url", listing.map((entry) => [entry.backendUrl, entry.key, entry.dir]), [[url, { type: "url" }, dir]]),
          ctx.equal("a second run installs nothing", [again.code, again.stderr.includes("Installed"), again.stderr.split("\n")[1]], [0, false, "✔ Workspace ready"]),
          ctx.equal("one workspace after three runs", listingAfter.length, 1),
          ctx.equal("--force runs the install again, which finds nothing to change", [forced.code, forced.stderr.split("\n")[2].replace(/ [\d.]+m?s$/, "")], [0, "✔ Dependencies up to date"]),
          ctx.equal("one manifest request per run: 3 runs", backend.to("/dms/frontend").length, 3),
        ]);

        const secretRuns = {
          flag: await runCli(ctx, ["prepare", "-b", url, "--bootstrap-secret", "from-flag"], { home }),
          env: await runCli(ctx, ["prepare", "-b", url], { home, env: { DMS_BOOTSTRAP_SECRET: "from-env" } }),
          both: await runCli(ctx, ["prepare", "-b", url, "--bootstrap-secret", "from-flag"], { home, env: { DMS_BOOTSTRAP_SECRET: "from-env" } }),
        };
        const sent = backend.to("/dms/frontend").slice(3).map((request) => request.headers["x-dms-bootstrap"]);
        const before = backend.to("/dms/frontend").length;
        const spaced = await runCli(ctx, ["prepare", "-b", url, "--bootstrap-secret", "has space"], { home });
        const spacedStrict = await runCli(ctx, ["prepare", "-b", url, "--strict", "--bootstrap-secret", "has space"], { home });
        const accented = await runCli(ctx, ["prepare", "-b", url, "--strict"], { home, env: { DMS_BOOTSTRAP_SECRET: "café" } });
        observe(ctx, "the bootstrap credential", { secretRuns, spaced, spacedStrict, accented }, [
          ctx.equal("sent as x-dms-bootstrap from --bootstrap-secret, from DMS_BOOTSTRAP_SECRET, the flag winning", sent, ["from-flag", "from-env", "from-flag"]),
          ctx.equal("a credential with a space is refused before any request", [backend.to("/dms/frontend").length, spaced.code], [before, 0]),
          ctx.equal("non-strict reports it as a failure on stderr", spaced.stderr.includes("▲ Prepare failed: The bootstrap credential cannot travel in an HTTP header\n"), true),
          ctx.equal("strict: exit 2, the title, the cause and the fix", [spacedStrict.code, spacedStrict.stderr.split("\n").slice(-4, -1)], [2, ["✖ The bootstrap credential cannot travel in an HTTP header", "  DMS_BOOTSTRAP_SECRET contains a space.", "  → Use printable ASCII characters only, without spaces or line breaks"]]),
          ctx.equal("a non-ASCII character is named", [accented.code, accented.stderr.includes("DMS_BOOTSTRAP_SECRET contains a non-ASCII character.")], [2, true]),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
  {
    id: "prepare-private-options",
    title: "a module's lifecycle scripts are stripped from its copy, and generated-server-options.json is 0600 only while it holds a private value",
    entryPoint: "ajs dms prepare -b <url> against a manifest listing a module with private options",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const moduleDir = join(scratch(ctx, "module"), "mod");
      const scripts = { preinstall: "echo a", install: "echo b", postinstall: "echo c", prepare: "echo d", prepublishOnly: "echo e", build: "echo build", test: "echo test" };
      const served = writeModule(moduleDir, { engines: ">=0.10.0 <0.11.0", scripts, privateOptions: { apiKey: "sekret" } });
      const backend = await startCliBackend({ modules: [served] });
      try {
        const dir = workspaceFor(home, backend.url);
        const optionsFile = join(dir, "generated-server-options.json");
        const filled = await runCli(ctx, ["prepare", "-b", backend.url, "--strict"], { home });
        const copy = readdirSync(join(dir, "frontend-modules")).map((name) => join(dir, "frontend-modules", name, "package.json")).find((file) => existsSync(file));
        const copied = copy ? readJson(copy) : undefined;
        observe(ctx, "a module with a private value", { filled, copied }, [
          ctx.equal("prepared, with the module counted", [filled.code, /· 1 module · types and registry written/.test(filled.stderr)], [0, true]),
          ctx.equal("owner-only options file holding the value", [mode(optionsFile), at(readJson(optionsFile), "modules")], ["600", { "fixture__mod-frontend-vue": { apiKey: "sekret" } }]),
          ctx.equal("the manifest cache keeps the private options as served", at(listAt(readJson(join(dir, ".manifest-cache.json")), "manifest", "modules")[0], "privateOptions"), { apiKey: "sekret" }),
          ctx.equal("the copy keeps custom scripts and drops the lifecycle ones", keysOf(at(copied, "scripts")).sort(), ["build", "prepublishOnly", "test"]),
          ctx.equal("the module's own directory is not touched", keysOf(at(readJson(join(moduleDir, "package.json")), "scripts")).sort(), Object.keys(scripts).sort()),
        ]);

        backend.behaviour.manifest.body = { version: 2, modules: [{ ...served, privateOptions: { apiKey: "" } }] };
        const emptied = await runCli(ctx, ["prepare", "-b", backend.url, "--strict"], { home });
        observe(ctx, "the same private option emptied", { emptied }, [
          ctx.equal("the file is rewritten shareable (0644): its old copy's mode is not kept", [emptied.code, mode(optionsFile), at(readJson(optionsFile), "modules")], [0, "644", { "fixture__mod-frontend-vue": { apiKey: "" } }]),
          ctx.equal("the manifest cache is still owner-only", mode(join(dir, ".manifest-cache.json")), "600"),
        ]);

        backend.behaviour.manifest.body = { version: 2, modules: [{ ...served, privateOptions: { nested: { apiKey: "", token: "deep" } } }] };
        const nested = await runCli(ctx, ["prepare", "-b", backend.url, "--strict"], { home });
        observe(ctx, "a private value nested in an object", { nested }, [ctx.equal("counts as a value: 0600", [nested.code, mode(optionsFile)], [0, "600"])]);

        const undeclared = writeModule(join(scratch(ctx, "module-b"), "mod"), { name: "@fixture/b" });
        backend.behaviour.manifest.body = { version: 2, modules: [undeclared] };
        const noRange = await runCli(ctx, ["prepare", "-b", backend.url], { home });
        const excluded = writeModule(join(scratch(ctx, "module-c"), "mod"), { name: "@fixture/c", engines: ">=0.5.0 <0.6.0" });
        backend.behaviour.manifest.body = { version: 2, modules: [excluded] };
        const refused = await runCli(ctx, ["prepare", "-b", backend.url, "--strict"], { home });
        const refusedLenient = await runCli(ctx, ["prepare", "-b", backend.url], { home });
        const unreadableModule = writeModule(join(scratch(ctx, "module-d"), "mod"), { name: "@fixture/d", engines: "not a range" });
        backend.behaviour.manifest.body = { version: 2, modules: [unreadableModule] };
        const unreadable = await runCli(ctx, ["prepare", "-b", backend.url, "--strict"], { home });
        const troubleshooting = docsPage(ctx, "9.troubleshooting.md");
        const release = rendererVersion(ctx);
        observe(ctx, "supported range", { noRange, refused, refusedLenient, unreadable }, [
          ctx.holds("a range that is not valid semver is named as unreadable, with its value, and refused", unreadable.code === 1 && unreadable.stderr.includes(`✖ These frontend modules do not run on @antelopejs/dms-frontend ${release}\n  @fixture/d-frontend-vue (`) && unreadable.stderr.includes('declares an unreadable range: "not a range"\n  → Install a @antelopejs/dms-frontend release in their ranges, or upgrade the modules\n') && !unreadable.stderr.includes("supports "), unreadable.stderr),
          ctx.holds("a module without a declared range is only warned about", noRange.code === 0 && noRange.stderr.includes(`▲ No supported @antelopejs/dms-frontend range declared, so not checked against ${release}\n  @fixture/b-frontend-vue (`) && noRange.stderr.includes('  → Declare one in its package.json, under engines["@antelopejs/dms-frontend"]\n'), noRange.stderr),
          ctx.holds("a module whose range excludes this release is refused before install", refused.code === 1 && refused.stderr.includes(`✖ These frontend modules do not run on @antelopejs/dms-frontend ${release}\n  @fixture/c-frontend-vue (`) && refused.stderr.includes("supports >=0.5.0 <0.6.0\n  → Install a @antelopejs/dms-frontend release in their ranges, or upgrade the modules\n") && !refused.stderr.includes("Installed"), refused.stderr),
          ctx.equal("without --strict the same refusal is a failure that exits 0", [refusedLenient.code, refusedLenient.stderr.includes(`▲ Prepare failed: These frontend modules do not run on @antelopejs/dms-frontend ${release}`)], [0, true]),
          ctx.holds("the troubleshooting page words it the same way", (exampleOutput(troubleshooting, "x") ?? "") === "" && troubleshooting.includes("→ Install a @antelopejs/dms-frontend release in their ranges, or upgrade the modules"), "page"),
        ]);
      } finally {
        await backend.close();
      }
    },
  },
];

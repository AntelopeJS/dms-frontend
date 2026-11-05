import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { textAt } from "./json.mjs";
import { exchange } from "./proxy-http.mjs";
import { observe } from "./proxy-satellite.mjs";
import { startDev } from "./routing-dev.mjs";

/**
 * @param {string} path A path
 * @returns {string} Its permission bits in octal
 */
function modeOf(path) {
  return (statSync(path).mode & 0o777).toString(8);
}

export const journeys = [
  {
    id: "static-files-dev",
    title: "the development server hides the generated secrets and the modules' server code, listens on loopback, links the entry stylesheet first and answers a Vite error with 500",
    entryPoint: "requests to `ajs dms dev` against the run's backend, started under umask 022",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const root = join(ctx.state.home, ".antelopejs", "dms-frontend");
      if (existsSync(root)) execFileSync("chmod", ["-R", "a+rwX", root]);
      const server = await startDev(ctx, {}, "umask 022");
      const broken = join(server.workspace, "broken-verify.ts");
      try {
        const modules = readdirSync(join(server.workspace, "frontend-modules"));
        const playground = modules.find((name) => name === "playground-frontend");
        const get = (/** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}) => exchange(server.url, { path, headers: { accept: "text/html", ...headers }, timeoutMs: 60_000 });
        observe(ctx, "owner-only files", { modes: { workspace: modeOf(server.workspace), options: modeOf(join(server.workspace, "generated-server-options.json")), cache: modeOf(join(server.workspace, ".manifest-cache.json")) } }, [
          ctx.equal("the workspace can be opened only by its owner, under umask 022", modeOf(server.workspace), "700"),
          ctx.equal("the generated private options can be read only by their owner", modeOf(join(server.workspace, "generated-server-options.json")), "600"),
          ctx.equal("so can the manifest cache", modeOf(join(server.workspace, ".manifest-cache.json")), "600"),
        ]);

        const secretPaths = [
          "/generated-server-options.json",
          "/.manifest-cache.json",
          "/generated-server-options.json?raw",
          "/generated-server-options.json?url",
          "/generated-server-options.json?import&raw",
          "/.manifest-cache.json?import&raw",
          "/%67enerated-server-options.json",
          `/@fs${server.workspace}/generated-server-options.json`,
          `/@fs${server.workspace}/.manifest-cache.json?raw`,
          "/@id/generated-server-options.json",
          `/frontend-modules/${playground}/dms.server.ts`,
          `/frontend-modules/${playground}/dms.server.ts?raw`,
          `/frontend-modules/${playground}/server/docs-fixtures/helio.ts`,
          `/frontend-modules/${playground}/server/docs-fixtures/helio.ts?import&raw`,
        ];
        /** @type {{ path: string, status: number, type: string | string[] | undefined, text: string }[]} */
        const denied = [];
        for (const path of secretPaths) {
          const answer = await get(path);
          denied.push({ path, status: answer.status, type: answer.headers["content-type"], text: answer.text });
        }
        const open = [await get("/main.ts"), await get(`/frontend-modules/${playground}/dms.frontend.ts`)];
        observe(ctx, "private files answer 403", { denied, open: open.map((answer) => answer.status) }, [
          ctx.equal("each private file, in every spelling, answers 403 Forbidden as plain text", denied.map((entry) => [entry.status, entry.type, entry.text]), secretPaths.map(() => [403, "text/plain; charset=utf-8", "Forbidden"])),
          ctx.equal("the entry and a module's frontend entry are served", open.map((answer) => answer.status), [200, 200]),
          ctx.holds("no answer carries the secrets", denied.every((entry) => !ctx.state.secrets.DMS_HTML_RENDER_SECRET || !entry.text.includes(ctx.state.secrets.DMS_HTML_RENDER_SECRET)), "checked"),
        ]);

        const address = Object.values(networkInterfaces()).flat().find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
        const external = address ? await exchange(`http://${address}:${server.port}`, { path: "/main.ts", timeoutMs: 3000 }).then((answer) => answer.status, (/** @type {unknown} */ error) => textAt(error, "code") ?? String(error)) : "no address";
        observe(ctx, "dev listens on 127.0.0.1", { address, external }, [
          ctx.holds("the machine has an external address to test with", Boolean(address), address),
          ctx.equal("it refuses connections on it", external, "ECONNREFUSED"),
          ctx.holds("the ready block has no Network line", !server.log().includes("Network:"), server.log().split("\n").find((line) => line.includes("Network:")) ?? "none"),
        ]);

        const document = await get("/auth");
        const tags = [...document.text.matchAll(/<(?:link|style)[^>]*data-dms-dev-style="([^"]*)"[^>]*>/g)];
        observe(ctx, "the development document carries its styles", { tags: tags.map((tag) => tag[0].slice(0, 160)), status: document.status }, [
          ctx.holds("the document has style tags", tags.length > 1, tags.length),
          ctx.holds("the generated entry stylesheet comes first", tags[0]?.[1].endsWith("/dms-main.css") === true && tags[0][0].includes("<link") && tags[0][0].includes("dms-main.css?direct"), tags[0]?.[0]?.slice(0, 200)),
        ]);

        writeFileSync(broken, "export const broken = ;\n");
        const failure = await get("/broken-verify.ts");
        observe(ctx, "a Vite error", { status: failure.status, type: failure.headers["content-type"], text: failure.text.slice(0, 400) }, [
          ctx.equal("a file Vite cannot transform answers 500 with the error as plain text", [failure.status, failure.headers["content-type"]], [500, "text/plain; charset=utf-8"]),
          ctx.holds("the body names the file", failure.text.includes("broken-verify"), failure.text.slice(0, 200)),
        ]);
      } finally {
        rmSync(broken, { force: true });
        await server.stop();
      }
    },
  },
];

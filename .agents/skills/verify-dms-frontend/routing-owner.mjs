import { exchange } from "./proxy-http.mjs";
import { observe } from "./proxy-satellite.mjs";
import { startDev } from "./routing-dev.mjs";

const OWNER = "x-dms-route-owner";

export const journeys = [
  {
    id: "routing-owner",
    title: "in development every answer names its owner in x-dms-route-owner; production names none",
    entryPoint: "requests to `ajs dms dev` against the run's backend, and to the run's `ajs dms start`",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const server = await startDev(ctx);
      try {
        const cases = [
          ["a Vite URL", "GET", "/@vite/client", "renderer"],
          ["a source file of the workspace", "GET", "/main.ts", "renderer"],
          ["a module route of the playground", "GET", "/docs-fixtures/helio", "module:playground-frontend"],
          ["a module route of the DMS", "GET", "/api/_auth/session", "module:antelopejs__dms-frontend-vue"],
          ["an API path", "GET", "/api/onboarding/informations", "backend:/api/**"],
          ["a dms path", "GET", "/dms/frontend/ready", "backend:/dms/**"],
          ["a signed file URL", "GET", "/file-storage/files/x", "backend:/file-storage/files/**"],
          ["an upload URL", "PUT", "/file-storage/upload/x", "backend:/file-storage/upload/**"],
          ["a page", "GET", "/auth", "page"],
          ["a missing page", "GET", "/no/such/page", "page"],
          ["a method a page does not take", "POST", "/auth", "not-found"],
          ["a method no module route declares", "OPTIONS", "/docs-fixtures/helio", "module:playground-frontend"],
        ];
        /** @type {{ label: string, method: string, path: string, expected: string, got: string | string[] | null, status: number }[]} */
        const rows = [];
        for (const [label, method, path, owner] of cases) {
          const answer = await exchange(server.url, { method, path, headers: { origin: server.url, accept: "text/html" }, timeoutMs: 60_000 });
          rows.push({ label, method, path, expected: owner, got: answer.headers[OWNER] ?? null, status: answer.status });
        }
        observe(ctx, "dev: x-dms-route-owner", rows, rows.map((row) => ctx.equal(`${row.label}: ${row.method} ${row.path}`, row.got, row.expected)));
      } finally {
        await server.stop();
      }
      /** @type {(string | string[] | null)[]} */
      const production = [];
      for (const path of ["/docs-fixtures/helio", "/api/onboarding/informations", "/auth", "/assets/none.js"]) {
        const answer = await exchange(ctx.state.webUrl, { path, headers: { accept: "text/html" } });
        production.push(answer.headers[OWNER] ?? null);
      }
      observe(ctx, "production: no x-dms-route-owner", production, [ctx.equal("the header is absent from every answer", production, [null, null, null, null])]);
    },
  },
];

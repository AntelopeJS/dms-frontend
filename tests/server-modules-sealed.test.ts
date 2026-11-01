import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isNumber } from "../src/internal/guards";
import { isPlainObject } from "../src/internal/plain-object";
import { defineDmsServer } from "../templates/vue/server-module";
import { responseJson } from "./helpers/json";

interface Flow {
  kind: "flow";
  step: number;
}

function isFlow(value: unknown): value is Flow {
  return isPlainObject(value) && value.kind === "flow" && isNumber(value.step);
}

describe("Sealed cookies read through a guard", () => {
  it("hand the module only a value its guard accepts", async () => {
    process.env.DMS_SESSION_SECRET ??=
      "a-test-only-session-secret-of-32-characters";
    const { serveModuleRoutes } =
      await import("../templates/vue/server/module-testing.mjs");
    const seen: unknown[] = [];
    const served = await serveModuleRoutes([
      {
        id: "shop",
        setup: defineDmsServer((server) => {
          server.registerRoute("GET", "/api/_shop/write/:kind", (event) => {
            event.cookies.writeSealed("flow", {
              kind: event.params.kind,
              step: 2,
            });
            return null;
          });
          server.registerRoute("GET", "/api/_shop/read", (event) => ({
            value: event.cookies.readSealed("flow", isFlow) ?? null,
          }));
          server.registerRoute("GET", "/api/_shop/inspect", (event) => {
            event.cookies.readSealed("flow", (value): value is never => {
              seen.push(value);
              return false;
            });
            return null;
          });
        }),
      },
    ]);
    const call = async (path: string, cookie = "") => {
      const response = await fetch(`${served.url}${path}`, {
        headers: cookie ? { cookie } : {},
      });
      return {
        cookie: response.headers.getSetCookie()[0]?.split(";", 1)[0] ?? "",
        body: response.status === 200 ? await responseJson(response) : null,
      };
    };
    try {
      const flow = await call("/api/_shop/write/flow");
      assert.deepEqual((await call("/api/_shop/read", flow.cookie)).body, {
        value: { kind: "flow", step: 2 },
      });

      const other = await call("/api/_shop/write/other");
      assert.deepEqual((await call("/api/_shop/read", other.cookie)).body, {
        value: null,
      });

      await call("/api/_shop/inspect", flow.cookie);
      assert.deepEqual(seen.splice(0), [{ kind: "flow", step: 2 }]);

      assert.deepEqual((await call("/api/_shop/read")).body, { value: null });
      await call("/api/_shop/inspect");
      await call("/api/_shop/inspect", `${flow.cookie.slice(0, -2)}xx`);
      assert.deepEqual(seen, []);
    } finally {
      await served.close();
    }
  });
});

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

void describe("Sealed cookies read through a guard", () => {
  void it("hand the module only a value its guard accepts", async () => {
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

void describe("Sealed cookies bound to their name", () => {
  void it("open only under the name they were written for", async () => {
    process.env.DMS_SESSION_SECRET ??=
      "a-test-only-session-secret-of-32-characters";
    const { serveModuleRoutes } =
      await import("../templates/vue/server/module-testing.mjs");
    const { scopedCookieName, SESSION_COOKIE } =
      await import("../templates/vue/server/auth/session.mjs");
    const moduleAccount = { refreshToken: "module-held", persistent: true };
    const served = await serveModuleRoutes([
      {
        id: "shop",
        setup: defineDmsServer((server) => {
          server.registerRoute("GET", "/api/_shop/write", (event) => {
            event.cookies.writeSealed("flow", moduleAccount);
            return null;
          });
          server.registerRoute("GET", "/api/_shop/session", (event) => ({
            session: event.session.read() ?? null,
          }));
        }),
      },
      {
        id: "bank",
        setup: defineDmsServer((server) => {
          server.registerRoute("GET", "/api/_bank/read", (event) => ({
            value:
              event.cookies.readSealed(
                "flow",
                (value): value is unknown => value !== undefined,
              ) ?? null,
          }));
        }),
      },
    ]);
    const body = async (path: string, cookie: string) =>
      responseJson(
        await fetch(`${served.url}${path}`, { headers: { cookie } }),
      );
    try {
      const written = await fetch(`${served.url}/api/_shop/write`);
      const sealed =
        written.headers.getSetCookie()[0]?.split(";", 1)[0]?.split("=")[1] ??
        "";
      assert.notEqual(sealed, "");

      assert.deepEqual(
        await body(
          "/api/_shop/session",
          `${scopedCookieName(SESSION_COOKIE)}=${sealed}`,
        ),
        { session: null },
      );
      assert.deepEqual(
        await body(
          "/api/_bank/read",
          `${scopedCookieName("bank.flow")}=${sealed}`,
        ),
        { value: null },
      );
    } finally {
      await served.close();
    }
  });
});

void describe("Sealed cookies of modules with similar ids", () => {
  void it("stay each module's own", async () => {
    process.env.DMS_SESSION_SECRET ??=
      "a-test-only-session-secret-of-32-characters";
    const { serveModuleRoutes } =
      await import("../templates/vue/server/module-testing.mjs");
    const { scopedCookieName } =
      await import("../templates/vue/server/auth/session.mjs");
    const cartModule = (id: string, route: string) => ({
      id,
      setup: defineDmsServer((server) => {
        server.registerRoute("GET", `/api/_${route}/write`, (event) => {
          event.cookies.writeSealed("cart", { owner: id });
          return null;
        });
        server.registerRoute("GET", `/api/_${route}/read`, (event) => ({
          value:
            event.cookies.readSealed(
              "cart",
              (value): value is unknown => value !== undefined,
            ) ?? null,
        }));
      }),
    });
    const served = await serveModuleRoutes([
      cartModule("acme.shop", "dotted"),
      cartModule("acme-shop", "dashed"),
      cartModule("a b", "spaced"),
      cartModule("a%20b", "encoded"),
    ]);
    const written = async (route: string) =>
      (await fetch(`${served.url}/api/_${route}/write`)).headers
        .getSetCookie()[0]
        ?.split(";", 1)[0] ?? "";
    const read = async (route: string, cookie: string) =>
      responseJson(
        await fetch(`${served.url}/api/_${route}/read`, {
          headers: { cookie },
        }),
      );
    try {
      const dotted = await written("dotted");
      assert.deepEqual(await read("dotted", dotted), {
        value: { owner: "acme.shop" },
      });
      assert.deepEqual(await read("dashed", dotted), { value: null });

      const dashed = await written("dashed");
      assert.equal(dashed.split("=", 1)[0], scopedCookieName("acme-shop.cart"));
      assert.deepEqual(await read("dotted", dashed), { value: null });

      const spaced = await written("spaced");
      assert.deepEqual(await read("spaced", spaced), {
        value: { owner: "a b" },
      });
      assert.deepEqual(await read("encoded", spaced), { value: null });
    } finally {
      await served.close();
    }
  });
});

void describe("Sealed cookies replayed under another name", () => {
  void it("open as nothing, whichever names they swap", async () => {
    process.env.DMS_SESSION_SECRET ??=
      "a-test-only-session-secret-of-32-characters";
    const { serveModuleRoutes } =
      await import("../templates/vue/server/module-testing.mjs");
    const { scopedCookieName, SESSION_COOKIE } =
      await import("../templates/vue/server/auth/session.mjs");
    const anything = (value: unknown): value is unknown => value !== undefined;
    const served = await serveModuleRoutes([
      {
        id: "auth",
        setup: defineDmsServer((server) => {
          server.registerAuth({});
          server.registerRoute("GET", "/api/_auth/write", (event) => {
            event.session.write({ refreshToken: "owner", persistent: true });
            event.cookies.writeSealed("dms_account", {
              refreshToken: "owner",
              persistent: true,
              updatedAt: Date.now(),
            });
            return null;
          });
          server.registerRoute("GET", "/api/_auth/session", (event) => ({
            session: event.session.read() ?? null,
          }));
        }),
      },
      {
        id: "shop",
        setup: defineDmsServer((server) => {
          server.registerRoute("GET", "/api/_shop/write", (event) => {
            event.cookies.writeSealed("first", { name: "first" });
            return null;
          });
          server.registerRoute("GET", "/api/_shop/read/:name", (event) => ({
            value:
              event.cookies.readSealed(event.params.name, anything) ?? null,
          }));
        }),
      },
    ]);
    const sealedBy = async (path: string) => {
      const response = await fetch(`${served.url}${path}`);
      return new Map(
        response.headers.getSetCookie().map((line) => {
          const pair = line.split(";", 1)[0] ?? "";
          return [
            pair.slice(0, pair.indexOf("=")),
            pair.slice(pair.indexOf("=") + 1),
          ];
        }),
      );
    };
    const read = async (path: string, name: string, value = "") =>
      responseJson(
        await fetch(`${served.url}${path}`, {
          headers: { cookie: `${scopedCookieName(name)}=${value}` },
        }),
      );
    try {
      const owner = await sealedBy("/api/_auth/write");
      const session = owner.get(scopedCookieName(SESSION_COOKIE));
      const account = owner.get(scopedCookieName("dms_account"));
      const first = (await sealedBy("/api/_shop/write")).get(
        scopedCookieName("shop.first"),
      );
      assert.ok(session && account && first);

      assert.deepEqual(
        await read("/api/_shop/read/first", "shop.first", session),
        {
          value: null,
        },
      );
      assert.deepEqual(
        await read("/api/_shop/read/second", "shop.second", first),
        {
          value: null,
        },
      );
      assert.deepEqual(
        await read("/api/_auth/session", SESSION_COOKIE, account),
        {
          session: null,
        },
      );
      assert.deepEqual(
        await read("/api/_shop/read/first", "shop.first", first),
        {
          value: { name: "first" },
        },
      );
    } finally {
      await served.close();
    }
  });
});

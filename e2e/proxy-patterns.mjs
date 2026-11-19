import { observe, withSatellite } from "./proxy-satellite.mjs";
import { standalone } from "./standalone.mjs";

export const journeys = [
  {
    id: "proxy-pattern-forms",
    title: "a pattern with a wildcard in the middle is not /x, /x/* or /x/** and is refused with a warning",
    entryPoint: "DMS_BACKEND_PROXIES with /mid/*/leaf on a second `ajs dms start`",
    ...standalone,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { env: { DMS_BACKEND_PROXIES: JSON.stringify([{ path: "/mid/*/leaf", auth: "none" }]) } }, async (server) => {
        const lines = server.log().split("\n");
        const warning = 'Backend module DMS_BACKEND_PROXIES declares the backend proxy "/mid/*/leaf", which is ignored: the pattern is not /x, /x/* or /x/**.';
        const reported = lines.filter((line) => line.includes("-> backend") && line.includes("/mid/*/leaf"));
        observe(ctx, "a mid-path wildcard", { warnings: lines.filter((line) => line.includes("/mid/")) }, [
          ctx.equal("the declaration is ignored with the documented reason", lines.filter((line) => line === warning).length, 1),
          ctx.equal("and it is not listed as a backend proxy", reported.length, 0),
        ]);
      });
    },
  },
];

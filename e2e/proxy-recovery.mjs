import { connect, createServer } from "node:net";
import { freePort, sleep, startSatellite } from "./proxy-satellite.mjs";
import { signIn } from "./signin.mjs";

/** How long the backend stays down once the page showed its error. */
const DOWN_MS = 2500;
/** The longest a recovered page may take: one retry at the longest delay, and the reload. */
const RECOVERY_TIMEOUT_MS = 20_000;
const POLL_MS = 100;

/**
 * @typedef {object} GatedBackend
 * @property {import("./proxy-satellite.mjs").FakeBackend} backend What the satellite is given as its backend
 * @property {() => Promise<void>} up Accepts connections again, and forwards them to the run's backend
 * @property {() => Promise<void>} down Closes the port and every open connection: connecting is refused
 */

/**
 * The run's backend behind a port of its own that can be closed and opened
 * again, as a backend restarted by `ajs -w` is.
 *
 * @param {string} apiUrl The run's backend
 * @returns {Promise<GatedBackend>} The open gate
 */
async function gatedBackend(apiUrl) {
  const target = new URL(apiUrl);
  const port = await freePort();
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  /** @param {import("node:net").Socket} socket */
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const server = createServer((client) => {
    const upstream = connect(Number(target.port), target.hostname);
    track(client);
    track(upstream);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream).pipe(client);
  });
  /** @returns {Promise<void>} */
  const up = () => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve()));
  /** @returns {Promise<void>} */
  const down = () =>
    new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    });
  await up();
  return {
    up,
    down,
    backend: { url: `http://127.0.0.1:${port}`, port, requests: [], to: () => [], close: down },
  };
}

export const journeys = [
  {
    id: "proxy-backend-restart",
    title: "a page loaded while the backend restarts shows the 502 page, which loads the page once the backend is back",
    entryPoint: "the dashboard's Settings page on a second server whose backend is down, then up again",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const gate = await gatedBackend(ctx.state.apiUrl);
      const satellite = await startSatellite(ctx, { sharedBackend: gate.backend });
      try {
        const tab = await ctx.tab("admin");
        const origin = `http://${new URL(ctx.state.webUrl).hostname}:${satellite.port}`;
        await signIn(ctx, tab, "admin", origin);
        const target = `${origin}/settings`;
        /** @type {{ kind: string, status: number }[]} */
        const answers = [];
        tab.page.on("response", (answer) => {
          if (answer.url() === target) answers.push({ kind: answer.request().resourceType(), status: answer.status() });
        });
        await gate.down();
        await tab.page.goto(target);
        const errorPage = answers.find((answer) => answer.kind === "document");
        await tab.snapshot("backend down");
        await ctx.verify("backend down: the page answers 502", [
          ctx.equal("the document's status", errorPage?.status, 502),
        ], { critical: true });
        await sleep(DOWN_MS);
        const retriesWhileDown = answers.filter((answer) => answer.kind === "fetch").length;
        await gate.up();
        const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
        const recovered = () => answers.some((answer) => answer.kind === "document" && answer.status === 200);
        while (!recovered() && Date.now() < deadline) await sleep(POLL_MS);
        const settings = tab.page.locator('a[href^="/settings/"]');
        const shown = await settings.first().waitFor({ state: "visible", timeout: RECOVERY_TIMEOUT_MS }).then(() => true, () => false);
        await tab.snapshot("backend back");
        await ctx.verify("backend back: the page loads by itself", [
          ctx.holds("the page asked again while the backend was down", retriesWhileDown >= 2, JSON.stringify(answers)),
          ctx.holds("a reload answered 200 with no action of the user", recovered(), JSON.stringify(answers)),
          ctx.holds("the Settings page shows", shown, shown),
          tab.at(/^\/settings$/),
        ]);
      } finally {
        await satellite.stop();
        await gate.down();
      }
    },
  },
];

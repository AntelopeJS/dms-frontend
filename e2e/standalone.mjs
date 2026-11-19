/**
 * What a journey declares when it needs a run of the kit, its playground, its servers or its secrets, and never a
 * browser tab: it spawns the `ajs dms` CLI or calls the run's servers over HTTP. It runs as an ordinary test of
 * `pnpm test:journeys` (`tests/run.journeys.test.mts`), where the kit prepares the run as its other fields say, a
 * fresh database with an onboarded administrator unless they say otherwise.
 */
export const noBrowser = Object.freeze({ runner: "run" });

/**
 * What a journey without a browser tab declares when it needs nothing of the run's backend: it spawns only the
 * `ajs dms` CLI against fixtures, scratch homes, fake backends or servers of its own, and never reads the run's
 * database, an account, a token or the mail sink. The kit then keeps the current database instead of restarting
 * the backend on a new one, and skips onboarding the administrator.
 */
export const standalone = Object.freeze({ ...noBrowser, database: "shared", onboard: false });

/**
 * What a standalone journey declares when it needs no run at all: no playground, no frontend server of the run
 * and no secret of the run, only the CLI of this checkout, a scratch run folder and a scratch HOME. It runs as an
 * ordinary test of `pnpm test:cli` (`tests/cli-journeys.test.mts`), which fails it when it reads anything else.
 */
export const cliOnly = Object.freeze({ ...standalone, runner: "cli" });

/**
 * @template {{ runner?: "cli" | "run" }} J
 * @param {J[]} all The journeys of a feature
 * @returns {{ journeys: J[], cliJourneys: J[], runJourneys: J[] }} The journeys the Playwright suite runs, those `pnpm test:cli` runs, and those `pnpm test:journeys` runs
 */
export function byRunner(all) {
  return {
    journeys: all.filter((journey) => journey.runner === undefined),
    cliJourneys: all.filter((journey) => journey.runner === "cli"),
    runJourneys: all.filter((journey) => journey.runner === "run"),
  };
}

/**
 * What a journey declares when it needs nothing of the run's backend: it spawns only the `ajs dms` CLI against
 * fixtures, scratch homes, fake backends or servers of its own, and never reads the run's database, an account,
 * a token, the mail sink, a browser tab or `ctx.api`. `dms-control` then keeps the current database instead of
 * restarting the backend on a new one, and skips onboarding the administrator.
 */
export const standalone = Object.freeze({ database: "shared", onboard: false });

/**
 * What a standalone journey declares when it needs no run at all: no playground, no frontend server of the run
 * and no secret of the run, only the CLI of this checkout, a scratch run folder and a scratch HOME. It runs as an
 * ordinary test of `pnpm test:cli` (`tests/cli-journeys.test.mts`), which fails it when it reads anything else.
 */
export const cliOnly = Object.freeze({ ...standalone, cliOnly: true });

/**
 * @template {{ cliOnly?: boolean }} J
 * @param {J[]} all The journeys of a feature
 * @returns {{ journeys: J[], cliJourneys: J[] }} The journeys the Playwright suite runs on a `dms-control` run, and those `pnpm test:cli` runs
 */
export function byRunner(all) {
  return { journeys: all.filter((journey) => !journey.cliOnly), cliJourneys: all.filter((journey) => journey.cliOnly === true) };
}

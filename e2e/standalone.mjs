/**
 * What a journey declares when it needs no run at all: no playground, no frontend server of the run and no
 * secret of the run, only the CLI of this checkout, a scratch run folder and a scratch HOME. It runs as an
 * ordinary test of `pnpm test:cli` (`tests/cli-journeys.test.mts`), which fails it when it reads anything else.
 */
export const cliOnly = Object.freeze({ runner: "cli" });

/**
 * What a journey declares when it needs a run of the kit, its playground, its servers, its secrets or its
 * administrator, and never a browser tab: it spawns the `ajs dms` CLI or calls the run's servers over HTTP. It runs
 * as an ordinary test of `pnpm test:journeys` (`tests/run.journeys.test.mts`), on one run shared by every such
 * journey, whose database has the administrator onboarded.
 */
export const noBrowser = Object.freeze({ runner: "run" });

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

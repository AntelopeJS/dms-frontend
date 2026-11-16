/**
 * What a journey declares when it needs nothing of the run's backend: it spawns only the `ajs dms` CLI against
 * fixtures, scratch homes, fake backends or servers of its own, and never reads the run's database, an account,
 * a token, the mail sink, a browser tab or `ctx.api`. `dms-control` then keeps the current database instead of
 * restarting the backend on a new one, and skips onboarding the administrator.
 */
export const standalone = Object.freeze({ database: "shared", onboard: false });

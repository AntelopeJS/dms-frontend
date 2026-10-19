// Waiting out a backend the platform is waking from sleep.
//
// A platform that scales the backend to zero answers the first requests with
// a 503 while it starts a replica, marked with the cold-start header and a
// Retry-After. The header is a reserved resume convention, not a proof of
// where the answer came from: a backend may set it too, and then gets the
// same bounded wait. Only a GET or a HEAD is repeated, within a time and
// attempt budget, and the wait ends when the client leaves. Any 503 without
// the header goes out as it came; a POST, PATCH or DELETE is sent once.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows.

import { setTimeout as sleep } from "node:timers/promises";

/** Header marking a 503 as a cold start to wait out. */
export const COLD_START_HEADER = "x-antelope-cold-start";
const COLD_START_VALUE = "1";
const UNAVAILABLE = 503;
const RETRYABLE_METHODS = new Set(["GET", "HEAD"]);
const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_DELAY_MS = 1_000;
const MIN_DELAY_MS = 1_000;
// The attempts are capped as well as the time, so a marked answer with
// `Retry-After: 0` cannot multiply a GET.
const MAX_RETRIES = 15;
const MAX_DELAY_MS = 5_000;
const MS_PER_SECOND = 1_000;
const WHOLE_SECONDS = /^\d+$/;
const WHOLE_MILLISECONDS = /^\d+$/;

/** Whether `response` is a 503 marked as a cold start. */
export function isColdStart(response) {
  return (
    response.status === UNAVAILABLE &&
    response.headers.get(COLD_START_HEADER) === COLD_START_VALUE
  );
}

/**
 * How long a request may wait for a waking backend, from
 * DMS_BACKEND_WAKE_BUDGET_MS. 0 turns the wait off; anything but a whole
 * number of milliseconds keeps the default.
 */
export function wakeBudgetMs(env = process.env) {
  const raw = (env.DMS_BACKEND_WAKE_BUDGET_MS ?? "").trim();
  return WHOLE_MILLISECONDS.test(raw) ? Number(raw) : DEFAULT_BUDGET_MS;
}

/** The pause `Retry-After` asks for, kept between bounds; seconds only. */
export function retryDelayMs(response) {
  const raw = (response.headers.get("retry-after") ?? "").trim();
  if (!WHOLE_SECONDS.test(raw)) return DEFAULT_DELAY_MS;
  return Math.min(
    MAX_DELAY_MS,
    Math.max(MIN_DELAY_MS, Number(raw) * MS_PER_SECOND),
  );
}

/**
 * `fetch`, waiting out cold-start answers to a GET or a HEAD
 * until `budgetMs` is spent. The last cold-start answer is returned once the
 * next pause would overrun the budget, so the caller relays its status and
 * `Retry-After`, as it is once MAX_RETRIES repeats are spent. Aborting
 * `init.signal` ends the wait with an AbortError.
 */
export async function fetchWaking(
  url,
  init = {},
  { budgetMs = wakeBudgetMs(), now = Date.now } = {},
) {
  const method = (init.method ?? "GET").toUpperCase();
  const deadline = now() + budgetMs;
  let response = await fetch(url, init);
  if (!RETRYABLE_METHODS.has(method)) return response;
  for (let retry = 0; isColdStart(response); retry += 1) {
    const delay = retryDelayMs(response);
    if (retry >= MAX_RETRIES || now() + delay > deadline) return response;
    await response.body?.cancel();
    await sleep(delay, undefined, { signal: init.signal });
    response = await fetch(url, init);
  }
  return response;
}

// Waiting out a backend the platform is waking from sleep.
//
// A platform that scales the backend to zero answers the first requests with
// a 503 while it starts a replica, marked with the cold-start header and a
// Retry-After in whole seconds: all three make the signal, and a 503 missing
// one of them goes out as it came. The header is a reserved resume
// convention, not a proof of where the answer came from: a backend may set it
// too, and then gets the same bounded wait. Only a GET or a HEAD is repeated;
// a POST, PATCH or DELETE is sent once.
//
// The wait starts with the first cold-start answer and lasts at most the
// budget, the repeated requests included: one still waiting for its answer
// when the budget runs out is aborted, and no request starts after it. It
// ends at once when the client leaves.
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
const MIN_DELAY_MS = 1_000;
// Repeats after the first request, so a GET is sent 16 times at most. They
// are capped as well as the time, so a marked answer with `Retry-After: 0`
// cannot multiply a GET.
const MAX_REPEATS = 15;
const MAX_DELAY_MS = 5_000;
const MS_PER_SECOND = 1_000;
const WHOLE_SECONDS = /^\d+$/;
const WHOLE_MILLISECONDS = /^\d+$/;

/** Whether `response` is a 503 marked as a cold start, with its Retry-After. */
export function isColdStart(response) {
  return (
    response.status === UNAVAILABLE &&
    response.headers.get(COLD_START_HEADER) === COLD_START_VALUE &&
    WHOLE_SECONDS.test(retryAfter(response))
  );
}

function retryAfter(response) {
  return (response.headers.get("retry-after") ?? "").trim();
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

/** The pause a cold-start answer's Retry-After asks for, kept between bounds. */
function retryDelayMs(response) {
  return Math.min(
    MAX_DELAY_MS,
    Math.max(MIN_DELAY_MS, Number(retryAfter(response)) * MS_PER_SECOND),
  );
}

/**
 * What the client gets once the budget is spent: the last cold-start answer's
 * status and headers, without the body its pause already discarded.
 */
function expired(cold) {
  return new Response(null, {
    status: UNAVAILABLE,
    headers: {
      [COLD_START_HEADER]: COLD_START_VALUE,
      "retry-after": retryAfter(cold),
    },
  });
}

/**
 * Sends one repeat, aborted if no answer has come by `deadline`. Once the
 * answer has come the deadline no longer applies, so a ready backend's body
 * streams for as long as it needs; only the client leaving ends it.
 * Resolves to undefined when the deadline aborted the request.
 */
async function repeat(url, init, deadline, now) {
  const late = new AbortController();
  const timer = setTimeout(() => late.abort(), Math.max(0, deadline - now()));
  const signal = init.signal
    ? AbortSignal.any([init.signal, late.signal])
    : late.signal;
  try {
    return await fetch(url, { ...init, signal });
  } catch (error) {
    if (late.signal.aborted && !init.signal?.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch`, waiting out cold-start answers to a GET or a HEAD until `budgetMs`
 * from the first of them is spent or MAX_REPEATS repeats are sent. Then the
 * caller gets a cold-start 503 with its `Retry-After` to relay. The client
 * leaving, through `init.signal`, ends the wait with its AbortError.
 */
export async function fetchWaking(
  url,
  init = {},
  { budgetMs = wakeBudgetMs(), now = Date.now } = {},
) {
  const method = (init.method ?? "GET").toUpperCase();
  let response = await fetch(url, init);
  if (!RETRYABLE_METHODS.has(method)) return response;
  const deadline = now() + budgetMs;
  for (let repeats = 0; isColdStart(response); repeats += 1) {
    const cold = response;
    const delay = retryDelayMs(cold);
    if (repeats >= MAX_REPEATS || now() + delay > deadline) return cold;
    cold.body?.cancel().catch(() => {});
    await sleep(delay, undefined, { signal: init.signal });
    if (now() >= deadline) return expired(cold);
    response = (await repeat(url, init, deadline, now)) ?? expired(cold);
  }
  return response;
}

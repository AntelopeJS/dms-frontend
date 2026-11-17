/**
 * The statuses of an error page served while the backend is unreachable or
 * restarting. The page asks again on its own until the answer is another one.
 */
const RETRIED_STATUSES = [502, 503, 504];
const FIRST_DELAY_MS = 500;
const LONGEST_DELAY_MS = 8000;

/**
 * Runs in the browser: asks for the page again after `delay`, doubling it up
 * to `longestDelay`, and reloads once the answer is not a `retried` status.
 *
 * @param {{ href: string, reload(): void }} page The browser's `location`
 * @param {number[]} retried
 * @param {number} delay
 * @param {number} longestDelay
 */
function retryUntilAnswered(page, retried, delay, longestDelay) {
  setTimeout(() => {
    fetch(page.href, { headers: { accept: "text/html" }, cache: "no-store" })
      .then((answer) => {
        if (retried.includes(answer.status)) throw new Error("still down");
        page.reload();
      })
      .catch(() =>
        retryUntilAnswered(
          page,
          retried,
          Math.min(delay * 2, longestDelay),
          longestDelay,
        ),
      );
  }, delay);
}

/**
 * The script an error document of `status` carries so that it loads the page
 * once the backend answers again, or `""` for a status a retry cannot change.
 *
 * @param {number} status
 * @returns {string}
 */
export function backendRetryScript(status) {
  if (!RETRIED_STATUSES.includes(status)) return "";
  const call = `(${retryUntilAnswered.toString()})(location,${JSON.stringify(RETRIED_STATUSES)},${FIRST_DELAY_MS},${LONGEST_DELAY_MS})`;
  return `<script>${call}</script>`;
}

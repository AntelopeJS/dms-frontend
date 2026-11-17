/**
 * The statuses of an error page served while the backend is unreachable or
 * restarting. The page asks again on its own until the answer is another one.
 */
const RETRIED_STATUSES = [502, 503, 504];
const FIRST_DELAY_MS = 500;
const LONGEST_DELAY_MS = 8000;

/**
 * @typedef {{ detail?: { page?: { props?: { error?: { statusCode?: unknown } } } } }} NavigateEvent
 */

/**
 * Runs in the browser: asks for the page again after `firstDelay`, doubling
 * the wait up to `longestDelay`, and reloads once the answer is not a
 * `retried` status. It stops once Inertia shows a page that is not a
 * `retried` error, as when the visitor leaves the error page.
 *
 * @param {{ href: string, reload(): void }} page The browser's `location`
 * @param {{ addEventListener(type: string, listener: (event: NavigateEvent) => void): void }} events The browser's `document`
 * @param {unknown[]} retried
 * @param {number} firstDelay
 * @param {number} longestDelay
 */
function retryUntilAnswered(page, events, retried, firstDelay, longestDelay) {
  let left = false;
  events.addEventListener("inertia:navigate", (event) => {
    left = !retried.includes(event.detail?.page?.props?.error?.statusCode);
  });
  /** @param {number} delay */
  const attempt = (delay) =>
    setTimeout(() => {
      if (left) return;
      fetch(page.href, { headers: { accept: "text/html" }, cache: "no-store" })
        .then((answer) => {
          if (retried.includes(answer.status)) throw new Error("still down");
          if (!left) page.reload();
        })
        .catch(() => attempt(Math.min(delay * 2, longestDelay)));
    }, delay);
  attempt(firstDelay);
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
  const call = `(${retryUntilAnswered.toString()})(location,document,${JSON.stringify(RETRIED_STATUSES)},${FIRST_DELAY_MS},${LONGEST_DELAY_MS})`;
  return `<script>${call}</script>`;
}

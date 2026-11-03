import { parseJson, rowAt } from "./json.mjs";

/**
 * Plain HTTP against the run's frontend server, as a browser or a script would.
 *
 * @typedef {import("./control.d.ts").JourneyContext} Ctx
 * @typedef {import("./control.d.ts").Tab} Tab
 * @typedef {{ status: number, headers: Headers, text: string }} Answer
 */

const PAGE_SCRIPT = /<script data-page="app" type="application\/json">([\s\S]*?)<\/script>/;
const PAYLOAD_SCRIPT = /<script id="dms-payload" type="application\/json">([\s\S]*?)<\/script>/;

/**
 * @param {Tab} tab A signed-in tab
 * @returns {Promise<string>} Its cookies as a Cookie header
 */
export async function cookieOf(tab) {
  const cookies = await tab.page.context().cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * @param {Ctx} ctx The journey context
 * @param {string} path The path on the frontend server
 * @param {{ cookie?: string, headers?: Record<string, string>, method?: string, body?: string }} [options] Request options
 * @returns {Promise<Answer>} The answer, redirects not followed
 */
export async function get(ctx, path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.cookie) headers.set("cookie", options.cookie);
  const response = await fetch(`${ctx.state.webUrl}${path}`, {
    method: options.method ?? "GET",
    body: options.body,
    redirect: "manual",
    headers,
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

/**
 * @param {string} html A rendered document
 * @returns {Record<string, unknown> | undefined} Its Inertia page object
 */
export function pageObject(html) {
  const match = PAGE_SCRIPT.exec(html);
  return match ? rowAt({ page: parseJson(match[1].replaceAll("\\/", "/")) }, "page") : undefined;
}

/**
 * @param {string} html A rendered document
 * @returns {string | undefined} The raw text of its data payload
 */
export function payloadText(html) {
  return PAYLOAD_SCRIPT.exec(html)?.[1];
}

/**
 * @param {{ headers: Headers }} answer An answer
 * @param {string} name A header
 * @returns {string} Its value, or an empty string
 */
export function header(answer, name) {
  return answer.headers.get(name) ?? "";
}

/**
 * @param {{ headers: Headers }} answer An answer
 * @param {string} name A header name
 * @returns {boolean} Whether its Vary list names the header
 */
export function varies(answer, name) {
  return header(answer, "vary")
    .split(",")
    .some((entry) => entry.trim().toLowerCase() === name.toLowerCase());
}

/**
 * @param {string} html A rendered document
 * @returns {string} The body text, scripts removed
 */
export function visibleText(html) {
  return html.slice(html.indexOf("<body")).replace(/<script[\s\S]*?<\/script>/g, "");
}

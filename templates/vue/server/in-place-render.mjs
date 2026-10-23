// A page that completes its query as it renders, rendered at that query in
// the same request rather than answered with a redirect.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows.

import { ofetch } from "ofetch";

/**
 * How many times one request renders a page in place of a same-path redirect
 * before it answers the redirect: a page that keeps changing its query.
 */
const IN_PLACE_RENDERS = 2;

/**
 * The key of a backend read a later render of the same request may reuse: a
 * plain JSON `GET`, without hooks that would expect to see the response.
 */
function reusableReadKey(path, options, headers) {
  const method = (options.method ?? "GET").toUpperCase();
  if (method !== "GET" || options.body !== undefined) return undefined;
  if (options.responseType && options.responseType !== "json") return undefined;
  if (Object.keys(options).some((name) => /^on[A-Z]/.test(name)))
    return undefined;
  return JSON.stringify([
    path,
    options.query ?? options.params ?? null,
    [...headers],
  ]);
}

/**
 * The backend reads of a request's server renders, sent with the request's
 * `backendHeaders()` and the read's own. After `reuseCompletedReads()`, a later
 * render of the same request is given a copy of each read a previous render
 * completed instead of reading the backend again.
 */
export function serverReads(backendHeaders) {
  const completed = new Map();
  let reuse = false;
  const read = (path, options = {}) => {
    const headers = new Headers(backendHeaders());
    new Headers(options.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    const key = reusableReadKey(path, options, headers);
    if (reuse && key && completed.has(key))
      return Promise.resolve(structuredClone(completed.get(key)));
    const reading = ofetch(path, {
      ...options,
      baseURL: process.env.DMS_API_BASE_URL,
      headers,
    });
    if (!key) return reading;
    // A copy: the render that read it may still change the object it got. A
    // body that cannot be copied is read again.
    return reading.then((data) => {
      try {
        completed.set(key, structuredClone(data));
      } catch {}
      return data;
    });
  };
  return Object.assign(read, {
    reuseCompletedReads: () => {
      reuse = true;
    },
  });
}

/**
 * Whether a document request renders `location` in place of redirecting to
 * it: a `GET` whose page only completes its query (`?workspace=`), on the
 * same path. Any other redirect keeps its own response.
 */
function rendersInPlace(request, from, location) {
  if (request.method !== "GET" || location.includes("#")) return false;
  const current = new URL(from, "http://frontend.local");
  const target = new URL(location, current);
  return (
    target.origin === current.origin && target.pathname === current.pathname
  );
}

/**
 * Renders a page document with `render(page)`. A page that completes its
 * query as it renders (`router.replace` to the same path) is rendered again at
 * that query, with the props `propsAt(props, url)` gives, reusing the reads
 * the first render made (`fetch`), instead of being answered with a redirect
 * the browser would follow with a whole new request. The page served then
 * names the URL the document shows, which the browser puts in the address bar.
 */
export async function renderInPlace(request, page, fetch, render, propsAt) {
  let rendered = await render(page);
  let served = page;
  for (
    let pass = 0;
    rendered.redirect &&
    pass < IN_PLACE_RENDERS &&
    rendersInPlace(request, served.url, rendered.redirect);
    pass++
  ) {
    const url = new URL(rendered.redirect, "http://frontend.local");
    const props = await propsAt(served.props, url);
    served = { ...served, url: `${url.pathname}${url.search}`, props };
    fetch.reuseCompletedReads();
    rendered = await render(served);
  }
  return { rendered, served };
}

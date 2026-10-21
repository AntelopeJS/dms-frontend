// Restoring "paint before hydrate" in the built document.
//
// The source index.html marks the entry script `fetchpriority="low"` so the
// browser spends its bandwidth on the render-blocking stylesheet first. Vite
// rewrites that script tag when it builds and drops the attribute, and it emits
// the script *before* the stylesheet — so the production document did the
// opposite of what the template asked: it discovered a 250 kB hydration bundle
// first and let it compete with the 27 kB the first paint actually waits on,
// over the plain HTTP/1.1 the generated server speaks.
//
// Kept beside vite.config.ts rather than inside it so the transform can be
// exercised on its own, the way client-manifest.mjs is.

const SCRIPT = /<script[^>]*\stype="module"[^>]*><\/script>/;
const STYLESHEET = /[ \t]*<link rel="stylesheet"[^>]*>\n?/;

function deprioritize(html) {
  return html.replace(SCRIPT, (tag) =>
    tag.includes("fetchpriority")
      ? tag
      : tag.replace("<script ", '<script fetchpriority="low" '),
  );
}

/**
 * Give the entry script back its low fetch priority and move the stylesheet
 * ahead of it. A document that already has them in that order is returned
 * unchanged, so the transform is safe to run twice.
 */
export function orderHeadForFirstPaint(html) {
  const prioritized = deprioritize(html);
  const stylesheet = prioritized.match(STYLESHEET);
  const script = prioritized.match(SCRIPT);
  if (!stylesheet || !script || stylesheet.index < script.index)
    return prioritized;
  return prioritized
    .replace(STYLESHEET, "")
    .replace(SCRIPT, (tag) => `${stylesheet[0].trim()}\n    ${tag}`);
}

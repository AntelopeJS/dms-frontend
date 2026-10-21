// The favicon placeholder of a page whose render declares no icon.
//
// A document without any `<link rel="icon">` makes the browser ask for
// `/favicon.ico`, a request the frontend server would pass on to the backend
// on every page load. An empty data URL stops it. The template used to carry
// that placeholder itself, but a module declaring real icons through `useHead`
// (light and dark, one per `prefers-color-scheme`) then competed with it, and
// the browser could keep the empty one: it only goes in when the rendered head
// has no icon of its own.

const FAVICON_PLACEHOLDER = '<link rel="icon" href="data:," />';
/** A `<link>` whose `rel` holds the `icon` token, `shortcut icon` included. */
const ICON_LINK = /<link\b[^>]*\srel=(["'])(?:[^"']*\s)?icon(?:\s[^"']*)?\1/i;

/** The rendered head tags, behind the placeholder when they hold no icon. */
export function withFaviconPlaceholder(headTags) {
  return ICON_LINK.test(headTags)
    ? headTags
    : `${FAVICON_PLACEHOLDER}${headTags}`;
}

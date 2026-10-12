/**
 * The comments Vue's server renderer leaves for hydration: fragment brackets
 * (`<!--[-->`, `<!--]-->`), an empty `v-if` branch (`<!---->`, `<!--v-if-->`)
 * and teleport anchors. An email is never hydrated, so they only weigh on the
 * message and show in its source. Any other comment, such as Outlook's
 * conditional comments (`<!--[if mso]>`), is kept.
 */
const SSR_MARKERS =
  /<!--(?:\[|\]|v-if|teleport(?: start| end)?(?: anchor)?|)-->/g;

/** Removes Vue's hydration markers from server-rendered email markup. */
export function stripSsrMarkers(html: string): string {
  return html.replace(SSR_MARKERS, "");
}

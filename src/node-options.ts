/** The heap the Nuxt servers and builds get unless the caller sets its own. */
const HEAP_OPTION = "--max-old-space-size=4096";

/**
 * The `NODE_OPTIONS` a dev server or a build runs with: the default heap, then the caller's own options, so a
 * caller's `--require` preload reaches the server and a caller's heap size, applied last, wins.
 */
export function serverNodeOptions(inherited: string | undefined): string {
  const own = inherited?.trim();
  return own ? `${HEAP_OPTION} ${own}` : HEAP_OPTION;
}

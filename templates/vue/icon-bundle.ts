import { addIcon, type IconifyIcon } from "@iconify/vue";

function register(name: string, data: IconifyIcon): boolean {
  const colon = name.indexOf(":");
  if (colon !== -1 && name.slice(0, colon).includes("-")) {
    addIcon(name.replace(":", "-"), data);
  }
  return addIcon(name, data);
}

let loading: Promise<void> | undefined;

/**
 * Loads the icons Nuxt UI bundles for the client, once: every icon the
 * application's sources name. A server render has them from the start (Nuxt
 * UI's own plugin, left in place by `ui-lazy-icons.mjs`), so there is nothing
 * to load.
 *
 * A failed load is forgotten and resolves: an icon the bundle would have
 * held is then fetched from the icon API, as one outside the bundle always is.
 */
export function loadIconBundle(): Promise<void> {
  if (import.meta.env.SSR) return Promise.resolve();
  loading ??= import("virtual:nuxt-ui-icons").then(
    ({ init }) => init(register),
    () => {
      loading = undefined;
    },
  );
  return loading;
}

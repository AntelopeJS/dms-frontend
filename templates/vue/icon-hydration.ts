import {
  addCollection,
  addIcon,
  getIcon,
  Icon,
  type IconifyIcon,
  type IconifyJSON,
  iconLoaded,
} from "@iconify/vue";
import type { App, Component, ComponentPublicInstance } from "vue";

/** The element a server render writes the data of the icons it drew to. */
export const SSR_ICONS_ID = "dms-ssr-icons";

interface IconProps {
  icon?: unknown;
}

/**
 * Draws an Iconify icon in its first render whenever its data is loaded, on
 * the server as in the browser.
 *
 * `@iconify/vue` otherwise renders every icon empty until it mounts, which a
 * server render never does: pages arrived without their icons, which popped in
 * once hydrated. Its `ssr` prop opts out of the wait, but Nuxt UI's `UIcon`
 * does not pass it, so its default is set here, and only for an icon whose
 * data is loaded: an icon still to be fetched waits for the mount as before,
 * so a server render never queries an Iconify API.
 */
export function drawLoadedIconsAtOnce(): void {
  (Icon as unknown as { props: Record<string, unknown> }).props.ssr = {
    type: Boolean,
    default: ({ icon }: IconProps) =>
      typeof icon !== "string" || iconLoaded(icon),
  };
}

/**
 * Loads whole icon collections, so a server render draws any icon of them,
 * including those only named by backend data, which the client bundle's scan
 * cannot see.
 */
export function registerDmsIconCollections(collections: IconifyJSON[]): void {
  for (const collection of collections) addCollection(collection);
}

/** Records the name of every Iconify icon a server render reaches. */
export function trackDmsIcons(app: App): Set<string> {
  const names = new Set<string>();
  app.mixin({
    beforeCreate(this: ComponentPublicInstance) {
      if (this.$.type !== (Icon as Component)) return;
      const { icon } = this.$props as IconProps;
      if (typeof icon === "string") names.add(icon);
    },
  });
  return names;
}

/**
 * The data of the icons a server render drew, which the browser loads before
 * it hydrates: an icon outside the client bundle would otherwise hydrate
 * empty over the server's markup.
 */
export function serializeDmsIcons(
  names: Iterable<string>,
): Record<string, IconifyIcon> {
  return Object.fromEntries(
    [...names].flatMap((name) => {
      const data = getIcon(name);
      return data ? [[name, data]] : [];
    }),
  );
}

export function addDmsIcons(icons: Record<string, IconifyIcon>): void {
  for (const [name, data] of Object.entries(icons)) addIcon(name, data);
}

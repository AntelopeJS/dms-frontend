import {
  addCollection,
  addIcon,
  getIcon,
  Icon,
  type IconifyIcon,
  type IconifyJSON,
  iconLoaded,
} from "@iconify/vue";
import {
  type App,
  type Component,
  type ComponentPublicInstance,
  cloneVNode,
  inject,
  type InjectionKey,
  type SetupContext,
  type VNode,
} from "vue";

/** The element a server render writes the data of the icons it drew to. */
export const SSR_ICONS_ID = "dms-ssr-icons";
/** The hidden `<svg>` that holds each drawn icon once, as a `<symbol>`. */
export const ICON_SPRITE_ID = "dms-icon-sprite";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SYMBOL_PREFIX = "dms-icon-";
const HASH_OFFSET = 0x811c9dc5;
const HASH_PRIME = 0x01000193;
const HASH_RADIX = 36;

/** The symbols of one server render, by id. */
type IconSymbols = Map<string, string>;
const SERVER_SYMBOLS: InjectionKey<IconSymbols> = Symbol("dms-icon-symbols");

interface IconProps {
  icon?: string | IconifyIcon;
}

function isIconName(icon: IconProps["icon"]): icon is string {
  return typeof icon === "string";
}

interface SsrPropOption {
  type: BooleanConstructor;
  default?: (props: IconProps) => boolean;
}

/** The options `defineComponent` gives `Icon`, which its type does not show. */
interface IconOptions {
  props: { ssr: SsrPropOption };
  setup: (props: IconProps, context: SetupContext) => () => VNode;
}

function isIconOptions(
  component: Component,
): component is Component & IconOptions {
  return (
    "props" in component &&
    typeof component.props === "object" &&
    component.props !== null &&
    "ssr" in component.props &&
    typeof component.props.ssr === "object" &&
    component.props.ssr !== null &&
    "type" in component.props.ssr &&
    component.props.ssr.type === Boolean &&
    "setup" in component &&
    typeof component.setup === "function"
  );
}

function iconOptions(): IconOptions {
  if (!isIconOptions(Icon))
    throw new TypeError("@iconify/vue's Icon is not a setup component.");
  return Icon;
}

function isIconSvgProps(
  props: VNode["props"],
): props is NonNullable<VNode["props"]> & IconSvgProps {
  return (
    props !== null &&
    typeof props.innerHTML === "string" &&
    props.innerHTML !== "" &&
    typeof props.viewBox === "string"
  );
}

interface IconSvgProps {
  innerHTML: string;
  viewBox: string;
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
  iconOptions().props.ssr = {
    type: Boolean,
    default: ({ icon }) => !isIconName(icon) || iconLoaded(icon),
  };
  drawIconsFromSprite();
}

/** FNV-1a: the same short digest in a server and in a browser. */
function digest(text: string): string {
  let hash = HASH_OFFSET;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, HASH_PRIME);
  }
  return (hash >>> 0).toString(HASH_RADIX);
}

function symbolMarkup(id: string, viewBox: string, body: string): string {
  return `<symbol id="${id}" viewBox="${viewBox}">${body}</symbol>`;
}

/** Adds a symbol to the page's sprite, which it creates the first time. */
function addSymbolToDocument(id: string, viewBox: string, body: string): void {
  if (document.getElementById(id)) return;
  let sprite: Element | null = document.getElementById(ICON_SPRITE_ID);
  if (!sprite) {
    const created = document.createElementNS(SVG_NAMESPACE, "svg");
    created.id = ICON_SPRITE_ID;
    created.setAttribute("aria-hidden", "true");
    created.setAttribute("style", "display:none");
    document.body.append(created);
    sprite = created;
  }
  sprite.insertAdjacentHTML("beforeend", symbolMarkup(id, viewBox, body));
}

/**
 * The icon drawn as a `<use>` of its symbol in the page's sprite, rather than
 * with its whole body: an icon shown on every row of a table is sent once.
 * The symbol is keyed by the drawn body and view box, so a flipped or rotated
 * icon is a symbol of its own. Left inline on a server render that collects no
 * symbols, and for an empty icon.
 */
function spriteIcon(vnode: VNode, symbols: IconSymbols | null): VNode {
  const { props } = vnode;
  if (vnode.type !== "svg" || !isIconSvgProps(props)) return vnode;
  const { innerHTML: body, viewBox } = props;
  const id = `${SYMBOL_PREFIX}${digest(`${viewBox}\n${body}`)}`;
  if (symbols) symbols.set(id, symbolMarkup(id, viewBox, body));
  else if (typeof document !== "undefined")
    addSymbolToDocument(id, viewBox, body);
  else return vnode;
  return cloneVNode(vnode, { innerHTML: `<use href="#${id}"></use>` });
}

let drawingFromSprite = false;

/** Makes every Iconify icon draw itself from the page's sprite. */
function drawIconsFromSprite(): void {
  if (drawingFromSprite) return;
  drawingFromSprite = true;
  const component = iconOptions();
  const setup = component.setup;
  component.setup = (props, context) => {
    const symbols = inject(SERVER_SYMBOLS, null);
    const draw = setup(props, context);
    return () => spriteIcon(draw(), symbols);
  };
}

/** Collects the symbols of the icons a server render draws. */
export function collectDmsIconSymbols(app: App): IconSymbols {
  const symbols: IconSymbols = new Map();
  app.provide(SERVER_SYMBOLS, symbols);
  return symbols;
}

/** The sprite of a server render, each icon it drew once. */
export function dmsIconSprite(symbols: IconSymbols): string {
  if (!symbols.size) return "";
  return `<svg id="${ICON_SPRITE_ID}" aria-hidden="true" style="display:none">${[...symbols.values()].join("")}</svg>`;
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
  const iconComponent = iconOptions();
  app.mixin({
    beforeCreate(this: ComponentPublicInstance<IconProps>) {
      if (this.$.type !== iconComponent) return;
      const { icon } = this.$props;
      if (isIconName(icon)) names.add(icon);
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

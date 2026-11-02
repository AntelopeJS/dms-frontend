/** The `<script>` the server render leaves in the document for {@link DmsMessageSubset}. */
export const SSR_MESSAGES_ID = "dms-ssr-messages";

type Messages = Record<string, unknown>;

/**
 * The messages a server render read from a locale's catalog, as a catalog of
 * their own, with the locale they belong to.
 */
export interface DmsMessageSubset {
  locale: string;
  messages: Messages;
}

export interface MessageReadRecorder {
  /** The catalog to give the render: every read through it is recorded. */
  messages: Messages;
  /** What the render read so far. */
  subset: () => Messages;
}

function isTraversable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isMessages(value: unknown): value is Messages {
  return isTraversable(value);
}

type Slot = () => Messages;

/**
 * Wraps a catalog so that the messages read through it are collected, with
 * the path they sit at, into a catalog of their own.
 *
 * A message is recorded when a string is read from the catalog, whether by a
 * lookup (`t`), an existence check (`te`) or a walk over a subtree (`tm`).
 */
export function recordMessageReads(messages: Messages): MessageReadRecorder {
  const used: Messages = {};
  const place = (source: object, parent: Slot, key: string): Slot => {
    return () => {
      const holder = parent();
      const existing = holder[key];
      if (isMessages(existing)) return existing;
      const container: Messages = Array.isArray(source) ? [] : {};
      holder[key] = container;
      return container;
    };
  };
  const wrap = <T extends object>(source: T, slot: Slot): T =>
    new Proxy(source, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof key !== "string" || key === "__proto__") return value;
        if (typeof value === "string") {
          slot()[key] = value;
          return value;
        }
        if (isTraversable(value)) return wrap(value, place(value, slot, key));
        return value;
      },
    });
  return { messages: wrap(messages, () => used), subset: () => used };
}

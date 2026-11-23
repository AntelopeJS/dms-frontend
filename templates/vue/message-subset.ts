/** The `<script>` the server render leaves in the document for {@link DmsMessageSubset}. */
export const SSR_MESSAGES_ID = "dms-ssr-messages";

/** What a catalog holds under a key: a message, or a group or list of them. */
export type MessageValue =
  | string
  | number
  | boolean
  | null
  | MessageValue[]
  | MessageGroup;

/** The messages of a catalog, keyed by message name or group. */
export interface MessageGroup {
  [key: string]: MessageValue;
}

/**
 * The messages a server render read from a locale's catalog, as a catalog of
 * their own, with the locale they belong to.
 */
export interface DmsMessageSubset {
  locale: string;
  messages: MessageGroup;
}

export interface MessageReadRecorder<T extends object = MessageGroup> {
  /** The catalog to give the render: every read through it is recorded. */
  messages: T;
  /** What the render read so far. */
  subset: () => MessageGroup;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isTraversable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isMessageValue(value: unknown): value is MessageValue {
  if (value === null || isText(value) || isNumber(value) || isFlag(value))
    return true;
  if (Array.isArray(value)) return value.every(isMessageValue);
  return isMessageGroup(value);
}

export function isMessageGroup(value: unknown): value is MessageGroup {
  return (
    isTraversable(value) &&
    !Array.isArray(value) &&
    Object.values(value).every(isMessageValue)
  );
}

function isMessageSubset(value: unknown): value is DmsMessageSubset {
  return (
    isTraversable(value) &&
    "locale" in value &&
    isText(value.locale) &&
    "messages" in value &&
    isMessageGroup(value.messages)
  );
}

/**
 * The subset a server render wrote into the document, or `undefined` when
 * `text` holds anything else.
 */
export function parseMessageSubset(text: string): DmsMessageSubset | undefined {
  const parsed: unknown = JSON.parse(text);
  return isMessageSubset(parsed) ? parsed : undefined;
}

/** The messages read at one place of a catalog, by the key they sit under. */
class UsedMessages {
  readonly entries = new Map<string, string | UsedMessages>();

  constructor(readonly isList: boolean) {}

  group(key: string, isList: boolean): UsedMessages {
    const existing = this.entries.get(key);
    if (existing instanceof UsedMessages) return existing;
    const created = new UsedMessages(isList);
    this.entries.set(key, created);
    return created;
  }

  toValue(): MessageValue {
    if (!this.isList) return this.toGroup();
    const list: MessageValue[] = [];
    for (const [key, entry] of this.entries)
      Reflect.set(list, key, isText(entry) ? entry : entry.toValue());
    return list;
  }

  toGroup(): MessageGroup {
    const group: MessageGroup = {};
    for (const [key, entry] of this.entries)
      group[key] = isText(entry) ? entry : entry.toValue();
    return group;
  }
}

type Slot = () => UsedMessages;

/**
 * Wraps a catalog so that the messages read through it are collected, with
 * the path they sit at, into a catalog of their own.
 *
 * A message is recorded when a string is read from the catalog, whether by a
 * lookup (`t`), an existence check (`te`) or a walk over a subtree (`tm`).
 */
export function recordMessageReads<T extends object>(
  messages: T,
): MessageReadRecorder<T> {
  const used = new UsedMessages(false);
  const place =
    (isList: boolean, parent: Slot, key: string): Slot =>
    () =>
      parent().group(key, isList);
  const wrap = <V extends object>(source: V, slot: Slot): V =>
    new Proxy(source, {
      get(target, key, receiver) {
        // oxlint-disable-next-line anti-slop/no-reflect-get -- the Proxy trap must forward the read with its receiver to keep the catalog's getter semantics
        const value: unknown = Reflect.get(target, key, receiver);
        if (!isText(key) || key === "__proto__") return value;
        if (isText(value)) {
          slot().entries.set(key, value);
          return value;
        }
        if (isTraversable(value))
          return wrap(value, place(Array.isArray(value), slot, key));
        return value;
      },
    });
  return {
    messages: wrap(messages, () => used),
    subset: () => used.toGroup(),
  };
}

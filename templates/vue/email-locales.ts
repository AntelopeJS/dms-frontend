import { readFile } from "node:fs/promises";
import supportedLocales from "./email-locales.generated.json";
import { isMessageGroup, type MessageGroup } from "./message-subset";

/**
 * Catalogs are immutable build data, shared across renders. Each Vue i18n
 * instance receives only its requested language and the English fallback.
 */
const catalogs = new Map<string, Promise<MessageGroup>>();

function parseCatalog(locale: string, content: string): MessageGroup {
  const parsed: unknown = JSON.parse(content);
  if (!isMessageGroup(parsed))
    throw new Error(`The "${locale}" catalog is not a group of messages`);
  return parsed;
}

function readCatalog(locale: string): Promise<MessageGroup> {
  let catalog = catalogs.get(locale);
  if (!catalog) {
    catalog = readFile(
      new URL(`./locales/${locale}.json`, import.meta.url),
      "utf8",
    ).then((content) => parseCatalog(locale, content));
    catalogs.set(locale, catalog);
  }
  return catalog;
}

export async function loadEmailLocaleMessages(
  locale: string,
): Promise<Record<string, MessageGroup>> {
  const fallback = await readCatalog("en");
  const normalized = locale.slice(0, 2);
  const selected =
    supportedLocales.includes(normalized) && normalized !== "en"
      ? await readCatalog(normalized)
      : fallback;
  return { en: fallback, [locale]: selected };
}

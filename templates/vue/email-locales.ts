import { readFile } from "node:fs/promises";
import supportedLocales from "./email-locales.generated.json";

type Messages = Record<string, unknown>;

// Catalogs are immutable build data, shared across renders. Each Vue i18n
// instance receives only its requested language and the English fallback.
const catalogs = new Map<string, Promise<Messages>>();

function readCatalog(locale: string): Promise<Messages> {
  let catalog = catalogs.get(locale);
  if (!catalog) {
    catalog = readFile(
      new URL(`./locales/${locale}.json`, import.meta.url),
      "utf8",
    ).then((content) => JSON.parse(content) as Messages);
    catalogs.set(locale, catalog);
  }
  return catalog;
}

export async function loadEmailLocaleMessages(
  locale: string,
): Promise<Record<string, Messages>> {
  const fallback = await readCatalog("en");
  const normalized = locale.slice(0, 2);
  const selected =
    supportedLocales.includes(normalized) && normalized !== "en"
      ? await readCatalog(normalized)
      : fallback;
  return { en: fallback, [locale]: selected };
}

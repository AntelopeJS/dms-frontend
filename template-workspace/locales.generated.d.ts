/** One locale's catalog: messages, nested by key. */
interface LocaleMessages {
  [key: string]: string | LocaleMessages;
}

/** The i18n instance a regenerated catalog is applied to. */
interface LocaleMessagesTarget {
  setLocaleMessage(locale: string, messages: LocaleMessages): void;
}

/** The locales the application has a catalog for. */
export declare const supportedLocales: string[];

/** The catalogs loaded so far, by locale. */
export declare const localeMessages: Record<string, LocaleMessages>;

/** The catalog that serves `locale`: its own, else the fallback locale's. */
export declare function catalogLocale(locale: string): string | undefined;

/** The catalog that serves `locale`, loaded once. */
export declare function loadLocaleMessages(
  locale: string,
): Promise<LocaleMessages>;

/** Development only: applies every regenerated catalog to `target`. */
export declare function syncLocaleMessages(target: LocaleMessagesTarget): void;

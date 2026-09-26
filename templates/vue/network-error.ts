import { router } from "@inertiajs/vue3";

export interface DmsNetworkErrorToast {
  id: string;
  title: string;
  description: string;
  color: "error";
}

export interface DmsNetworkErrorTranslator {
  locale: { value: string };
  t: (key: string) => string;
  te: (key: string) => boolean;
}

const NETWORK_ERROR_TOAST_ID = "dms-network-error";
const NETWORK_ERROR_KEY = "error.network";
const DEFAULT_LOCALE = "en";
// Shipped with the renderer, since no module is guaranteed to translate the
// case; a module overrides them with `error.network.title` and
// `error.network.description` in its own locale files.
const NETWORK_ERROR_MESSAGES: Record<
  string,
  Record<"title" | "description", string>
> = {
  en: {
    title: "Connection lost",
    description:
      "The server could not be reached. Check your connection and try again.",
  },
  fr: {
    title: "Connexion perdue",
    description:
      "Le serveur est injoignable. Vérifiez votre connexion et réessayez.",
  },
};

function networkErrorMessage(
  i18n: DmsNetworkErrorTranslator,
  name: "title" | "description",
): string {
  const key = `${NETWORK_ERROR_KEY}.${name}`;
  if (i18n.te(key)) return i18n.t(key);
  const locale = i18n.locale.value.slice(0, 2);
  return (NETWORK_ERROR_MESSAGES[locale] ??
    NETWORK_ERROR_MESSAGES[DEFAULT_LOCALE])[name];
}

/**
 * Tell the visitor when an Inertia visit never reached the server, instead of
 * leaving the click without effect and the failure as an uncaught rejection.
 * The current page stays as it was, so they can retry once back online.
 *
 * @returns A function removing the listener
 */
export function showNetworkErrors(
  notify: (toast: DmsNetworkErrorToast) => void,
  i18n: DmsNetworkErrorTranslator,
): () => void {
  return router.on("networkError", (event) => {
    event.preventDefault();
    notify({
      // One toast however many visits fail while the server is away.
      id: NETWORK_ERROR_TOAST_ID,
      title: networkErrorMessage(i18n, "title"),
      description: networkErrorMessage(i18n, "description"),
      color: "error",
    });
  });
}

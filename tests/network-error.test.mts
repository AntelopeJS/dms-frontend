import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  type DmsNetworkErrorToast,
  showNetworkErrors,
} from "../templates/vue/network-error.ts";

// What Inertia dispatches when a visit never got a response: a cancelable
// event whose default is to reject the visit, an uncaught error in the page.
function failVisit(): CustomEvent {
  const event = new CustomEvent("inertia:networkError", {
    cancelable: true,
    detail: { error: new Error("Network error") },
  });
  document.dispatchEvent(event);
  return event;
}

function translator(locale: string, messages: Record<string, string> = {}) {
  return {
    locale: { value: locale },
    t: (key: string) => messages[key] ?? key,
    te: (key: string) => key in messages,
  };
}

describe("network error feedback", () => {
  const globals = globalThis as Record<string, unknown>;
  let removeListener: (() => void) | undefined;

  beforeEach(() => {
    // Inertia only listens in a browser.
    globals.window = globalThis;
    globals.document = new EventTarget();
  });

  afterEach(() => {
    removeListener?.();
    delete globals.window;
    delete globals.document;
  });

  it("shows a toast and keeps the failed visit from rejecting", () => {
    const toasts: DmsNetworkErrorToast[] = [];
    removeListener = showNetworkErrors(
      (toast) => toasts.push(toast),
      translator("en-GB"),
    );
    const event = failVisit();
    assert.equal(
      event.defaultPrevented,
      true,
      "Inertia rejects the visit unless the event is canceled",
    );
    assert.deepEqual(toasts, [
      {
        id: "dms-network-error",
        title: "Connection lost",
        description:
          "The server could not be reached. Check your connection and try again.",
        color: "error",
      },
    ]);
    failVisit();
    assert.equal(
      new Set(toasts.map((toast) => toast.id)).size,
      1,
      "repeated failures update one toast instead of stacking",
    );
  });

  it("speaks the visitor's language, preferring the modules' wording", () => {
    const toasts: DmsNetworkErrorToast[] = [];
    removeListener = showNetworkErrors(
      (toast) => toasts.push(toast),
      translator("fr-FR", { "error.network.title": "Hors ligne" }),
    );
    failVisit();
    assert.equal(toasts[0].title, "Hors ligne");
    assert.equal(
      toasts[0].description,
      "Le serveur est injoignable. Vérifiez votre connexion et réessayez.",
    );
  });

  it("falls back to English for a language the renderer does not ship", () => {
    const toasts: DmsNetworkErrorToast[] = [];
    removeListener = showNetworkErrors(
      (toast) => toasts.push(toast),
      translator("de"),
    );
    failVisit();
    assert.equal(toasts[0].title, "Connection lost");
  });
});

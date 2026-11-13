import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createI18n } from "vue-i18n";
import { recordMessageReads } from "../templates/vue/message-subset.ts";

type MessageSchema = ReturnType<typeof recordMessageReads>["messages"];

const CATALOG = {
  page: {
    auth: { title: "Sign in", subtitle: "Welcome back" },
    orders: { title: "Orders" },
  },
  saas: { plans: { free: "Free", pro: "Pro" } },
  list: ["first", "second"],
};

/** The recorded catalog as an application reads it: through vue-i18n. */
function translator() {
  const recorder = recordMessageReads(CATALOG);
  const i18n = createI18n<[MessageSchema], "en">({
    legacy: false,
    locale: "en",
    missingWarn: false,
    messages: { en: recorder.messages },
  });
  return {
    recorder,
    t: (key: string) => i18n.global.t(key),
    te: (key: string) => i18n.global.te(key),
  };
}

void describe("the messages a render reads", () => {
  void it("keeps the messages read, with their siblings left out", () => {
    const { recorder, t } = translator();
    assert.equal(t("page.auth.title"), "Sign in");
    assert.deepEqual(recorder.subset(), {
      page: { auth: { title: "Sign in" } },
    });
  });

  void it("merges the messages read through the same branch, however many reads", () => {
    const { recorder, t } = translator();
    assert.equal(t("page.auth.title"), "Sign in");
    assert.equal(t("page.orders.title"), "Orders");
    assert.equal(t("page.auth.subtitle"), "Welcome back");
    assert.deepEqual(recorder.subset(), {
      page: {
        auth: { title: "Sign in", subtitle: "Welcome back" },
        orders: { title: "Orders" },
      },
    });
  });

  void it("records an existence check, and nothing for a key the catalog lacks", () => {
    const { recorder, te } = translator();
    assert.equal(te("saas.plans.pro"), true);
    assert.equal(te("saas.plans.team"), false);
    assert.deepEqual(recorder.subset(), { saas: { plans: { pro: "Pro" } } });
  });

  void it("serves the recorded messages back to a client that reads only them", () => {
    const { recorder, t } = translator();
    t("list[1]");
    t("page.auth.title");
    const client = createI18n<[MessageSchema], "en">({
      legacy: false,
      locale: "en",
      missingWarn: false,
      messages: { en: structuredClone(recorder.subset()) },
    }).global;
    assert.equal(client.t("page.auth.title"), "Sign in");
    assert.equal(client.t("list[1]"), "second");
    assert.equal(client.te("page.orders.title"), false);
  });
});

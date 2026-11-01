import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UpstreamError } from "../templates/vue/server/auth/backend.mjs";
import { BackendResponseError } from "../templates/vue/server/backend-response.mjs";
import type { JsonValue } from "./helpers/json";
import { propsForQuery } from "../templates/vue/server/page-props.mjs";

const AUTH = { signInPath: "/signin", view: () => ({}) };
const URL_OF_PAGE = new URL("http://frontend.local/articles?x=1");

function backendAnswering(answer: () => Promise<JsonValue>) {
  return { fetchJson: answer, isFrontendPage: () => Promise.resolve(false) };
}

describe("page props from the backend's page answer", () => {
  it("keeps the page an object answer describes and leaves its shared layout out", async () => {
    const backend = backendAnswering(() =>
      Promise.resolve({ componentName: "Articles", shared: { menu: [] } }),
    );
    const props = await propsForQuery(
      { path: "/a" },
      URL_OF_PAGE,
      backend,
      AUTH,
    );
    assert.deepEqual(props, {
      path: "/a",
      page: { componentName: "Articles" },
    });
  });

  it("refuses an answer that is not a page object, as the backend failing", async () => {
    for (const answer of ["abc", 5, true, null, [], ["a"]]) {
      const backend = backendAnswering(() => Promise.resolve(answer));
      await assert.rejects(
        () => propsForQuery({}, URL_OF_PAGE, backend, AUTH),
        (error: Error) => {
          assert.ok(error instanceof UpstreamError, JSON.stringify(answer));
          assert.equal(error.status, 502);
          return true;
        },
      );
    }
  });

  it("still serves a custom frontend page when the backend has none", async () => {
    const backend = {
      fetchJson: () => Promise.reject(new BackendResponseError(404, undefined)),
      isFrontendPage: () => Promise.resolve(true),
    };
    const props = await propsForQuery({}, URL_OF_PAGE, backend, AUTH);
    assert.deepEqual(props, {
      page: {
        componentName: "/articles",
        isFrontendOnly: true,
        route: {
          fullId: "articles",
          fullSlug: "/articles",
          hasAccess: false,
        },
        layout: { layout: { componentName: "DefaultLayout" } },
      },
    });
  });
});

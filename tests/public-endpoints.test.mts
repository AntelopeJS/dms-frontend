import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  allowedPublicEndpoints,
  compilePublicEndpoint,
  matchPublicEndpoint,
} from "../templates/vue/server/public-endpoints.mjs";

const WEBHOOK = {
  path: "/api/mailing/events/*/*",
  headers: ["X-Mailing-Webhook-Secret"],
};

describe("public endpoints", () => {
  it("matches the declared method and one segment per wildcard", () => {
    const endpoints = allowedPublicEndpoints("", [WEBHOOK]);
    const matched = matchPublicEndpoint(
      "POST",
      "/api/mailing/events/resend/acme",
      endpoints,
    );
    assert.equal(matched?.path, WEBHOOK.path);
    assert.deepEqual(matched?.headers, ["x-mailing-webhook-secret"]);
    assert.equal(
      matchPublicEndpoint("GET", "/api/mailing/events/resend/acme", endpoints),
      undefined,
    );
    for (const path of [
      "/api/mailing/events/resend",
      "/api/mailing/events/resend/acme/more",
      "/api/mailing/events",
      "/api/mailing/settings",
    ])
      assert.equal(matchPublicEndpoint("POST", path, endpoints), undefined);
  });

  it("takes extra endpoints from DMS_PUBLIC_ENDPOINTS", () => {
    const endpoints = allowedPublicEndpoints(
      JSON.stringify([{ path: "/api/hooks/stripe", methods: ["post", "put"] }]),
      [],
    );
    assert.ok(matchPublicEndpoint("PUT", "/api/hooks/stripe", endpoints));
    assert.deepEqual(allowedPublicEndpoints("not json", []), []);
  });

  it("drops a malformed declaration whole", () => {
    for (const entry of [
      null,
      "/api/hooks",
      { path: "/auth/login" },
      { path: "/api/../secret" },
      { path: "/api/hooks?x=1" },
      { path: "/api/hooks/**" },
      { path: "/api" },
      { path: "/api/hooks", methods: [] },
      { path: "/api/hooks", methods: ["TRACE"] },
      { path: "/api/hooks", headers: ["authorization"] },
      { path: "/api/hooks", headers: ["cookie"] },
      { path: "/api/hooks", headers: ["x-forwarded-host"] },
      { path: "/api/hooks", headers: ["x-dms-oauth-relay"] },
      { path: "/api/hooks", headers: ["x-real-ip"] },
      { path: "/api/hooks", headers: "x-secret" },
    ])
      assert.equal(
        compilePublicEndpoint(entry),
        undefined,
        JSON.stringify(entry),
      );
  });

  it("reads a literal dot in a path as a dot", () => {
    const endpoints = allowedPublicEndpoints("", [
      { path: "/api/hooks/v1.json" },
    ]);
    assert.ok(matchPublicEndpoint("POST", "/api/hooks/v1.json", endpoints));
    assert.equal(
      matchPublicEndpoint("POST", "/api/hooks/v1xjson", endpoints),
      undefined,
    );
  });
});

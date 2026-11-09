import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveServerDeclarations } from "../templates/vue/server/module-routes.mjs";
import type { DmsServerSetup } from "../templates/vue/server-module";

function resolved(setup: DmsServerSetup, manifestPaths: string[] = []) {
  const warnings: string[] = [];
  const modules = resolveServerDeclarations(
    [{ id: "site", setup }],
    (message: string) => warnings.push(message),
    [],
    manifestPaths.map((path) => ({ module: "manifest", path })),
  );
  return { modules, warnings };
}

describe("Path patterns with a * before the last segment", () => {
  it("are refused as backend proxies, with a warning naming the pattern and the allowed forms", () => {
    const { modules, warnings } = resolved(
      (server) => {
        server.registerBackendProxy("/mid/*/leaf");
        server.registerBackendProxy("/api/*/**");
        server.registerBackendProxy("/hooks/*");
      },
      ["/env/*/x"],
    );
    assert.deepEqual(
      modules.proxies.map((proxy) => proxy.path),
      ["/hooks/*"],
    );
    assert.deepEqual(warnings, [
      'Frontend module site declares the backend proxy "/mid/*/leaf", which is ignored: the pattern is not /x, /x/* or /x/**.',
      'Frontend module site declares the backend proxy "/api/*/**", which is ignored: the pattern is not /x, /x/* or /x/**.',
      'Backend module manifest declares the backend proxy "/env/*/x", which is ignored: the pattern is not /x, /x/* or /x/**.',
    ]);
  });

  it("are refused as route rules, with a warning naming the pattern and the allowed forms", () => {
    const { modules, warnings } = resolved((server) =>
      server.registerRouteRules({
        "/reports/*/print": { ssr: false },
        "/reports/*": { ssr: false },
      }),
    );
    assert.deepEqual(
      modules.rules.map((rule) => rule.pattern.pattern),
      ["/reports/*"],
    );
    assert.deepEqual(warnings, [
      'Frontend module site declares the route rule "/reports/*/print", which is ignored: the pattern is not /x, /x/* or /x/**.',
    ]);
  });

  it("are refused as sign-in exemptions, with a warning naming the pattern and the allowed forms", () => {
    const { modules, warnings } = resolved((server) =>
      server.registerAuth({ signInExempt: ["/auth/**", "/share/*/view"] }),
    );
    assert.equal(modules.auth, undefined);
    assert.deepEqual(warnings, [
      'Frontend module site registers auth hooks, which are ignored: signInExempt holds "/share/*/view", which is not /x, /x/* or /x/**.',
    ]);
  });

  it("leave /x, /x/* and /x/** sign-in exemptions as narrow as they read", () => {
    const { modules, warnings } = resolved((server) =>
      server.registerAuth({
        signInExempt: ["/auth", "/share/*", "/public/**"],
      }),
    );
    assert.deepEqual(warnings, []);
    const exempt = (pathname: string) =>
      modules.auth?.signInExempt?.some((pattern) => pattern?.test(pathname));
    assert.deepEqual(
      [
        "/auth",
        "/auth/2fa",
        "/share/a",
        "/share/a/view",
        "/public",
        "/public/a/b",
      ].map(exempt),
      [true, false, true, false, true, true],
    );
  });
});

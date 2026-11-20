import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resolveSessionSecret } from "../src/config";
import {
  readSession,
  writeSession,
} from "../templates/vue/server/auth/session.mjs";
import { requestOf, responseOf } from "./helpers/http-doubles";

const root = mkdtempSync(join(tmpdir(), "dms-dev-session-secret-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** What one `ajs dms dev` boot with DMS_SESSION_SECRET unset hands its server. */
function bootDev(workspaceDir: string): string {
  delete process.env.DMS_SESSION_SECRET;
  return resolveSessionSecret({ mode: "dev", workspaceDir });
}

function sealSession(secret: string): string {
  process.env.DMS_SESSION_SECRET = secret;
  const response = responseOf();
  writeSession(response, { accessToken: "token", persistent: true });
  return String(response.getHeader("set-cookie")).split(";", 1)[0] ?? "";
}

function openSession(secret: string, cookie: string) {
  process.env.DMS_SESSION_SECRET = secret;
  return readSession(requestOf({ headers: { cookie } }));
}

void describe("dev session secret without DMS_SESSION_SECRET", () => {
  void it("opens a session sealed before a restart of the same workspace", () => {
    const workspaceDir = join(root, "restarted");
    const cookie = sealSession(bootDev(workspaceDir));
    assert.equal(
      openSession(bootDev(workspaceDir), cookie)?.accessToken,
      "token",
    );
  });

  void it("keeps the secret owner-readable in its own workspace", () => {
    const first = join(root, "first");
    const second = join(root, "second");
    const secret = bootDev(first);
    assert.match(secret, /^[0-9a-f]{64}$/);
    assert.notEqual(bootDev(second), secret);
    if (process.platform !== "win32")
      assert.equal(
        statSync(join(first, ".session-secret")).mode & 0o777,
        0o600,
      );
  });
});

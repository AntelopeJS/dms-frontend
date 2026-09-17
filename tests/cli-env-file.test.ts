import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ENV_FILE_NAMES, loadProjectEnv } from "../src/env-file";

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "dms-env-file-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

describe("project .env loading", () => {
  it("reads .env.local before .env", () => {
    assert.deepEqual([...ENV_FILE_NAMES], [".env.local", ".env"]);
  });

  it("fills variables the environment does not define", () => {
    const cwd = project({
      ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\nDMS_SESSION_SECRET=s\n",
    });
    const env: NodeJS.ProcessEnv = {};

    const loaded = loadProjectEnv({ cwd, env });

    assert.deepEqual(loaded, [join(cwd, ".env")]);
    assert.equal(env.DMS_API_BASE_URL, "http://127.0.0.1:5010");
    assert.equal(env.DMS_SESSION_SECRET, "s");
  });

  it("lets an environment variable win over the file", () => {
    const cwd = project({ ".env": "DMS_API_BASE_URL=http://from-file\n" });
    const env: NodeJS.ProcessEnv = { DMS_API_BASE_URL: "http://from-env" };

    loadProjectEnv({ cwd, env });

    assert.equal(env.DMS_API_BASE_URL, "http://from-env");
  });

  it("treats a variable set to the empty string as set", () => {
    // Commander's `.env()` binding makes the same distinction: an exported
    // but empty variable is a deliberate "no value", not an absent one.
    const cwd = project({ ".env": "DMS_BOOTSTRAP_SECRET=from-file\n" });
    const env: NodeJS.ProcessEnv = { DMS_BOOTSTRAP_SECRET: "" };

    loadProjectEnv({ cwd, env });

    assert.equal(env.DMS_BOOTSTRAP_SECRET, "");
  });

  it("lets .env.local win over .env", () => {
    const cwd = project({
      ".env": "DMS_API_BASE_URL=http://shared\nPORT=3001\n",
      ".env.local": "DMS_API_BASE_URL=http://local\n",
    });
    const env: NodeJS.ProcessEnv = {};

    const loaded = loadProjectEnv({ cwd, env });

    assert.deepEqual(loaded, [join(cwd, ".env.local"), join(cwd, ".env")]);
    assert.equal(env.DMS_API_BASE_URL, "http://local");
    assert.equal(env.PORT, "3001");
  });

  it("is a no-op in a directory without either file", () => {
    const cwd = project({});
    const env: NodeJS.ProcessEnv = {};

    assert.deepEqual(loadProjectEnv({ cwd, env }), []);
    assert.deepEqual(env, {});
  });

  it("reports an unreadable file instead of failing the command", () => {
    const cwd = project({ ".env": "DMS_API_BASE_URL=http://kept\n" });
    // A directory named `.env.local` stands in for any read failure.
    mkdirSync(join(cwd, ".env.local"));
    const warnings: string[] = [];
    const env: NodeJS.ProcessEnv = {};

    const loaded = loadProjectEnv({
      cwd,
      env,
      onWarning: (message) => warnings.push(message),
    });

    assert.deepEqual(loaded, [join(cwd, ".env")]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Ignoring .*\.env\.local/);
    assert.equal(env.DMS_API_BASE_URL, "http://kept");
  });
});

import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  cmdVerifySource,
  parseLocalPackages,
} from "../src/commands/verify-source";
import { cmdBuild } from "../src/commands/build";
import { cmdClean } from "../src/commands/clean";
import { cmdDev } from "../src/commands/dev";
import { cmdPrepare } from "../src/commands/prepare";
import { cmdStart } from "../src/commands/start";
import {
  parseBackendUrl,
  parsePort,
  requireBackendUrl,
  resolveSessionSecret,
  UsageError,
} from "../src/config";
import {
  formatAge,
  formatReadyBlock,
  formatTimedMessage,
  showPath,
  showWorkspace,
} from "../src/output";
import { describeListenError, readyLines } from "../src/server-process";
import { memoryUi, problemText } from "./fixtures/memory-ui";

/**
 * Match a UsageError on its title and on the rest of what it prints.
 */
function usageError(title: RegExp, ...details: RegExp[]) {
  return (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.equal(err.exitCode, 2);
    assert.match(err.problem.title, title);
    for (const detail of details) assert.match(problemText(err), detail);
    return true;
  };
}

const packageJson = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);

describe("DMS CLI plugin", () => {
  it("resolves session secrets by command mode", () => {
    const generated = resolveSessionSecret("dev", undefined);
    assert.match(generated, /^[0-9a-f]{64}$/);
    assert.equal(
      resolveSessionSecret("dev", "explicit-session-secret-32-characters!!"),
      "explicit-session-secret-32-characters!!",
    );

    for (const mode of ["dev", "build", "start"] as const) {
      assert.throws(
        () => resolveSessionSecret(mode, ""),
        usageError(/DMS_SESSION_SECRET is empty/),
      );
      assert.throws(
        () => resolveSessionSecret(mode, "too-short"),
        usageError(/is too short: 9 characters, at least 32 needed/),
      );
    }
    for (const mode of ["build", "start"] as const) {
      assert.throws(
        () => resolveSessionSecret(mode, undefined),
        usageError(/DMS_SESSION_SECRET is not set/, /openssl rand -hex 32/),
      );
    }
  });

  it("accepts only http and https backend URLs", () => {
    assert.equal(
      parseBackendUrl("http://127.0.0.1:5010"),
      "http://127.0.0.1:5010",
    );
    assert.equal(
      parseBackendUrl("https://dms.example.com"),
      "https://dms.example.com",
    );
    assert.throws(
      () => parseBackendUrl("localhost:5010"),
      usageError(
        /Invalid backend URL 'localhost:5010'/,
        /-b http:\/\/localhost:5010/,
      ),
    );
    assert.throws(
      () => parseBackendUrl("ftp://dms.example.com"),
      usageError(/Invalid backend URL/, /http:\/\/ or https:\/\//),
    );
    assert.throws(() => parseBackendUrl("not a url"), UsageError);
  });

  it("accepts only ports from 0 to 65535", () => {
    assert.equal(parsePort("3001"), 3001);
    assert.equal(parsePort("0"), 0);
    assert.equal(parsePort("65535"), 65535);
    for (const value of ["abc", "65536", "70000", "3001abc", "-1", "1.5", ""]) {
      assert.throws(
        () => parsePort(value),
        usageError(/Invalid port/, /between 1 and 65535/),
      );
    }
  });

  it("publishes only the core-discoverable executable", () => {
    assert.equal(packageJson.name, "@antelopejs/dms-frontend");
    assert.deepEqual(packageJson.bin, { "ajs-dms": "./dist/index.js" });
  });

  it("requires the AntelopeJS CLI that publishes its output module", () => {
    assert.equal(
      packageJson.peerDependencies["@antelopejs/core"],
      ">=1.12.0 <2",
    );
    assert.equal(packageJson.peerDependenciesMeta, undefined);
    for (const dependency of ["figlet", "boxen", "chalk", "@types/figlet"]) {
      assert.equal(packageJson.dependencies[dependency], undefined);
      assert.equal(packageJson.devDependencies[dependency], undefined);
    }
  });

  it("requires a backend URL where nothing can discover one", () => {
    assert.equal(
      requireBackendUrl("http://127.0.0.1:5010"),
      "http://127.0.0.1:5010",
    );
    for (const value of [undefined, ""]) {
      assert.throws(
        () => requireBackendUrl(value),
        usageError(/Backend URL is required/, /→ Pass -b <url>/),
      );
    }
  });

  it("preserves the command surface", () => {
    const commands = [
      cmdDev(),
      cmdBuild(),
      cmdStart(),
      cmdPrepare(),
      cmdClean(),
    ];
    assert.deepEqual(
      commands.map((command) => command.name()),
      ["dev", "build", "start", "prepare", "clean"],
    );
  });
});

describe("verify-source CLI", () => {
  it("publishes source and local package options", () => {
    const command = cmdVerifySource().exitOverride();
    assert.equal(command.name(), "verify-source");
    assert.deepEqual(
      command.options.map((option) => option.attributeName()),
      ["layer", "module", "localPackage"],
    );
  });

  it("resolves local package bindings and rejects malformed values", () => {
    assert.deepEqual(parseLocalPackages(["@scope/package=../package"]), {
      "@scope/package": resolve("../package"),
    });
    assert.throws(
      () => parseLocalPackages(["@scope/package"]),
      usageError(/Invalid local package '@scope\/package'/, /name=path/),
    );
  });
});

/** Starts every ANSI color sequence. */
const ESC = "\x1b";

const SECRET_NOT_SET = [
  "DMS_SESSION_SECRET is not set",
  "  build and start sign sessions with it, so it must stay the same across restarts.",
  "  {hint} Create one: openssl rand -hex 32, then set it in the environment or ./.env",
];

function secretNotSet(): UsageError {
  try {
    resolveSessionSecret("build", undefined);
  } catch (err) {
    if (err instanceof UsageError) return err;
  }
  throw new Error("expected a UsageError");
}

describe("CLI output", () => {
  it("prints an error with the core symbols, on stderr only", () => {
    const output = memoryUi();
    output.ui.problem(secretNotSet().problem);
    assert.equal(output.stdout(), "");
    assert.equal(
      output.stderr(),
      `✖ ${SECRET_NOT_SET.join("\n").replace("{hint}", "→")}\n`,
    );
  });

  it("falls back to ASCII symbols", () => {
    const output = memoryUi({ isUnicode: false });
    output.ui.problem(secretNotSet().problem);
    assert.equal(
      output.stderr(),
      `x ${SECRET_NOT_SET.join("\n").replace("{hint}", ">")}\n`,
    );
  });

  it("colors only the symbols, and only when colors are on", () => {
    const colored = memoryUi({ isColored: true });
    colored.ui.problem(secretNotSet().problem);
    assert.ok(
      colored.stderr().startsWith(`${ESC}[31m✖${ESC}[39m DMS_SESSION_SECRET`),
    );
    assert.ok(colored.stderr().includes(`${ESC}[36m→${ESC}[39m Create one`));

    const plain = memoryUi({ isColored: false });
    plain.ui.problem(secretNotSet().problem);
    assert.ok(!plain.stderr().includes(ESC));
  });

  it("prints the ready block with the URLs first, labels aligned", () => {
    const output = memoryUi();
    const lines = formatReadyBlock(
      {
        title: "Dev server ready in 1.5s",
        lines: readyLines(
          { address: "0.0.0.0", port: 3002 },
          [
            { label: "Backend", value: "http://127.0.0.1:5010" },
            {
              label: "Workspace",
              value: "~/.antelopejs/dms-frontend/76672b08…",
            },
          ],
          {
            lo: [
              {
                address: "127.0.0.1",
                family: "IPv4",
                internal: true,
              } as never,
            ],
            eth0: [
              {
                address: "192.168.1.20",
                family: "IPv4",
                internal: false,
              } as never,
              { address: "fe80::1", family: "IPv6", internal: false } as never,
            ],
          },
        ),
        footer: "Watching 12 layer sources · Ctrl+C to stop",
      },
      output.ui,
    );
    assert.deepEqual(lines, [
      "✔ Dev server ready in 1.5s",
      "",
      "  ➜  Local:     http://localhost:3002/",
      "  ➜  Network:   http://192.168.1.20:3002/",
      "     Backend:   http://127.0.0.1:5010",
      "     Workspace: ~/.antelopejs/dms-frontend/76672b08…",
      "     Watching 12 layer sources · Ctrl+C to stop",
    ]);
  });

  it("shows no network URL for a server bound to one address", () => {
    const lines = readyLines({ address: "127.0.0.1", port: 3321 }, [], {
      eth0: [
        { address: "192.168.1.20", family: "IPv4", internal: false } as never,
      ],
    });
    assert.deepEqual(lines, [
      { label: "Local", value: "http://127.0.0.1:3321/", isLink: true },
    ]);
    assert.equal(
      readyLines({ address: "::1", port: 3321 }, [])[0].value,
      "http://[::1]:3321/",
    );
  });

  it("falls back to ASCII and colors only the arrows and URLs", () => {
    const ascii = memoryUi({ isUnicode: false });
    const block = {
      title: "Production server ready in 0.2s",
      lines: [
        { label: "Local", value: "http://localhost:3321/", isLink: true },
      ],
      footer: "Ctrl+C to stop",
    };
    assert.deepEqual(formatReadyBlock(block, ascii.ui), [
      "v Production server ready in 0.2s",
      "",
      "  >  Local: http://localhost:3321/",
      "     Ctrl+C to stop",
    ]);
    const colored = formatReadyBlock(block, memoryUi({ isColored: true }).ui);
    assert.ok(colored[2].includes(`${ESC}[36m➜${ESC}[39m`));
    assert.ok(
      colored[2].includes(`${ESC}[36mhttp://localhost:3321/${ESC}[39m`),
    );
  });

  it("puts the time before a running server's notices", () => {
    const output = memoryUi();
    const at = new Date(2026, 9, 3, 14, 3, 22);
    assert.equal(
      formatTimedMessage(
        "warn",
        "frontend-vue/i18n/locales/demo-en-GB.json is not a valid locale file",
        {
          details: ["Unexpected end of JSON input"],
          fixes: ["Restart ajs dms dev to apply it"],
        },
        output.ui,
        at,
      ),
      "14:03:22 ▲ frontend-vue/i18n/locales/demo-en-GB.json is not a valid locale file\n" +
        "           Unexpected end of JSON input\n" +
        "           → Restart ajs dms dev to apply it",
    );
    assert.equal(
      formatTimedMessage("success", "Fixed", {}, output.ui, at),
      "14:03:22 ✔ Fixed",
    );
  });

  it("explains why the server could not listen", () => {
    assert.deepEqual(
      describeListenError({
        code: "EADDRINUSE",
        message: "listen EADDRINUSE: address already in use 0.0.0.0:3331",
        host: "0.0.0.0",
        port: 3331,
      }),
      {
        title: "Port 3331 is already in use",
        reason: "Another process is listening on 0.0.0.0:3331.",
        fixes: ["Stop it, or pass another port: -p <port>"],
      },
    );
    assert.equal(
      describeListenError({
        code: "EADDRNOTAVAIL",
        message: "listen EADDRNOTAVAIL",
        host: "10.9.9.9",
        port: 3001,
      }).reason,
      "10.9.9.9 is not an address of this machine.",
    );
    assert.equal(
      describeListenError({
        code: "EOTHER",
        message: "listen EOTHER",
        host: "0.0.0.0",
        port: 3001,
      }).reason,
      "listen EOTHER",
    );
  });

  it("shows a workspace from ~, cut to its id on a terminal only", () => {
    const home = "/home/user";
    const id =
      "76672b089458f187ebe9586040f9b8ae79e01c9f990f5201f4475b8326d0f0ec";
    const dir = `${home}/.antelopejs/dms-frontend/${id}`;
    assert.equal(
      showWorkspace(dir, true, home),
      "~/.antelopejs/dms-frontend/76672b08…",
    );
    assert.equal(
      showWorkspace(dir, false, home),
      `~/.antelopejs/dms-frontend/${id}`,
    );
    assert.equal(showPath("/srv/app", home), "/srv/app");
    assert.equal(showPath(process.cwd(), home), ".");
  });

  it("says how old a cached manifest is", () => {
    const now = Date.parse("2026-10-03T14:00:00.000Z");
    assert.equal(formatAge("2026-10-03T13:59:30.000Z", now), "just now");
    assert.equal(formatAge("2026-10-03T13:55:00.000Z", now), "5 min ago");
    assert.equal(formatAge("2026-10-03T12:00:00.000Z", now), "2 h ago");
    assert.equal(formatAge("2026-10-02T14:00:00.000Z", now), "1 day ago");
    assert.equal(formatAge("2026-09-30T14:00:00.000Z", now), "3 days ago");
    assert.equal(formatAge("not a date", now), "not a date");
  });
});

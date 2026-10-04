import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { Command } from "commander";
import { CancelledError } from "../src/cancellation";
import { cmdVerifySource } from "../src/commands/verify-source";
import {
  assertValidUsage,
  parseLocalPackages,
  usageProblems,
} from "../src/commands/verify-source-action";
import { cmdBuild } from "../src/commands/build";
import { cmdClean } from "../src/commands/clean";
import { describeWorkspaces } from "../src/commands/clean-action";
import { cmdDev } from "../src/commands/dev";
import { cmdPrepare } from "../src/commands/prepare";
import { cmdStart } from "../src/commands/start";
import { cmdWorkspaces } from "../src/commands/workspaces";
import {
  renderWorkspaces,
  type WorkspaceRecord,
} from "../src/commands/workspaces-action";
import {
  flagOrEnv,
  parseBackendUrl,
  parsePort,
  requireBackendUrl,
  resolveSessionSecret,
  UsageError,
} from "../src/config";
import {
  ellipsis,
  formatAge,
  formatReadyBlock,
  formatSize,
  formatTimedMessage,
  joinParts,
  showPath,
  showWorkspace,
  workspaceId,
} from "../src/output";
import {
  applyHelpConventions,
  ENVIRONMENT_VARIABLES,
  formatEnvironmentHelp,
  helpWidth,
} from "../src/help";
import {
  describeListenError,
  describeStartError,
  isGuestBridge,
  readyLines,
  runServer,
} from "../src/server-process";
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
      cmdWorkspaces(),
      cmdClean(),
    ];
    assert.deepEqual(
      commands.map((command) => command.name()),
      ["dev", "build", "start", "prepare", "workspaces", "clean"],
    );
  });
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Set by the CLI for the processes it spawns, never by a user: dev mode for
 * the generated server, the verify-source runner's inputs, and the Vite and
 * Node settings of a build.
 */
const INTERNAL_VARIABLES = new Set([
  "DMS_DEV",
  "DMS_LAYER_SOURCE",
  "DMS_MODULE_SOURCES",
  "DMS_LOCAL_PACKAGES",
  "DMS_VITE_LOG_LEVEL",
  "NODE_OPTIONS",
]);

const ENV_READ =
  /process\.env\.([A-Z][A-Z0-9_]*)|\.env\("([A-Z][A-Z0-9_]*)"\)|flagOrEnv\([^,]+, "([A-Z][A-Z0-9_]*)"\)/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|mjs|js)$/.test(entry.name) ? [path] : [];
  });
}

describe("help environment", () => {
  it("lists every variable the CLI and the generated server read", () => {
    const documented = new Set(
      ENVIRONMENT_VARIABLES.flatMap(([names]) => names.split(", ")),
    );
    const read = new Set(
      [join(ROOT, "src"), join(ROOT, "templates")]
        .flatMap(sourceFiles)
        .flatMap((file) =>
          [...readFileSync(file, "utf8").matchAll(ENV_READ)].map(
            (match) => match[1] ?? match[2] ?? match[3],
          ),
        ),
    );
    assert.ok(read.has("DMS_PREPARE_STRICT"));
    const missing = [...read].filter(
      (name) => !documented.has(name) && !INTERNAL_VARIABLES.has(name),
    );
    assert.deepEqual(missing, []);
  });

  it("wraps the topic to the width it is given, between words", () => {
    for (const width of [80, 60, 40]) {
      const lines = formatEnvironmentHelp(width).split("\n");
      const over = lines.filter((line) => line.length > width);
      assert.deepEqual(over, [], `at ${width} columns`);
    }
    assert.match(
      formatEnvironmentHelp(40),
      /\n {2}DMS_AUTH_ESTABLISH_ENDPOINTS\n {6}More backend endpoints/,
    );
  });

  it("reads the terminal's width, up to 80 columns", () => {
    assert.equal(helpWidth({ isTTY: true, columns: 60 }), 60);
    assert.equal(helpWidth({ isTTY: true, columns: 200 }), 80);
    assert.equal(helpWidth({ isTTY: false, columns: 60 }), 80);
    assert.equal(helpWidth({}), 80);
  });

  it("wraps option descriptions, or puts them under the option when narrow", () => {
    const help = (width: number) => {
      const program = new Command("ajs dms").option(
        "--bootstrap-secret <secret>",
        "Credential for the backend's layer endpoints; prefer the variable",
      );
      applyHelpConventions(program);
      program.configureOutput({ getOutHelpWidth: () => width });
      return program.helpInformation();
    };
    assert.match(
      help(64),
      /\n {2}--bootstrap-secret <secret> {2}Credential for the backend's\n {31}layer endpoints; prefer the\n {31}variable\n/,
    );
    assert.match(
      help(60),
      /\n {2}--bootstrap-secret <secret>\n {6}Credential for the backend's layer endpoints; prefer\n {6}the variable\n/,
    );
    for (const width of [64, 60, 40]) {
      const over = help(width)
        .split("\n")
        .filter((line) => line.length > width);
      assert.deepEqual(over, [], `at ${width} columns`);
    }
  });

  it("reads a flag's variable as a boolean, the flag first", () => {
    const name = "DMS_TEST_FLAG";
    const saved = process.env[name];
    try {
      delete process.env[name];
      assert.equal(flagOrEnv(undefined, name), false);
      for (const value of ["1", "true", "yes", "on"]) {
        process.env[name] = value;
        assert.equal(flagOrEnv(undefined, name), true, value);
      }
      for (const value of ["", "0", "false", "No", " off "]) {
        process.env[name] = value;
        assert.equal(flagOrEnv(undefined, name), false, value);
      }
      assert.equal(flagOrEnv(true, name), true);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
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

  it("reports every usage problem of a run at once", () => {
    const options = {
      layer: "./no-such-layer",
      module: ["./no-such-module"],
      localPackage: ["foo", "@scope/package=../package"],
    };
    assert.deepEqual(
      usageProblems(options).map((problem) => problem.title),
      [
        "Layer path not found: ./no-such-layer",
        "Module path not found: ./no-such-module",
        "Invalid local package 'foo'",
      ],
    );
    assert.deepEqual(
      usageProblems({ localPackage: ["foo"] }).map((problem) => problem.title),
      [
        "Required option '-l, --layer <path>' not specified",
        "Invalid local package 'foo'",
      ],
    );

    const output = memoryUi();
    assert.throws(
      () => assertValidUsage(usageProblems(options), output.ui),
      usageError(/^Invalid local package 'foo'$/, /name=path/),
    );
    assert.equal(
      output.stderr(),
      [
        "✖ Layer path not found: ./no-such-layer",
        "  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)",
        "✖ Module path not found: ./no-such-module",
        "  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)",
        "",
      ].join("\n"),
    );
    assert.doesNotThrow(() => assertValidUsage([], output.ui));
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

  it("lists LAN addresses only, a few at most", () => {
    const ipv4 = (address: string) =>
      [{ address, family: "IPv4", internal: false }] as never;
    const network = readyLines(
      { address: "0.0.0.0", port: 3002 },
      [],
      {
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
        eth0: ipv4("192.168.1.20"),
        docker0: ipv4("172.17.0.1"),
        "br-1cd78ad94b16": ipv4("172.18.0.1"),
        veth0627d99: ipv4("172.18.0.2"),
        virbr0: ipv4("192.168.122.1"),
        "cni-podman0": ipv4("10.88.0.1"),
        "flannel.1": ipv4("10.244.0.0"),
        pelican0: ipv4("172.22.0.1"),
        eth1: ipv4("169.254.10.1"),
        tailscale0: ipv4("100.86.102.11"),
        wg0: ipv4("10.200.0.12"),
      },
      (name) => name === "pelican0",
    ).filter(({ label }) => label === "Network");
    assert.deepEqual(
      network.map(({ value }) => value),
      [
        "http://192.168.1.20:3002/",
        "http://100.86.102.11:3002/",
        "http://10.200.0.12:3002/",
      ],
    );

    const many = Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [`eth${n}`, ipv4(`192.168.${n}.20`)]),
    );
    const capped = readyLines(
      { address: "0.0.0.0", port: 3002 },
      [],
      many,
      () => false,
    ).filter(({ label }) => label === "Network");
    assert.deepEqual(
      capped.map(({ value, isLink }) => [value, Boolean(isLink)]),
      [
        ["http://192.168.1.20:3002/", true],
        ["http://192.168.2.20:3002/", true],
        ["http://192.168.3.20:3002/", true],
        ["2 more addresses", false],
      ],
    );
  });

  it("tells a container bridge from one holding the network card", () => {
    const net = mkdtempSync(join(tmpdir(), "dms-sys-class-net-"));
    const link = (name: string, ...entries: string[]) => {
      for (const entry of entries)
        mkdirSync(join(net, name, entry), { recursive: true });
    };
    link("eth0", "device");
    link("veth1");
    link("docker0", "bridge", "brif/veth1");
    link("br-empty", "bridge", "brif");
    link("br0", "bridge", "brif/eth0", "brif/veth1");
    try {
      assert.equal(isGuestBridge("docker0", net), true);
      assert.equal(isGuestBridge("br-empty", net), true);
      assert.equal(isGuestBridge("br0", net), false);
      assert.equal(isGuestBridge("eth0", net), false);
    } finally {
      rmSync(net, { recursive: true, force: true });
    }
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

  it("joins and cuts lines in ASCII where the terminal has no Unicode", () => {
    const unicode = memoryUi().ui;
    const ascii = memoryUi({ isUnicode: false }).ui;
    assert.equal(joinParts(["a", "b"], unicode), "a · b");
    assert.equal(joinParts(["a", "b"], ascii), "a - b");
    assert.equal(ellipsis(unicode), "…");
    assert.equal(ellipsis(ascii), "...");
    const home = "/home/user";
    const dir = `${home}/.antelopejs/dms-frontend/76672b089458f187ebe9586040f9b8ae`;
    assert.equal(
      showWorkspace(dir, true, home, ascii),
      "~/.antelopejs/dms-frontend/76672b08...",
    );
    const stop = new CancelledError("SIGINT", "Stopped the build", "ran 2.1s");
    assert.equal(stop.stopped, "Stopped the build");
    assert.deepEqual(stop.context, ["ran 2.1s"]);
    assert.equal(
      new CancelledError("SIGTERM", "Stopped the build").stopped,
      "Stopped the build (SIGTERM)",
    );
  });

  it("explains a Vite that could not start, at the source the user edits", () => {
    const workspace = "/home/user/.antelopejs/dms-frontend/abc";
    const mapPath = (line: string) =>
      line.replace(`${workspace}/frontend-modules/demo`, "./frontend-vue");
    assert.equal(
      problemText(
        new UsageError(
          describeStartError(
            {
              message: 'Unexpected "}"',
              location: {
                file: `${workspace}/frontend-modules/demo/dms.frontend.ts`,
                line: 4,
                column: 0,
                lineText: "};",
              },
            },
            mapPath,
          ),
        ),
      ),
      [
        "✖ Vite could not start: error in ./frontend-vue/dms.frontend.ts:4:0",
        '  Unexpected "}"',
        "  → Fix the file and run ajs dms dev again",
        "  4 | };",
        "    | ^",
        "",
      ].join("\n"),
    );
    assert.equal(
      problemText(
        new UsageError(
          describeStartError(
            {
              message: `Cannot find package '@vitejs/plugin-vue' imported from ${workspace}/vite.config.ts`,
              code: "ERR_MODULE_NOT_FOUND",
            },
            (line) =>
              line.replace(workspace, "~/.antelopejs/dms-frontend/abc…"),
          ),
        ),
      ),
      [
        "✖ Vite could not start in the dev server",
        "  Cannot find package '@vitejs/plugin-vue' imported from ~/.antelopejs/dms-frontend/abc…/vite.config.ts",
        "  → Reinstall the workspace dependencies: ajs dms dev --force",
        "",
      ].join("\n"),
    );
    assert.equal(
      problemText(
        new UsageError(describeStartError({ message: "config boom" })),
      ),
      [
        "✖ Vite could not start in the dev server",
        "  config boom",
        "  → Look for the cause in Vite's output above, then run ajs dms dev again",
        "",
      ].join("\n"),
    );
  });

  it("fails the run once when the dev server reports that Vite could not start", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-start-error-"));
    const file = join(workspace, "frontend-modules/demo/app/plugin.ts");
    const report = {
      type: "dms:start-error",
      message: "Cannot find module 'nope'",
      location: { file, line: 3, column: 7 },
    };
    writeFileSync(
      join(workspace, "server.mjs"),
      `process.send(${JSON.stringify(report)}, () => process.exit(1));\n`,
    );
    let isReady = false;
    after(() => rmSync(workspace, { recursive: true, force: true }));
    await assert.rejects(
      runServer({
        name: "dev server",
        script: "server.mjs",
        cwd: workspace,
        env: process.env,
        mapPath: (line) =>
          line.replace(join(workspace, "frontend-modules/demo"), "./demo"),
        onReady: () => (isReady = true),
      }),
      (err) => {
        assert.equal(
          problemText(err),
          [
            "✖ Vite could not start: error in ./demo/app/plugin.ts:3:7",
            "  Cannot find module 'nope'",
            "  → Fix the file and run ajs dms dev again",
            "",
          ].join("\n"),
        );
        return true;
      },
    );
    assert.equal(isReady, false);
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

  it("says how much space a workspace takes", () => {
    assert.equal(formatSize(0), "0 B");
    assert.equal(formatSize(900), "900 B");
    assert.equal(formatSize(1536), "1.5 KB");
    assert.equal(formatSize(536_870_912), "512 MB");
    assert.equal(formatSize(1_610_612_736), "1.5 GB");
  });

  it("cuts a workspace id on a terminal only", () => {
    const dir = `/home/user/.antelopejs/dms-frontend/${"a".repeat(64)}`;
    assert.equal(workspaceId(dir, true), "aaaaaaaa");
    assert.equal(workspaceId(dir, false), "a".repeat(64));
  });
});

describe("workspace listing", () => {
  const home = "/home/user/.antelopejs/dms-frontend";
  const projectId = `76672b08${"0".repeat(56)}`;
  const urlId = `f6af15c7${"1".repeat(56)}`;
  const lastUsedAt = new Date(Date.now() - 5 * 60_000).toISOString();
  const records: WorkspaceRecord[] = [
    {
      id: projectId,
      dir: `${home}/${projectId}`,
      backendUrl: "http://127.0.0.1:5010",
      key: { type: "project", path: "/srv/demo" },
      sizeBytes: 536_870_912,
      lastUsedAt,
    },
    {
      id: urlId,
      dir: `${home}/${urlId}`,
      backendUrl: "http://127.0.0.1:5011",
      key: { type: "url" },
      sizeBytes: 1536,
      lastUsedAt,
    },
  ];

  it("prints an aligned table with a header on a terminal", () => {
    const output = memoryUi({ isTerminal: true });
    renderWorkspaces(output.ui, records, true);
    assert.equal(output.stderr(), "");
    assert.deepEqual(output.stdout().split("\n"), [
      "ID        BACKEND                KEY                SIZE    LAST USED",
      "76672b08  http://127.0.0.1:5010  project /srv/demo  512 MB  5 min ago",
      "f6af15c7  http://127.0.0.1:5011  url                1.5 KB  5 min ago",
      "",
    ]);
  });

  it("prints whole, tab-separated values without a header in a pipe", () => {
    const output = memoryUi();
    renderWorkspaces(output.ui, records, false);
    assert.deepEqual(output.stdout().split("\n"), [
      [
        projectId,
        "http://127.0.0.1:5010",
        "project",
        "/srv/demo",
        "536870912",
        lastUsedAt,
        `${home}/${projectId}`,
      ].join("\t"),
      [
        urlId,
        "http://127.0.0.1:5011",
        "url",
        "",
        "1536",
        lastUsedAt,
        `${home}/${urlId}`,
      ].join("\t"),
      "",
    ]);
  });

  it("says there are none on stderr only", () => {
    const output = memoryUi();
    renderWorkspaces(output.ui, [], false);
    assert.equal(output.stdout(), "");
    assert.match(output.stderr(), /^ℹ No workspaces in /);
  });

  it("lists what clean --all removes, columns aligned", () => {
    assert.deepEqual(describeWorkspaces(records, true), [
      "76672b08  http://127.0.0.1:5010  project /srv/demo",
      "f6af15c7  http://127.0.0.1:5011  url",
    ]);
  });
});

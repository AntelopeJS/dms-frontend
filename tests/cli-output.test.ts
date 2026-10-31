import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import {
  type NetworkInterfaceInfoIPv4,
  type NetworkInterfaceInfoIPv6,
  tmpdir,
} from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSessionSecret, UsageError } from "../src/config";
import { formatReadyBlock } from "../src/output";
import { isGuestBridge, readyLines } from "../src/server-process";
import { memoryUi } from "./fixtures/memory-ui";
const ESC = "\x1b";

function interfaceIpv4(
  address: string,
  internal = false,
): NetworkInterfaceInfoIPv4 {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal,
    cidr: `${address}/24`,
  };
}

function interfaceIpv6(address: string): NetworkInterfaceInfoIPv6 {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

const SECRET_NOT_SET = [
  "DMS_SESSION_SECRET is not set",
  "  start signs sessions with it, so it must stay the same across restarts.",
  "  {hint} Create one: openssl rand -hex 32, then set it in the environment or ./.env",
];

function secretNotSet(): UsageError {
  try {
    resolveSessionSecret("start", undefined);
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
            lo: [interfaceIpv4("127.0.0.1", true)],
            eth0: [interfaceIpv4("192.168.1.20"), interfaceIpv6("fe80::1")],
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

  it("wraps the ready block to a narrow terminal, each value under itself", () => {
    const output = memoryUi();
    const block = {
      title: "Dev server ready in 1.5s",
      lines: [
        { label: "Local", value: "http://localhost:3002/", isLink: true },
        { label: "Workspace", value: "~/.antelopejs/dms-frontend/76672b08…" },
        {
          label: "Secrets",
          value:
            "DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the environment",
        },
      ],
      footer: "Watching 12 layer sources · Ctrl+C to stop",
    };
    assert.deepEqual(formatReadyBlock(block, output.ui, false, 40), [
      "✔ Dev server ready in 1.5s",
      "",
      "  ➜  Local:     http://localhost:3002/",
      "     Workspace: ~/.antelopejs/dms-frontend/76672b08…",
      "     Secrets:   DMS_HTML_RENDER_SECRET,",
      "                DMS_OAUTH_RELAY_SECRET",
      "                from the environment",
      "     Watching 12 layer sources · Ctrl+C",
      "     to stop",
    ]);
    assert.deepEqual(formatReadyBlock(block, output.ui, false, 60).slice(4), [
      "     Secrets:   DMS_HTML_RENDER_SECRET,",
      "                DMS_OAUTH_RELAY_SECRET from the environment",
      "     Watching 12 layer sources · Ctrl+C to stop",
    ]);
    assert.deepEqual(
      formatReadyBlock(block, output.ui, false, undefined).slice(4),
      [
        "     Secrets:   DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the environment",
        "     Watching 12 layer sources · Ctrl+C to stop",
      ],
      "piped: one line per value",
    );
    const colored = formatReadyBlock(
      {
        ...block,
        lines: [
          {
            ...block.lines[0],
            value: "http://a.test/ more-text",
            isEssential: true,
          },
        ],
      },
      memoryUi({ isColored: true }).ui,
      true,
      20,
    );
    assert.deepEqual(colored, [
      `  ${ESC}[36m➜${ESC}[39m  ${ESC}[2mLocal:${ESC}[22m ${ESC}[36mhttp://a.test/${ESC}[39m`,
      `            ${ESC}[36mmore-text${ESC}[39m`,
    ]);
  });

  it("keeps only the local URL of the ready block in a quiet run", () => {
    const output = memoryUi();
    const block = {
      title: "Production server ready in 120ms",
      lines: readyLines(
        { address: "0.0.0.0", port: 3321 },
        [{ label: "Workspace", value: "~/.antelopejs/dms-frontend/76672b08…" }],
        {
          eth0: [interfaceIpv4("192.168.1.20")],
        },
      ),
      footer: "Ctrl+C to stop",
    };
    assert.deepEqual(formatReadyBlock(block, output.ui, true), [
      "  ➜  Local: http://localhost:3321/",
    ]);
    assert.equal(formatReadyBlock(block, output.ui, false).length, 6);
  });

  it("prints the loopback the dev server listens on as localhost, the host the backend is told", () => {
    const local = (address: string) =>
      readyLines({ address, port: 3001 }, [], {}).find(
        (line) => line.label === "Local",
      )?.value;
    assert.equal(local("127.0.0.1"), "http://localhost:3001/");
    assert.equal(local("::1"), "http://localhost:3001/");
    assert.equal(local("192.168.1.20"), "http://192.168.1.20:3001/");
  });

  it("lists LAN addresses only, a few at most", () => {
    const ipv4 = (address: string) => [interfaceIpv4(address)];
    const network = readyLines(
      { address: "0.0.0.0", port: 3002 },
      [],
      {
        lo: [interfaceIpv4("127.0.0.1", true)],
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
      eth0: [interfaceIpv4("192.168.1.20")],
    });
    assert.deepEqual(lines, [
      {
        label: "Local",
        value: "http://localhost:3321/",
        isLink: true,
        isEssential: true,
      },
    ]);
    assert.equal(
      readyLines({ address: "::1", port: 3321 }, [])[0].value,
      "http://localhost:3321/",
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
});

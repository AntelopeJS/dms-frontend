import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { brotliCompressSync } from "node:zlib";
import {
  DEFAULT_ENTRY_WEIGHT_WARNING_KB,
  ENTRY_WEIGHT_VARIABLE,
  entryWeightThreshold,
  heavyEntryModules,
  readEntryWeight,
  reportEntryWeight,
} from "../src/entry-weight";
import { clientCodeSplitting } from "../templates/vue/client-chunking.mjs";
import {
  ENTRY_WEIGHT_FILE,
  recordEntryWeight,
} from "../templates/vue/entry-weight.mjs";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Code of about `bytes` bytes that minification cannot shrink away. */
function payload(name: string, bytes: number): string {
  const words = Array.from(
    { length: Math.ceil(bytes / 40) },
    (_, index) => `${name}-${index}-${(index * 7919) % 10007}`,
  );
  return `export const ${name} = ${JSON.stringify(words)};\n`;
}

/**
 * A workspace as the client build sees it: two frontend modules under
 * `frontend-modules/`, the entry importing both module entries. The heavy
 * module's plugin imports its gallery statically; the light one loads its
 * gallery lazily.
 */
async function buildFixture(): Promise<string> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dms-entry-weight-")));
  roots.push(root);
  const heavy = join(root, "frontend-modules", "heavy");
  const light = join(root, "frontend-modules", "light");
  write(join(heavy, "gallery.ts"), payload("heavyGallery", 60_000));
  write(
    join(heavy, "dms.frontend.ts"),
    'import { heavyGallery } from "./gallery";\nexport default { setup: () => heavyGallery.length };\n',
  );
  write(join(light, "gallery.ts"), payload("lightGallery", 60_000));
  write(
    join(light, "dms.frontend.ts"),
    'export default { setup: () => import("./gallery") };\n',
  );
  write(join(root, "runtime.ts"), payload("runtime", 20_000));
  write(
    join(root, "main.ts"),
    'import heavy from "./frontend-modules/heavy/dms.frontend";\nimport light from "./frontend-modules/light/dms.frontend";\nimport { runtime } from "./runtime";\nconsole.log(heavy, light, runtime);\n',
  );
  const modules = [
    { id: "heavy", name: "@acme/heavy", root: heavy, priority: 2 },
    { id: "light", name: "@acme/light", root: light, priority: 1 },
  ];
  // Imported here, as the other tests that run Vite from a TypeScript test
  // file do: the static import goes through the CommonJS transform.
  const { build } = await import("vite");
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [recordEntryWeight(modules)],
    build: {
      outDir: join(root, "dist", "client"),
      emptyOutDir: true,
      manifest: true,
      rolldownOptions: {
        input: join(root, "main.ts"),
        // @ts-expect-error `codeSplitting` is typed as a boolean here
        output: { codeSplitting: clientCodeSplitting },
      },
    },
  });
  return root;
}

describe("the client entry's weight by module", () => {
  it("records, from the client build, what each module's sources add to the entry", async () => {
    const root = await buildFixture();
    const recorded = JSON.parse(
      readFileSync(join(root, "dist", "client", ENTRY_WEIGHT_FILE), "utf8"),
    );
    const entrySize = recorded.files
      .map((file: string) => readFileSync(join(root, "dist", "client", file)))
      .reduce((sum: number, code: Buffer) => sum + code.length, 0);
    assert.equal(recorded.bytes, entrySize);
    // The heavy module's gallery is in the entry, the light one's is not.
    assert.ok(recorded.owners["@acme/heavy"] > 25_000);
    assert.ok((recorded.owners["@acme/light"] ?? 0) < 1_000);
    assert.ok(recorded.owners.shared > 8_000, "the rest is shared code");
    assert.deepEqual(
      readdirSync(join(root, "dist", "client", "assets")).filter((file) =>
        file.endsWith(".map"),
      ),
      [],
      "the build writes no source map",
    );

    const weight = readEntryWeight(root);
    assert.ok(weight);
    assert.equal(weight.shares[0]?.owner, "@acme/heavy");
    const brotli = recorded.files
      .map((file: string) =>
        brotliCompressSync(readFileSync(join(root, "dist", "client", file))),
      )
      .reduce((sum: number, code: Buffer) => sum + code.length, 0);
    assert.ok(Math.abs(weight.brotli - brotli) <= 16, "Brotli of the entry");
  });

  it("warns about a module above the threshold, never about shared code or translations", () => {
    const weight = {
      bytes: 900_000,
      brotli: 225_000,
      shares: [
        { owner: "shared", bytes: 500_000, brotli: 125_000 },
        { owner: "translations", bytes: 300_000, brotli: 75_000 },
        { owner: "@acme/heavy", bytes: 240_000, brotli: 60_000 },
        { owner: "@acme/light", bytes: 8_000, brotli: 2_000 },
      ],
    };
    assert.deepEqual(
      heavyEntryModules(weight, 50 * 1024).map((share) => share.owner),
      ["@acme/heavy"],
    );
    assert.deepEqual(heavyEntryModules(weight, 0), [], "0 turns it off");
  });

  it("reads the threshold from DMS_ENTRY_WEIGHT_WARNING, in KB of Brotli", () => {
    assert.equal(
      entryWeightThreshold({}),
      DEFAULT_ENTRY_WEIGHT_WARNING_KB * 1024,
    );
    assert.equal(
      entryWeightThreshold({ [ENTRY_WEIGHT_VARIABLE]: "20" }),
      20 * 1024,
    );
    assert.equal(entryWeightThreshold({ [ENTRY_WEIGHT_VARIABLE]: "0" }), 0);
    assert.throws(
      () => entryWeightThreshold({ [ENTRY_WEIGHT_VARIABLE]: "big" }),
      /DMS_ENTRY_WEIGHT_WARNING is not a size/,
    );
  });

  it("reports the entry and each module's share, and warns about the heavy one", async () => {
    const root = await buildFixture();
    const messages: { level: string; text: string; details: string[] }[] = [];
    reportEntryWeight(
      {
        message: (level, text, options) =>
          messages.push({ level, text, details: options?.details ?? [] }),
      },
      root,
      { [ENTRY_WEIGHT_VARIABLE]: "5" },
    );
    const [info, ...warnings] = messages;
    assert.equal(info?.level, "info");
    assert.match(info.text, /^Client entry .* Brotli/);
    assert.match(info.details[0] ?? "", /^@acme\/heavy {2}/);
    assert.ok(info.details.some((line) => line.startsWith("shared  ")));
    assert.deepEqual(
      warnings.map(({ level, text }) => [level, text.split(" adds ")[0]]),
      [["warn", "@acme/heavy"]],
    );
    assert.match(warnings[0]?.details.join("\n") ?? "", /defineAsyncComponent/);
  });

  it("reports nothing for a build that recorded no weight", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dms-entry-weight-")));
    roots.push(root);
    const messages: string[] = [];
    reportEntryWeight({ message: (_, text) => messages.push(text) }, root, {});
    assert.deepEqual(messages, []);
  });
});

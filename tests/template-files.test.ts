import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { describe, it } from "node:test";
import { TEMPLATE_FILES } from "../src/config";

const TEMPLATE_DIR = resolve("templates/vue");

/** How the workspace's files name another file of the workspace. */
const REFERENCES = [
  // import … from "./x", export … from "./x", import "./x"
  /(?:\bfrom|^\s*import)\s*["'](\.{1,2}\/[^"']+)["']/gm,
  // import("./x")
  /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  // new URL("./x", import.meta.url)
  /\bnew URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g,
  // resolve(import.meta.dirname, "x"), join(import.meta.dirname, "x")
  /\b(?:resolve|join)\(\s*import\.meta\.dirname\s*,\s*["']([^"']+)["']/g,
  // devServer.ssrLoadModule("/x"), <script src="/x">: from the workspace root
  /\b(?:ssrLoadModule\(|src=)\s*["'](\/[^"'/][^"']*)["']/g,
  // a Vite build's entry: build: { ssr: "x.ts" }, input: "x.ts"
  /\b(?:ssr|input)\s*:\s*["']([\w./-]+\.(?:[cm]?[jt]s|html))["']/g,
  // pnpm-workspace.yaml: patchedDependencies
  /:\s*(patches\/\S+\.patch)/g,
];

/**
 * Files the tools load by convention rather than by reference: Vite's
 * default config and client entry, the TypeScript config vue-tsc reads, the
 * pnpm files of the workspace install and the ignore file Tailwind's source
 * scan honours.
 */
const CONVENTIONAL = [
  "vite.config.ts",
  "index.html",
  "tsconfig.json",
  "pnpm-workspace.yaml",
  "npmrc",
  "gitignore",
];

/** The script commands of the workspace's package.json name files too. */
const SCRIPT_FILE = /(?:^|\s)(?:\.\/)?([\w.-]+\.(?:[cm]?[jt]s|json))(?=\s|$)/g;

const EXTENSIONS = ["", ".ts", ".mts", ".mjs", ".js", ".vue", ".json"];

/** The template file `reference` from `from` resolves to, if one exists. */
function templateFile(from: string, reference: string): string | undefined {
  const base = reference.startsWith("/")
    ? join(TEMPLATE_DIR, reference)
    : reference.startsWith(".")
      ? resolve(dirname(from), reference)
      : join(TEMPLATE_DIR, reference);
  for (const extension of EXTENSIONS) {
    const candidate = `${base}${extension}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every file under `path`, or `path` itself. */
function filesUnder(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

/** The template files the workspace receives, by their path in `templates/vue`. */
function copiedFiles(): Set<string> {
  return new Set(
    TEMPLATE_FILES.flatMap(([source]) => {
      const path = join(TEMPLATE_DIR, source);
      return existsSync(path) ? filesUnder(path) : [];
    }),
  );
}

function references(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const found = REFERENCES.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]!),
  );
  if (file.endsWith("tsconfig.json")) {
    const { files = [] } = JSON.parse(source) as { files?: string[] };
    found.push(...files);
  }
  if (file.endsWith("package.json")) {
    const { scripts = {} } = JSON.parse(source) as {
      scripts?: Record<string, string>;
    };
    for (const command of Object.values(scripts))
      for (const match of command.matchAll(SCRIPT_FILE)) found.push(match[1]!);
  }
  return found;
}

/**
 * The template files every copied file reaches, transitively, and the files
 * that reference them. A referenced file that does not exist in
 * `templates/vue` is one the workspace generates (`*.generated.*`, `dist/…`).
 */
function reachedFiles(roots: Iterable<string>): Map<string, string> {
  const reached = new Map<string, string>();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop()!;
    for (const reference of references(file)) {
      const target = templateFile(file, reference);
      if (!target || reached.has(target)) continue;
      reached.set(target, file);
      pending.push(target);
    }
  }
  return reached;
}

const relativeName = (file: string) =>
  relative(TEMPLATE_DIR, file).split(/[\\/]/).join(posix.sep);

/**
 * The template files the application loads that `copied` leaves out, each
 * with the file that loads it. package.json is written from its template
 * rather than copied.
 */
function missingFiles(copied: Set<string>): string[] {
  const roots = [
    ...CONVENTIONAL.map((name) => join(TEMPLATE_DIR, name)),
    join(TEMPLATE_DIR, "package.json"),
  ];
  return [...reachedFiles(roots)]
    .filter(([file]) => !copied.has(file) && !file.endsWith("package.json"))
    .map(
      ([file, from]) =>
        `${relativeName(file)} (loaded by ${relativeName(from)})`,
    );
}

describe("the workspace's template files", () => {
  it("copies every file of templates/vue the application loads", () => {
    const copied = copiedFiles();
    for (const name of CONVENTIONAL)
      assert.ok(
        copied.has(join(TEMPLATE_DIR, name)),
        `list ${name} in TEMPLATE_FILES (src/config.ts): the tools load it by convention`,
      );
    assert.deepEqual(
      missingFiles(copied),
      [],
      "list these files in TEMPLATE_FILES (src/config.ts): a workspace would not have them",
    );
  });

  it("finds what an entry left out of TEMPLATE_FILES leaves behind", () => {
    const copied = copiedFiles();
    const withoutOne = new Set(
      [...copied].filter((file) => relativeName(file) !== "network-error.ts"),
    );
    assert.equal(withoutOne.size, copied.size - 1);
    const missing = missingFiles(withoutOne);
    assert.ok(
      missing.some((entry) => entry.startsWith("network-error.ts ")),
      `network-error.ts left out goes unnoticed: ${JSON.stringify(missing)}`,
    );
  });
});

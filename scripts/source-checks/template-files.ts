import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { TEMPLATE_FILES } from "../../src/config";
import {
  filesUnder,
  isFile,
  isJsonObject,
  isStringList,
  type Problem,
  type SourceCheck,
  TEMPLATE_DIR,
} from "./repository";

/** How the workspace's files name another file of the workspace, by the form of the reference. */
const REFERENCES = {
  relativeImportOrExport: /(?:\bfrom|^\s*import)\s*["'](\.{1,2}\/[^"']+)["']/gm,
  dynamicImport: /\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
  urlRelativeToModule:
    /\bnew URL\(\s*["'](\.{1,2}\/[^"']+)["']\s*,\s*import\.meta\.url/g,
  pathRelativeToDirname:
    /\b(?:resolve|join)\(\s*import\.meta\.dirname\s*,\s*["']([^"']+)["']/g,
  fromWorkspaceRoot: /\b(?:ssrLoadModule\(|src=)\s*["'](\/[^"'/][^"']*)["']/g,
  buildEntry: /\b(?:ssr|input)\s*:\s*["']([\w./-]+\.(?:[cm]?[jt]s|html))["']/g,
  patchedDependency: /:\s*(patches\/\S+\.patch)/g,
};

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

const SCRIPT_FILE = /(?:^|\s)(?:\.\/)?([\w.-]+\.(?:[cm]?[jt]s|json))(?=\s|$)/g;

const EXTENSIONS = ["", ".ts", ".mts", ".mjs", ".js", ".vue", ".json"];

/** The template file `reference` from `from` resolves to, if one exists. */
function templateFile(from: string, reference: string): string | undefined {
  const base = reference.startsWith("/")
    ? join(TEMPLATE_DIR, reference)
    : reference.startsWith(".")
      ? resolve(dirname(from), reference)
      : join(TEMPLATE_DIR, reference);
  return EXTENSIONS.map((extension) => `${base}${extension}`).find(isFile);
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

/**
 * The files `file` names. A tsconfig.json names its `files`, a package.json
 * the files its scripts run; one whose field has another shape adds a problem
 * to `malformed` instead.
 */
function references(file: string, malformed: Problem[]): string[] {
  const source = readFileSync(file, "utf8");
  const found = Object.values(REFERENCES).flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1]!),
  );
  if (file.endsWith("tsconfig.json")) {
    const manifest: unknown = JSON.parse(source);
    const files =
      isJsonObject(manifest) && "files" in manifest ? manifest.files : [];
    if (isStringList(files)) found.push(...files);
    else
      malformed.push(`${relativeName(file)}: "files" is not a list of paths`);
  }
  if (file.endsWith("package.json")) {
    const manifest: unknown = JSON.parse(source);
    const scripts =
      isJsonObject(manifest) && "scripts" in manifest ? manifest.scripts : {};
    const commands = isJsonObject(scripts) ? Object.values(scripts) : undefined;
    if (isStringList(commands)) {
      for (const command of commands)
        for (const match of command.matchAll(SCRIPT_FILE))
          found.push(match[1]!);
    } else
      malformed.push(
        `${relativeName(file)}: "scripts" is not an object of commands`,
      );
  }
  return found;
}

/**
 * The template files every copied file reaches, transitively, and the files
 * that reference them. A referenced file that does not exist in
 * `templates/vue` is one the workspace generates (`*.generated.*`, `dist/...`).
 */
function reachedFiles(
  roots: Iterable<string>,
  malformed: Problem[],
): Map<string, string> {
  const reached = new Map<string, string>();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop()!;
    for (const reference of references(file, malformed)) {
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
function missingFiles(copied: Set<string>, malformed: Problem[]): string[] {
  const roots = [
    ...CONVENTIONAL.map((name) => join(TEMPLATE_DIR, name)),
    join(TEMPLATE_DIR, "package.json"),
  ];
  return [...reachedFiles(roots, malformed)]
    .filter(([file]) => !copied.has(file) && !file.endsWith("package.json"))
    .map(
      ([file, from]) =>
        `${relativeName(file)} (loaded by ${relativeName(from)})`,
    );
}

function workspaceCopiesEveryLoadedFile(): Problem[] {
  const copied = copiedFiles();
  const malformed: Problem[] = [];
  const missing = missingFiles(copied, malformed);
  return [
    ...CONVENTIONAL.filter((name) => !copied.has(join(TEMPLATE_DIR, name))).map(
      (name) =>
        `list ${name} in TEMPLATE_FILES (src/config.ts): the tools load it by convention`,
    ),
    ...missing.map(
      (entry) =>
        `list ${entry} in TEMPLATE_FILES (src/config.ts): a workspace would not have it`,
    ),
    ...malformed,
  ];
}

function theCheckFindsAFileLeftOut(): Problem[] {
  const copied = copiedFiles();
  const withoutOne = new Set(
    [...copied].filter((file) => relativeName(file) !== "network-error.ts"),
  );
  const missing = missingFiles(withoutOne, []);
  return withoutOne.size === copied.size - 1 &&
    missing.some((entry) => entry.startsWith("network-error.ts "))
    ? []
    : [
        `network-error.ts left out of TEMPLATE_FILES goes unnoticed: ${JSON.stringify(missing)}`,
      ];
}

export const TEMPLATE_FILE_CHECKS: SourceCheck[] = [
  {
    name: "the workspace copies every file of templates/vue the application loads",
    run: workspaceCopiesEveryLoadedFile,
  },
  {
    name: "the template file check finds what an entry left out of TEMPLATE_FILES",
    run: theCheckFindsAFileLeftOut,
  },
];

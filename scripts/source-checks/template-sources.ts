import { runInNewContext } from "node:vm";
import ts from "typescript";
import { normalizePath } from "vite";
import {
  expectMatch,
  expectNoMatch,
  type Problem,
  type SourceCheck,
  templateText,
} from "./repository";

const CLIENT_ENTRY = "main.ts";

/** The `await`s of `source` outside any function: its top-level awaits. */
function topLevelAwaits(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node))
      return;
    const awaited =
      ts.isAwaitExpression(node) ||
      (ts.isForOfStatement(node) && node.awaitModifier !== undefined);
    if (awaited) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());
      found.push(
        `${CLIENT_ENTRY}:${line + 1}: ${node.getText().split("\n")[0]}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Rollup never merges what an awaiting entry shares with the pages it imports dynamically. */
function entryDoesNotAwaitAtTopLevel(): Problem[] {
  const source = ts.createSourceFile(
    CLIENT_ENTRY,
    templateText(CLIENT_ENTRY),
    ts.ScriptTarget.Latest,
    true,
  );
  return topLevelAwaits(source).map(
    (await_) => `the client entry awaits at its top level, ${await_}`,
  );
}

function faviconStaysOutOfTheShell(): Problem[] {
  return expectNoMatch(
    templateText("index.html"),
    /rel="icon"/,
    'templates/vue/index.html declares rel="icon", which every page shares',
  );
}

function devStylesHandOverToVite(): Problem[] {
  const entry = templateText(CLIENT_ENTRY);
  return [
    ...expectMatch(
      entry,
      /data-dms-dev-style/,
      "main.ts lost data-dms-dev-style",
    ),
    ...expectMatch(
      entry,
      /MutationObserver/,
      "main.ts lost its MutationObserver",
    ),
    ...expectMatch(
      entry,
      /style\[data-vite-dev-id\]/,
      "main.ts no longer hands each stylesheet over to Vite",
    ),
    ...expectNoMatch(
      templateText("server", "dev-styles.mjs"),
      /"data-vite-dev-id"/,
      "server/dev-styles.mjs reuses Vite's own attribute, which makes its client adopt the tag and skip updateStyle, stranding CSS edits",
    ),
  ];
}

function iconProviderPrecedesModuleSetup(): Problem[] {
  const entry = templateText(CLIENT_ENTRY);
  const registration = entry.indexOf(
    'addAPIProvider("", sameOriginIconProvider(location.origin));',
  );
  if (registration <= 0)
    return ["main.ts does not register the same-origin icon provider"];
  return registration < entry.indexOf("await setupFrontendModules(")
    ? []
    : ["main.ts registers the icon provider after the modules set up"];
}

function viteConfigWiresTheScanners(): Problem[] {
  const config = templateText("vite.config.ts");
  return [
    ...expectMatch(
      config,
      /scan: \{\s*globInclude: iconScanGlobs\(\s*import\.meta\.dirname,\s*frontendSourceRoots,?\s*\),?\s*\}/,
      "vite.config.ts does not hand iconScanGlobs to Nuxt UI",
    ),
    ...expectMatch(
      config,
      /vue\(\{ script: \{ globalTypeFiles: \[sfcGlobalTypesFile\] \} \}\)/,
      "vite.config.ts does not hand the SFC global types to the Vue plugin",
    ),
    ...expectMatch(
      config,
      /await writeSfcGlobalTypes\(/,
      "vite.config.ts does not write the SFC global types before it compiles",
    ),
  ];
}

function clientChunkingTargetsTheBrowserBundle(): Problem[] {
  const config = templateText("vite.config.ts");
  const client = config.slice(config.indexOf("environments: {"));
  return [
    ...expectMatch(
      client,
      /client:\s*\{\s*build:\s*\{\s*rolldownOptions:\s*\{\s*output:\s*\{\s*codeSplitting: clientCodeSplitting/,
      "vite.config.ts does not apply clientCodeSplitting to the client environment",
    ),
    ...(config.match(/codeSplitting/g)?.length === 1
      ? []
      : [
          "vite.config.ts mentions codeSplitting outside the client environment",
        ]),
  ];
}

function windowsPathsAreNormalized(): Problem[] {
  const config = templateText("vite.config.ts");
  return [
    ...expectMatch(
      config,
      /\[normalizePath\(resolve\(import\.meta\.dirname, "frontend-module\.ts"\)\)\]/,
      "vite.config.ts does not normalize the frontend-module auto-import key",
    ),
    ...expectMatch(
      templateText("vite.email.config.ts"),
      /\[normalizePath\(resolve\(import\.meta\.dirname, "email-runtime\.ts"\)\)\]/,
      "vite.email.config.ts does not normalize the email-runtime auto-import key",
    ),
    ...expectMatch(
      config,
      /\]\.map\(normalizePath\);/,
      "vite.config.ts does not normalize the glob patterns handed to the scanners",
    ),
    ...expectMatch(
      templateText("frontend-build-loader.ts"),
      /normalizePath\(resolve\(root, pattern\)\)/,
      "frontend-build-loader.ts does not normalize the build globs",
    ),
  ];
}

function viteConfigsReadTheCliLogLevel(): Problem[] {
  return ["vite.config.ts", "vite.email.config.ts"].flatMap((config) => {
    const source = templateText(config);
    return [
      ...expectMatch(
        source,
        /process\.env\.DMS_VITE_LOG_LEVEL/,
        `${config} ignores DMS_VITE_LOG_LEVEL`,
      ),
      ...expectMatch(
        source,
        /^ {2}logLevel,$/m,
        `${config} does not pass logLevel to Vite`,
      ),
    ];
  });
}

function templateDeclaresInertia(): Problem[] {
  return expectMatch(
    templateText("package.json"),
    /@inertiajs\/vue3/,
    "templates/vue/package.json does not declare @inertiajs/vue3",
  );
}

function isStringList(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const entry of value) if (typeof entry !== "string") return false;
  return true;
}

/**
 * An empty crawl makes a cold page re-run the optimizer mid-request, which
 * answers 504 and forces a reload; the expression runs with the directory
 * under a plain name, since `import.meta` is not valid outside a module.
 */
function optimizerCrawlsEveryModule(): Problem[] {
  const template = templateText("vite.config.ts");
  const expression = template.match(
    /const optimizerEntries = ([\s\S]*?\n\][^;]*);/,
  );
  if (!expression)
    return ["vite.config.ts does not compute the optimizer's entry points"];
  const entries: unknown = runInNewContext(
    `(${expression[1]!.replaceAll("import.meta.dirname", "dirname")})`,
    {
      dirname: "/workspace",
      normalizePath,
      resolve: (...parts: string[]) => parts.join("/"),
      moduleRoots: ["/workspace/frontend-modules/core"],
      frontendSourceRoots: ["/workspace/frontend-modules/core/layers/ui"],
    },
  );
  if (!isStringList(entries))
    return [
      "vite.config.ts computes optimizer entry points that are not a list of paths",
    ];
  return [
    ...(entries.includes("/workspace/frontend-modules/core/dms.frontend.ts")
      ? []
      : ["the optimizer does not crawl each module's entry at startup"]),
    ...(entries.some((entry) => entry.endsWith("layers/ui/app/**/*.vue"))
      ? []
      : [
          "the optimizer does not crawl the sources a module's entry reaches, which carry its own dependencies",
        ]),
    ...expectNoMatch(
      template,
      /entries: \[\]/,
      "vite.config.ts empties the optimizer crawl, which makes a cold page re-run the optimizer mid-request, answer 504 and force a reload",
    ),
  ];
}

export const TEMPLATE_SOURCE_CHECKS: SourceCheck[] = [
  {
    name: "the client entry does not await at its top level",
    run: entryDoesNotAwaitAtTopLevel,
  },
  {
    name: "the favicon placeholder stays out of the shared template",
    run: faviconStaysOutOfTheShell,
  },
  {
    name: "each dev stylesheet is handed over to Vite",
    run: devStylesHandOverToVite,
  },
  {
    name: "the icon provider is registered before any module sets up",
    run: iconProviderPrecedesModuleSetup,
  },
  {
    name: "the Vite config wires the scanners and the SFC global types",
    run: viteConfigWiresTheScanners,
  },
  {
    name: "client chunking applies to the browser bundle only",
    run: clientChunkingTargetsTheBrowserBundle,
  },
  {
    name: "Windows paths are normalized in the Vite configs",
    run: windowsPathsAreNormalized,
  },
  {
    name: "the Vite configs let the CLI set the log level",
    run: viteConfigsReadTheCliLogLevel,
  },
  {
    name: "the workspace template declares the Inertia adapter",
    run: templateDeclaresInertia,
  },
  {
    name: "the optimizer crawls every materialized module",
    run: optimizerCrawlsEveryModule,
  },
];

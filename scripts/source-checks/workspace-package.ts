import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILD_STEPS } from "../../src/commands/build-action";
import {
  expectMatch,
  type Problem,
  ROOT,
  type SourceCheck,
  TEMPLATE_DIR,
  templateText,
} from "./repository";

interface WorkspaceManifest {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

function workspaceManifest(): WorkspaceManifest {
  return JSON.parse(templateText("package.json"));
}

const DECLARED_PATCH = /^\s+"[^"]+":\s*(patches\/\S+)$/gm;
const PINNED_PATCH = /^\s+"(@?[^@"]+)@([^"]+)":\s*patches\/\S+$/gm;

/** Every patch file the workspace declares. */
function declaredPatches(): string[] {
  return [...templateText("pnpm-workspace.yaml").matchAll(DECLARED_PATCH)].map(
    ([, patch]) => patch!,
  );
}

/** The `[name, version]` of every dependency the workspace patches. */
function patchedDependencies(): [string, string][] {
  return [...templateText("pnpm-workspace.yaml").matchAll(PINNED_PATCH)].map(
    ([, name, version]) => [name!, version!],
  );
}

function everyShippedPatchIsDeclared(): Problem[] {
  const shipped = readdirSync(join(TEMPLATE_DIR, "patches"))
    .map((name) => `patches/${name}`)
    .sort();
  const declared = declaredPatches().sort();
  if (shipped.length === 0) return ["templates/vue/patches ships no patch"];
  return JSON.stringify(declared) === JSON.stringify(shipped)
    ? []
    : [
        `templates/vue/pnpm-workspace.yaml declares ${JSON.stringify(declared)}, templates/vue/patches ships ${JSON.stringify(shipped)}`,
      ];
}

/** A range would let a fresh install resolve a newer release, which pnpm refuses when the patch loses its target. */
function everyPatchedDependencyIsPinned(): Problem[] {
  const patched = patchedDependencies();
  if (patched.length === 0)
    return ["templates/vue/pnpm-workspace.yaml declares no patch"];
  const { dependencies } = workspaceManifest();
  return patched.flatMap(([name, version]) =>
    dependencies[name] === version
      ? []
      : [
          `templates/vue/package.json has ${name} at ${dependencies[name]}, its patch targets ${version}`,
        ],
  );
}

function vueuseMatchesTheInstalledPatchTarget(): Problem[] {
  const installed: { version: string } = JSON.parse(
    readFileSync(
      join(ROOT, "node_modules", "@vueuse", "core", "package.json"),
      "utf8",
    ),
  );
  const pinned = workspaceManifest().dependencies["@vueuse/core"];
  return [
    ...(pinned === installed.version
      ? []
      : [
          `templates/vue/package.json pins @vueuse/core ${pinned}, the installed version is ${installed.version}`,
        ]),
    ...expectMatch(
      templateText("pnpm-workspace.yaml"),
      new RegExp(
        `"@vueuse/core@${installed.version}": patches/@vueuse__core@${installed.version}\\.patch`,
      ),
      `templates/vue/pnpm-workspace.yaml does not patch @vueuse/core@${installed.version}`,
    ),
  ];
}

function buildScriptRunsTheBuildSteps(): Problem[] {
  const { scripts } = workspaceManifest();
  const chained = BUILD_STEPS.map((step) => scripts[step.script]).join(" && ");
  return chained === scripts["build"]
    ? []
    : [
        `templates/vue/package.json build is ${JSON.stringify(scripts["build"])}, the CLI runs ${JSON.stringify(chained)}`,
      ];
}

export const WORKSPACE_PACKAGE_CHECKS: SourceCheck[] = [
  {
    name: "every shipped renderer patch is declared",
    run: everyShippedPatchIsDeclared,
  },
  {
    name: "every patched dependency is pinned to its patch target",
    run: everyPatchedDependencyIsPinned,
  },
  {
    name: "the @vueuse/core patch targets the installed version",
    run: vueuseMatchesTheInstalledPatchTarget,
  },
  {
    name: "the workspace build script runs the CLI's build steps in order",
    run: buildScriptRunsTheBuildSteps,
  },
];

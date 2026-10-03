// Builds and type-checks unpublished frontend packages in a temporary
// workspace, one task per check. Started by `ajs dms verify-source`, it sends
// its result over IPC for the CLI to report; run on its own (`pnpm
// test:real-source`), it reports the result itself.

import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  CliError,
  type CliProblem,
  getProcessTasks,
  isVerboseRun,
  pluralize,
  runWithErrorBoundary,
  getProcessUi,
} from "@antelopejs/core/cli";
import {
  createPathMapper,
  describeChildFailure,
  type PathMapper,
} from "./child-output";
import { BUILD_STEPS, buildStepFailure } from "./commands/build-action";
import {
  assertLayersSupportRenderer,
  CancelledError,
  createFrontendModuleRegistry,
  getPackageRoot,
  installDeps,
  materializeLayers,
  type ResolvedLayer,
  runFramedCommand,
  UsageError,
  writeFrontendModuleRegistry,
  writeWorkspacePackageJson,
} from "./common";
import { formatSize, reportStopped, showPath, writeHeader } from "./output";
import { createTemporaryWorkspace } from "./temporary-workspace";
import {
  describeTypeCheckErrors,
  parseTypeCheckOutput,
} from "./typecheck-output";
import {
  LAYER_PATH_FIX,
  reportVerification,
  type VerificationResult,
  VERIFY_SOURCE_COMMAND,
} from "./verify-source-result";
import {
  reportViteWarnings,
  VITE_LOG_LEVEL_VARIABLE,
  viteLogLevel,
  ViteWarnings,
} from "./vite-output";

interface LayerPackage {
  name?: string;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

interface VerificationContext {
  workspace: string;
  env: NodeJS.ProcessEnv;
  mapLine: PathMapper;
  warnings: ViteWarnings;
  isVerbose: boolean;
}

const EMAIL_BUILD_SIZE_CEILING_BYTES = 256 * 1024;
const NON_EMAIL_RUNTIME_PATTERN =
  /DisplayRichText|ApexCharts|Tiptap|FlowCanvas|app\/.*table|components\/table/i;
const LAZY_LIBRARIES = [
  { name: "ApexCharts", pattern: /ApexCharts/ },
  { name: "Tiptap", pattern: /tiptap/i },
];
const RUNTIME_MARKERS = ["auth/login", "DefaultLayout", "error.500.title"];

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Fails the running check with `title` unless `condition` holds. */
function ensure(
  condition: unknown,
  title: string,
  reason?: string,
): asserts condition {
  if (!condition) throw new CliError({ title, reason });
}

// ============================================================================
// Sources
// ============================================================================

function readLayer(root: string): ResolvedLayer {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath))
    throw new UsageError({
      title: `No package.json in ${showPath(root)}`,
      fixes: [LAYER_PATH_FIX],
    });
  const { name } = readJson(packagePath) as LayerPackage;
  return { path: root, sourcePath: root, packageName: name };
}

/**
 * The packages to verify: the one at DMS_LAYER_SOURCE, or each directory in
 * it, then those of DMS_MODULE_SOURCES.
 */
function readSources(): ResolvedLayer[] {
  const layerSource = process.env.DMS_LAYER_SOURCE;
  if (!layerSource)
    throw new UsageError({
      title: "DMS_LAYER_SOURCE is not set",
      fixes: [
        `Set it to the root of a DMS frontend package, or run ${VERIFY_SOURCE_COMMAND} -l <path>`,
      ],
    });
  const sourceRoot = resolve(layerSource);
  if (!statSync(sourceRoot, { throwIfNoEntry: false })?.isDirectory())
    throw new UsageError({
      title: `Layer path not found: ${showPath(sourceRoot)}`,
      fixes: [LAYER_PATH_FIX],
    });
  const extraSources = JSON.parse(
    process.env.DMS_MODULE_SOURCES ?? "[]",
  ) as string[];
  const layerRoots = existsSync(join(sourceRoot, "dms.frontend.ts"))
    ? [sourceRoot]
    : readdirSync(sourceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(sourceRoot, entry.name));
  if (layerRoots.length === 0)
    throw new UsageError({
      title: `No frontend package in ${showPath(sourceRoot)}`,
      fixes: [LAYER_PATH_FIX],
    });
  return [...layerRoots, ...extraSources.map((root) => resolve(root))].map(
    readLayer,
  );
}

// ============================================================================
// Workspace
// ============================================================================

function removeDevelopmentDependencies(root: string): void {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return;
  const packageData = readJson(packagePath) as LayerPackage;
  delete packageData.devDependencies;
  writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
}

function materializeWorkspace(workspace: string, layers: ResolvedLayer[]) {
  const templateRoot = join(getPackageRoot(), "templates", "vue");
  const templateFiles = readdirSync(templateRoot).filter(
    (file) => !file.startsWith("npmrc"),
  );
  for (const file of templateFiles)
    cpSync(join(templateRoot, file), join(workspace, file), {
      recursive: true,
    });
  materializeLayers(workspace, layers);
  const registry = createFrontendModuleRegistry(workspace, layers);
  registry.modules.forEach((module) => {
    removeDevelopmentDependencies(module.root);
  });
  writeFrontendModuleRegistry(workspace, layers);
  writeFileSync(
    join(workspace, "dms-main.css"),
    '@import "tailwindcss";\n@import "@nuxt/ui";\n',
  );
  writeWorkspacePackageJson(workspace, layers);
  const packagePath = join(workspace, "package.json");
  const workspacePackage = readJson(packagePath) as LayerPackage;
  const localPackages = JSON.parse(
    process.env.DMS_LOCAL_PACKAGES ?? "{}",
  ) as Record<string, string>;
  workspacePackage.pnpm = {
    overrides: {
      ...Object.fromEntries(
        layers.map((layer) => [layer.packageName, "workspace:*"]),
      ),
      ...Object.fromEntries(
        Object.entries(localPackages).map(([name, path]) => [
          name,
          `link:${resolve(path)}`,
        ]),
      ),
    },
  };
  writeFileSync(packagePath, `${JSON.stringify(workspacePackage, null, 2)}\n`);
}

// ============================================================================
// Checks
// ============================================================================

async function buildBundles(context: VerificationContext): Promise<void> {
  const [firstStep] = BUILD_STEPS;
  await getProcessTasks().run(
    firstStep.running,
    async (task) => {
      for (const step of BUILD_STEPS) {
        task.update(step.running);
        // --silent drops pnpm's script echo and its ELIFECYCLE line: the
        // failure is reported here.
        const result = await runFramedCommand(
          "pnpm",
          ["--silent", "run", step.script],
          {
            name: step.name,
            cwd: context.workspace,
            env: context.env,
            mapLine: context.mapLine,
            onLine: (line) => context.warnings.read(line),
          },
        );
        if (result.code !== 0) {
          task.fail(step.failed);
          throw buildStepFailure(
            step,
            result,
            context.isVerbose,
            VERIFY_SOURCE_COMMAND,
          );
        }
      }
    },
    { done: "Built client, SSR and e-mail bundles" },
  );
  reportViteWarnings(context.warnings, context.isVerbose, getProcessUi());
}

/**
 * The client bundle keeps the heavy libraries out of the main chunk, and
 * still reaches them and the pages every DMS serves.
 */
function checkClientBundle(workspace: string): void {
  const clientRoot = join(workspace, "dist", "client");
  const manifest = readJson(
    join(clientRoot, ".vite", "manifest.json"),
  ) as Record<string, { file: string; isEntry?: boolean }>;
  const mainEntry = Object.values(manifest).find((entry) => entry.isEntry);
  ensure(mainEntry, "The Vite manifest names no entry chunk");
  const mainJavascript = readFileSync(join(clientRoot, mainEntry.file), "utf8");
  const javascript = readdirSync(join(clientRoot, "assets"))
    .filter((file) => file.endsWith(".js"))
    .map((file) => readFileSync(join(clientRoot, "assets", file), "utf8"))
    .join("\n");
  for (const { name, pattern } of LAZY_LIBRARIES) {
    ensure(
      !pattern.test(mainJavascript),
      `The main chunk bundles ${name}`,
      "It must stay in a lazily loaded chunk.",
    );
    ensure(pattern.test(javascript), `No client chunk bundles ${name}`);
  }
  ensure(
    Object.keys(manifest).some((source) => source.endsWith("/kpi/KpiCard.vue")),
    "DmsKpiCard is not reachable at runtime",
  );
  for (const marker of RUNTIME_MARKERS)
    ensure(
      javascript.includes(marker),
      `${marker} is not reachable at runtime`,
    );
}

async function typeCheck(context: VerificationContext): Promise<void> {
  const typecheckArguments = [
    "--import",
    "./typecheck-loader.mjs",
    "./node_modules/vue-tsc/bin/vue-tsc.js",
    "--noEmit",
    "--pretty",
  ];
  const isWindows = process.platform === "win32";
  const command = isWindows ? process.execPath : "env";
  const commandArguments = isWindows
    ? typecheckArguments
    : ["-u", "NODE_OPTIONS", process.execPath, ...typecheckArguments];
  await getProcessTasks().run(
    "Type checking",
    async (task) => {
      const result = await runFramedCommand(command, commandArguments, {
        name: "vue-tsc",
        cwd: context.workspace,
        mapLine: context.mapLine,
      });
      if (result.code === 0) return;
      const report = parseTypeCheckOutput(result.lines);
      const count =
        report.count > 0 ? ` · ${pluralize(report.count, "error")}` : "";
      task.fail(`Type check failed${count}`);
      throw new CliError(
        describeTypeCheckErrors(report, VERIFY_SOURCE_COMMAND) ??
          describeChildFailure({
            title: "Type check failed",
            command: "vue-tsc --noEmit",
            code: result.code,
            lines: result.lines,
            isVerbose: context.isVerbose,
          }),
      );
    },
    { done: "Type check passed" },
  );
}

interface EmailCase {
  name: string;
  props: Record<string, unknown>;
  marker: string;
}

const EMAIL_CASES: EmailCase[] = [
  {
    name: "EmailAdminInvite",
    props: {
      userName: "Ada",
      signupLink: "https://example.test/join",
      expiresIn: "1 hour",
    },
    marker: "Ada",
  },
  {
    name: "EmailExportReady",
    props: {
      userName: "Ada",
      downloadLink: "https://example.test/export",
      fileName: "users.csv",
      fileSize: "1 KB",
      expiresIn: "1 hour",
    },
    marker: "users.csv",
  },
  {
    name: "EmailResetPassword",
    props: { userName: "Ada", resetCode: "123456", expiresIn: "1 hour" },
    marker: "123456",
  },
  {
    name: "EmailTwoFactor",
    props: { userName: "Ada", verificationCode: "654321" },
    marker: "654321",
  },
  {
    name: "EmailUserValidation",
    props: { userName: "Ada", validationCode: "112233", expiresIn: "1 hour" },
    marker: "112233",
  },
  {
    name: "EmailButton",
    props: { href: "https://example.test", expiresIn: "1 hour" },
    marker: "https://example.test",
  },
  {
    name: "EmailLayout",
    props: { title: "Contract title" },
    marker: "Contract title",
  },
  {
    name: "EmailOTP",
    props: { code: "445566", expiresIn: "1 hour" },
    marker: "445566",
  },
];

const BROWSER_ONLY_REASON =
  "It must not load rich text, charts, tables or flows.";

function checkLayoutEmail(html: string): void {
  ensure(
    /<meta charset="utf-8"/.test(html),
    "EmailLayout declares no UTF-8 charset",
  );
  ensure(
    /images\/antelope-logo\/light\.svg/.test(html),
    "EmailLayout renders no logo",
  );
  ensure(
    !/<h1[^>]*\bas=/.test(html),
    "EmailLayout leaks an `as` attribute onto its heading",
  );
}

/**
 * The e-mail bundle stays small and free of browser-only modules, and renders
 * every DMS template with the props the backend sends. Returns the line the
 * task ends on.
 */
async function checkEmailContracts(workspace: string): Promise<string> {
  const emailRoot = join(workspace, "dist", "server");
  const emailManifestContent = readFileSync(
    join(emailRoot, ".vite", "manifest.json"),
    "utf8",
  );
  ensure(
    !NON_EMAIL_RUNTIME_PATTERN.test(emailManifestContent),
    "The e-mail manifest references browser-only modules",
    BROWSER_ONLY_REASON,
  );
  const emailManifest = JSON.parse(emailManifestContent) as Record<
    string,
    { file: string }
  >;
  const emailJavascriptFiles = [
    ...new Set([
      "email-renderer.js",
      ...Object.values(emailManifest)
        .map((entry) => entry.file)
        .filter((file) => file.endsWith(".js")),
    ]),
  ];
  const emailJavascript = emailJavascriptFiles
    .map((file) => readFileSync(join(emailRoot, file), "utf8"))
    .join("\n");
  ensure(
    !NON_EMAIL_RUNTIME_PATTERN.test(emailJavascript),
    "The e-mail bundle loads browser-only modules",
    BROWSER_ONLY_REASON,
  );
  const emailBuildSize = Buffer.byteLength(emailJavascript);
  const emailLocaleBytes = readdirSync(join(emailRoot, "locales")).reduce(
    (total, file) =>
      total + readFileSync(join(emailRoot, "locales", file)).byteLength,
    0,
  );
  const limit = formatSize(EMAIL_BUILD_SIZE_CEILING_BYTES);
  ensure(
    emailBuildSize <= EMAIL_BUILD_SIZE_CEILING_BYTES,
    `The e-mail bundle is ${formatSize(emailBuildSize)} of JavaScript`,
    `The limit is ${limit}.`,
  );
  const { renderEmail } = await import(join(emailRoot, "email-renderer.js"));
  for (const emailCase of EMAIL_CASES) {
    const html: string = await renderEmail(emailCase.name, emailCase.props);
    ensure(
      html.startsWith("<!doctype html>"),
      `${emailCase.name} does not render a full HTML document`,
    );
    if (emailCase.name === "EmailLayout") checkLayoutEmail(html);
    ensure(
      html.includes(emailCase.marker),
      `${emailCase.name} does not render its props`,
      `Its HTML lacks ${emailCase.marker}.`,
    );
  }
  return [
    "E-mail contracts hold",
    pluralize(EMAIL_CASES.length, "template"),
    `${formatSize(emailBuildSize)} JS (limit ${limit})`,
    `${formatSize(emailLocaleBytes)} locale data`,
  ].join(" · ");
}

// ============================================================================
// Run
// ============================================================================

const LINE_BREAK = /\r?\n/;
const STACK_TRACE_HINT = "Run with --verbose for the full trace.";

/**
 * A failure as the result carries it: a check's own problem, or the first
 * line of an unexpected error, with its stack trace in a verbose run.
 */
function describeError(error: unknown, isVerbose: boolean): CliProblem {
  if (error instanceof CliError) return error.problem;
  if (!(error instanceof Error)) return { title: String(error) };
  const [title] = error.message.split(LINE_BREAK);
  const stack = (error.stack ?? "").split(LINE_BREAK);
  return {
    title: title || error.name,
    details: isVerbose ? stack : [STACK_TRACE_HINT],
  };
}

async function verifySources(): Promise<VerificationResult> {
  const layers = readSources();
  writeHeader("verify-source", [pluralize(layers.length, "module")]);
  // Before the first task, so its notice does not land inside one.
  assertLayersSupportRenderer(layers);
  const workspace = createTemporaryWorkspace("dms-frontend-real-source-");
  const isVerbose = isVerboseRun();
  const context: VerificationContext = {
    workspace,
    isVerbose,
    mapLine: createPathMapper(workspace, layers),
    warnings: new ViteWarnings(),
    env: { ...process.env, [VITE_LOG_LEVEL_VARIABLE]: viteLogLevel(isVerbose) },
  };
  const tasks = getProcessTasks();
  await tasks.run(
    `Materializing ${pluralize(layers.length, "module")}`,
    async () => materializeWorkspace(workspace, layers),
    { done: `Materialized ${pluralize(layers.length, "module")}` },
  );
  await installDeps(workspace, context.mapLine, ["--ignore-scripts"]);
  await buildBundles(context);
  await tasks.run(
    "Checking the client bundle",
    async () => checkClientBundle(workspace),
    { done: "Client bundle checked", failed: "Client bundle check failed" },
  );
  await typeCheck(context);
  await tasks.run(
    "Checking the e-mail contracts",
    async () => checkEmailContracts(workspace),
    { done: (line) => line, failed: "E-mail contracts failed" },
  );
  return { ok: true, modules: layers.length };
}

function sendResult(result: VerificationResult): Promise<void> {
  return new Promise((settle) => {
    process.send?.(result, undefined, undefined, () => settle());
  });
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  // The workspace tools run on their own Node options, not on those this
  // runner was started with.
  delete process.env.NODE_OPTIONS;
  let result: VerificationResult;
  try {
    result = await verifySources();
  } catch (error) {
    if (error instanceof CancelledError) {
      // Started by the CLI, the CLI reports the stop itself.
      if (!process.send) reportStopped(error.message, error.signal);
      process.exitCode = error.exitCode;
      return;
    }
    result = { ok: false, problem: describeError(error, isVerboseRun()) };
  }
  if (process.send) {
    process.exitCode = result.ok ? 0 : 1;
    await sendResult(result);
    return;
  }
  reportVerification(result, Date.now() - startedAt);
}

void runWithErrorBoundary(main, { verbose: isVerboseRun() }).then(() => {
  if (process.connected) process.disconnect();
});

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  createFrontendModuleRegistry,
  getPackageRoot,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
  writeWorkspacePackageJson,
} from "./common";
import { createTemporaryWorkspace } from "./temporary-workspace";

interface LayerPackage {
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

function removeDevelopmentDependencies(root: string): void {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return;
  const packageData = JSON.parse(
    readFileSync(packagePath, "utf8"),
  ) as LayerPackage;
  delete packageData.devDependencies;
  writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
}

if (!process.env.DMS_LAYER_SOURCE)
  throw new Error("DMS_LAYER_SOURCE must identify a frontend package");
const sourceRoot = resolve(process.env.DMS_LAYER_SOURCE);
const workspace = createTemporaryWorkspace("dms-frontend-real-source-");
const templateRoot = join(getPackageRoot(), "templates", "vue");
const commandEnvironment = { ...process.env };
const EMAIL_BUILD_SIZE_CEILING_BYTES = 256 * 1024;
const NON_EMAIL_RUNTIME_PATTERN =
  /DisplayRichText|ApexCharts|Tiptap|FlowCanvas|app\/.*table|components\/table/i;
delete commandEnvironment.NODE_OPTIONS;
const templateFiles = readdirSync(templateRoot).filter(
  (file) => !file.startsWith("npmrc"),
);
for (const file of templateFiles)
  cpSync(join(templateRoot, file), join(workspace, file), { recursive: true });

const extraSources = JSON.parse(
  process.env.DMS_MODULE_SOURCES ?? "[]",
) as string[];
const roots = [
  ...(existsSync(join(sourceRoot, "dms.frontend.ts"))
    ? [sourceRoot]
    : readdirSync(sourceRoot).map((directory) => join(sourceRoot, directory))),
  ...extraSources.map((root) => resolve(root)),
];
const layers: ResolvedLayer[] = roots.map((root) => ({
  path: root,
  packageName: JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    .name,
}));
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
const workspacePackage = JSON.parse(readFileSync(packagePath, "utf8"));
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
process.stdout.write(`Generated workspace: ${workspace}\n`);

execFileSync("pnpm", ["install", "--ignore-scripts"], {
  cwd: workspace,
  env: commandEnvironment,
  stdio: "inherit",
});
execFileSync("pnpm", ["run", "build"], {
  cwd: workspace,
  env: commandEnvironment,
  stdio: "inherit",
});
const typecheckArguments = [
  "--import",
  "./typecheck-loader.mjs",
  "./node_modules/vue-tsc/bin/vue-tsc.js",
  "--noEmit",
];
const typecheckCommand =
  process.platform === "win32" ? process.execPath : "env";
const typecheckCommandArguments =
  process.platform === "win32"
    ? typecheckArguments
    : ["-u", "NODE_OPTIONS", process.execPath, ...typecheckArguments];
execFileSync(typecheckCommand, typecheckCommandArguments, {
  cwd: workspace,
  env: commandEnvironment,
  stdio: "inherit",
});
const clientRoot = join(workspace, "dist", "client");
const manifest = JSON.parse(
  readFileSync(join(clientRoot, ".vite", "manifest.json"), "utf8"),
) as Record<string, { file: string; isEntry?: boolean }>;
const mainEntry = Object.values(manifest).find((entry) => entry.isEntry);
assert.ok(mainEntry, "Vite manifest must identify the main entry");
const mainJavascript = readFileSync(join(clientRoot, mainEntry.file), "utf8");
const javascript = readdirSync(join(clientRoot, "assets"))
  .filter((file) => file.endsWith(".js"))
  .map((file) => readFileSync(join(clientRoot, "assets", file), "utf8"))
  .join("\n");
assert.ok(
  Object.keys(manifest).length > 0,
  "Vite manifest must contain reachable entries",
);
assert.doesNotMatch(mainJavascript, /ApexCharts|tiptap/i);
assert.match(javascript, /ApexCharts/);
assert.match(javascript, /tiptap/i);
assert.ok(
  Object.keys(manifest).some((source) => source.endsWith("/kpi/KpiCard.vue")),
  "DmsKpiCard must be reachable at runtime",
);

const emailRoot = join(workspace, "dist", "server");
const emailManifestContent = readFileSync(
  join(emailRoot, ".vite", "manifest.json"),
  "utf8",
);
assert.doesNotMatch(emailManifestContent, NON_EMAIL_RUNTIME_PATTERN);
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
assert.doesNotMatch(emailJavascript, NON_EMAIL_RUNTIME_PATTERN);
const emailBuildSize = Buffer.byteLength(emailJavascript);
const emailLocaleBytes = readdirSync(join(emailRoot, "locales")).reduce(
  (total, file) =>
    total + readFileSync(join(emailRoot, "locales", file)).byteLength,
  0,
);
process.stdout.write(
  `Email JavaScript: ${emailBuildSize} bytes; locale data: ${emailLocaleBytes} bytes\n`,
);
assert.ok(
  emailBuildSize <= EMAIL_BUILD_SIZE_CEILING_BYTES,
  `Email build is ${emailBuildSize} bytes; ceiling is ${EMAIL_BUILD_SIZE_CEILING_BYTES}`,
);

interface EmailCase {
  name: string;
  props: Record<string, unknown>;
  marker: string;
}

const emailCases: EmailCase[] = [
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
async function verifyEmailContracts(): Promise<void> {
  const { renderEmail } = await import(
    join(workspace, "dist/server/email-renderer.js")
  );
  for (const emailCase of emailCases) {
    const html = await renderEmail(emailCase.name, emailCase.props);
    assert.match(html, /^<!doctype html>/);
    if (emailCase.name === "EmailLayout") {
      assert.match(html, /<meta charset="utf-8"/);
      assert.match(html, /images\/antelope-logo\/light\.svg/);
      assert.doesNotMatch(html, /<h1[^>]*\bas=/);
    }
    assert.match(
      html,
      new RegExp(emailCase.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }
}
for (const marker of ["auth/login", "DefaultLayout", "error.500.title"]) {
  assert.match(
    javascript,
    new RegExp(marker),
    `${marker} must be reachable at runtime`,
  );
}
void verifyEmailContracts().then(() => {
  process.stdout.write(`Real DMS source compiled in ${basename(workspace)}\n`);
});

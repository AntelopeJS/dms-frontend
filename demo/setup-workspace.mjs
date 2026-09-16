import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFrontendModuleRegistry } from "../dist/common.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(root, ".demo-workspace");
const dmsLayer = resolve(root, "../repo/frontend");
const playgroundLayer = resolve(root, "../repo/playground/frontend");
const layers = resolve(workspace, "frontend-modules");
const playgroundDestination = resolve(layers, "playground-frontend-module");

rmSync(workspace, { recursive: true, force: true });
mkdirSync(layers, { recursive: true });
cpSync(resolve(root, "templates"), workspace, { recursive: true });
cpSync(dmsLayer, resolve(layers, "antelopejs__dms"), {
  recursive: true,
  filter: (path) =>
    !["node_modules", "dist"].some((directory) =>
      path.split("/").includes(directory),
    ),
});
cpSync(playgroundLayer, playgroundDestination, {
  recursive: true,
  filter: (path) =>
    !["node_modules", "dist"].some((directory) =>
      path.split("/").includes(directory),
    ),
});
writeFileSync(
  resolve(workspace, "dms-main.css"),
  `@import "tailwindcss";
@import "@nuxt/ui";
`,
);

writeFrontendModuleRegistry(workspace, [
  {
    path: resolve(layers, "antelopejs__dms"),
    packageName: "@antelopejs/dms",
    priority: 100,
    configKey: "dms",
    options: {
      baseURL: "",
      clientBaseUrl: "",
      homepage: "/form/form-simple",
      mustValidateEmail: false,
      oauthProviders: [],
      token: { maxAgeInSeconds: 900 },
    },
  },
  {
    path: playgroundDestination,
    packageName: "playground-frontend-module",
    priority: 200,
    options: {},
  },
]);

// Stands in for pnpm in the generated workspace: prints what pnpm and Vite
// print, as FAKE_PNPM_SCENARIO asks, and records every call in FAKE_PNPM_LOG.
import { appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const scenario = process.env.FAKE_PNPM_SCENARIO ?? "success";
const env = {
  updateNotifier: process.env.npm_config_update_notifier,
  viteLogLevel: process.env.DMS_VITE_LOG_LEVEL,
};
appendFileSync(process.env.FAKE_PNPM_LOG, `${JSON.stringify({ args, env })}\n`);

/** The first materialized layer, as Vite and pnpm name it. */
const layerCopy = join(
  process.cwd(),
  "frontend-modules",
  readdirSync(join(process.cwd(), "frontend-modules"))[0],
);

function install() {
  console.log("Scope: all 2 workspace projects");
  console.error(
    "(node:4242) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized",
  );
  console.log("Progress: resolved 3, reused 3, downloaded 0, added 0");
  if (scenario === "install-fails") {
    for (let line = 1; line <= 20; line += 1)
      console.log(`install output line ${line}`);
    console.log(`${layerCopy}:`);
    console.error(
      " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404",
    );
    process.exit(1);
  }
  console.log("Packages: +3");
  console.log("Progress: resolved 3, reused 3, downloaded 0, added 3, done");
}

function build(script) {
  if (script === "build:client") {
    console.error("");
    console.error(
      "(!) Some chunks are larger than 500 kB after minification. Consider:",
    );
    console.error("- Using dynamic import() to code-split the application");
  }
  if (script === "build:ssr" && scenario === "ssr-fails") {
    const file = join(layerCopy, "app/components/Callout.vue");
    console.error("error during build:");
    console.error("[vite:vue] [vue/compiler-sfc] Unexpected token (10:50)");
    console.error("");
    console.error(file);
    console.error("10 |  const props = withDefaults(defineProps<Props>(), {{{");
    console.error("   |                                                    ^");
    console.error(`file: ${file}:10:50`);
    console.error(
      "    at constructor (/ws/node_modules/@babel/parser/lib/index.js:1:1)",
    );
    process.exit(1);
  }
}

if (args[0] === "install") install();
else build(args[args.length - 1]);

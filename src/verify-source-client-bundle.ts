import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensure } from "./internal/ensure";
import { parseViteManifest } from "./internal/vite-manifest";

const LAZY_LIBRARIES = [
  { name: "ApexCharts", pattern: /ApexCharts/ },
  { name: "Tiptap", pattern: /tiptap/i },
];
const RUNTIME_MARKERS = ["auth/login", "DefaultLayout", "error.500.title"];

/**
 * The client bundle keeps the heavy libraries out of the main chunk, and
 * still reaches them and the pages every DMS serves: those of the DMS core
 * layer, which every run includes.
 *
 * @internal
 */
export function checkClientBundle(workspace: string): void {
  const clientRoot = join(workspace, "dist", "client");
  const manifest = parseViteManifest(
    readFileSync(join(clientRoot, ".vite", "manifest.json"), "utf8"),
    "client build manifest",
  );
  const mainEntry = manifest.find((entry) => entry.isEntry);
  ensure(mainEntry !== undefined, "The Vite manifest names no entry chunk");
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
    manifest.some((chunk) => chunk.src?.endsWith("/kpi/KpiCard.vue")),
    "DmsKpiCard is not reachable at runtime",
  );
  for (const marker of RUNTIME_MARKERS)
    ensure(
      javascript.includes(marker),
      `${marker} is not reachable at runtime`,
    );
}

import { readdir, readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const ASSET_ROOT = fileURLToPath(new URL("./dist/client/", import.meta.url));
const COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
]);
const MINIMUM_SIZE_BYTES = 1_024;
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

async function assetFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? assetFiles(path) : [path];
    }),
  );
  return files.flat();
}

async function compressAsset(path) {
  if (!COMPRESSIBLE_EXTENSIONS.has(extname(path))) return;
  const content = await readFile(path);
  if (content.length < MINIMUM_SIZE_BYTES) return;
  const [brotli, compressedGzip] = await Promise.all([
    compressBrotli(content, {
      params: {
        [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
      },
    }),
    compressGzip(content, { level: constants.Z_BEST_COMPRESSION }),
  ]);
  await Promise.all([
    writeFile(`${path}.br`, brotli),
    writeFile(`${path}.gz`, compressedGzip),
  ]);
}

for (const path of await assetFiles(ASSET_ROOT)) await compressAsset(path);

---
covers:
  - templates/vue/client-chunking.mjs
  - templates/vue/client-server-guard.mjs
  - templates/vue/compress-assets.mjs
  - templates/vue/entry-weight.mjs
  - templates/vue/head-order.mjs
  - templates/vue/server/built-files.mjs
  - templates/vue/server/cli-report.mjs
  - templates/vue/server/client-error.mjs
  - templates/vue/server/client-manifest.mjs
  - templates/vue/server/dev-private-files.mjs
  - templates/vue/server/dev-styles.mjs
  - templates/vue/server/generated-files.mjs
  - templates/vue/server/static-files.mjs
  - templates/vue/server/vite-errors.mjs
docs:
  - docs/7.deployment/1.production.md
---

# static-files

`ajs dms start` serves the files `ajs dms build` made: pre-compressed copies, MIME types, cache headers and conditional requests, none of the dot files. It reports what it serves to the backend, writes nothing into a read-only workspace, stops on a signal and refuses to run without a build or a session secret. `ajs dms dev` serves the sources, hides the generated secrets and the modules' server code, and answers a Vite error with 500.

## Sub-features

- `static-files-serve`: the `.br`, `.gz` or plain variant by `Accept-Encoding`, `immutable` under `/assets/` and `no-cache` elsewhere, weak ETags from size and mtime, `304` by tag (weak, strong, list, `*`) and by date (equal, later, one second earlier, garbage, tag first), `HEAD`, 26 MIME types, dot files, `.vite/` and its compressed copies, `/.well-known/`, traversal forms.
- `static-files-encoding-quality`: finding, see Gotchas.
- `static-files-start`: a read-only workspace stays byte-identical, the ready report (method, path, credential, modules, version), its retries at about 2 s and 6 s, a refused credential ends them, HTTP/1.1 only, `SIGINT` and `SIGTERM`, the session secret at 31 and 32 characters, and no build.
- `static-files-build`: a build with no variable exits 0, every compressible file of 1 KiB or more has `.br` and `.gz` that decode to it, the stylesheet precedes the low-priority entry script, the entry weight line matches the files, and no secret is written.
- `static-files-dev`: owner-only modes under umask 022, 14 private paths answer 403, loopback only, the entry stylesheet first, a Vite error is a 500.
- `static-files-document`: the production document's head, the catalog preload for a signed-in page, the runtime options script.
- `static-files-client-errors`: `431` and `400` before any route, with the one-per-minute hint.

## How to get to it (user POV)

- Every asset the browser loads from `/assets/`, `ajs dms start`, `ajs dms build`, `ajs dms dev`.

## Driving it with dms-control

```bash
dms-control journey "$RUN" static-files
```

## How the journeys observe the files

`static-files-serve` adds files of known content to the client build of a satellite (`ajs dms start` from a hard-linked copy of the run's workspace) and compares the headers with the file system. `static-files-build` runs `ajs dms build --workspace` with a bare environment and umask 022. `static-files-dev` and `routing-owner` start `ajs dms dev` in the run's home.

## Docs swept

| Page | Where it is asserted |
| --- | --- |
| 1.production, Deploy: configuration, build, start (0.0.0.0, `Secure`, signals), TLS notes | `static-files-start`, `static-files-build`, `sessions-cookie` (`Secure`), `routing-listen` |
| Where the build lives, `--workspace` | `static-files-build`, `static-files-start` |
| In a container image: no backend, no secret, read-only, `start` writes nothing | `static-files-build`, `static-files-start` |
| Rebuilding: the ready report | `static-files-start` |
| Caching in front of the server: pre-compression, `Vary`, MIME, immutable, ETag, 304 | `static-files-serve` |
| HTTP/1.1 only | `static-files-start` |

## Not driven

| Behaviour | Why not |
| --- | --- |
| The client build fails when the browser bundle imports server code (`client-server-guard.mjs`) | Needs a source change that must fail a 35-second build; `tests/client-server-guard.test.mts` owns it. |
| The entry-weight warning above its threshold | A second build with a lowered threshold; the weight line is asserted instead. |
| Compression at exactly 1023 and 1024 bytes of a built file | The build's files are Vite's; no file of that size exists to compare (the proxy's threshold is driven in `proxy-answers`). |
| Private files compared without case, and Windows separators in `isPublicBuildPath` | Linux file system; the rule matters on case-insensitive and Windows systems only. |
| `.env` in the directory of the command | The CLI reads it; `tests/cli-env-file.test.ts` owns it. |
| A container built by one user and served by another | Needs a second operating-system user. |
| Cloudflare's 100 MB cap, an HTTP/2 or HTTP/3 reverse proxy | Platform and infrastructure advice. |
| Head order of the dev document's inline `<style>` blocks | Only the entry stylesheet's position is asserted. |

## Gotchas

- `static-files-encoding-quality` fails on purpose: `Accept-Encoding: br;q=0, gzip` is answered with Brotli and `gzip;q=0` with gzip. Draft: `~/.cache/campaign/issues/dms-frontend-static-encoding-ignores-quality.md`.
- `SIGINT` ends the server with code 130 and `SIGTERM` with 143 (the signal's conventional code); only `SIGTERM` is named in the message.
- A workspace given with `--workspace` is created readable by others (a build that ships with its project holds no secret); only the loader-home workspace of `dev` is owner-only, which is what `static-files-dev` asserts.
- `static-files-build` and `static-files-dev` need the pnpm store of the run (`npm_config_store_dir`) and take one to two minutes.
- A path that is not served falls through to the page: its status depends on whether the database is onboarded, so the journeys assert that no file content or `ETag` is sent.

---
covers:
  - src/commands/clean-action.ts
  - src/commands/clean.ts
  - src/commands/prepare-action.ts
  - src/commands/prepare.ts
  - src/commands/workspace-task.ts
  - src/commands/workspaces-action.ts
  - src/commands/workspaces.ts
  - src/fs-sync.ts
  - src/internal/built-workspace.ts
  - src/materialize.ts
  - src/temporary-workspace.ts
  - src/workspace-setup.ts
  - src/workspace.ts
  - templates/vue/prepare-types.mjs
docs:
  - docs/3.cli/5.prepare.md
  - docs/3.cli/6.workspaces.md
  - docs/3.cli/7.clean.md
  - docs/7.deployment/2.workspaces-and-cache.md
---

# workspace

The generated workspaces under `~/.antelopejs/dms-frontend`: how `prepare` writes them, how `workspaces` lists them, how `clean` removes them, and how the manifest cache stands in for a backend that is out of reach.

## Sub-features

- `workspaces-listing`: no workspace, tab-separated lines piped, `--json`, the table on a wide terminal and the blocks on a narrow one; most recent first; the id is the SHA-256 of the key; project and url keys; sizes with a hard link counted once and the units at their limits; ages at their limits; a missing or invalid date falls back to the file's; foreign directories are skipped on stderr.
- `clean-one-backend`: `-b` removes the workspace keyed on the url in any equivalent spelling (`localhost`, a trailing slash, upper case, `[::1]`) and says what it freed; a project-keyed workspace, another url and a production build are left; no workspace is information; a bad url is a usage error.
- `clean-all`: `--all` without a terminal or with `CI` exits 2 and removes nothing; on a terminal Enter takes the default (no); `--yes` removes every workspace, lists them, and reports foreign directories; singular and plural; nothing left; `-q`.
- `prepare-workspace`: a first run, the 0700 workspace keyed on the canonical url, the 0600 manifest cache, the metadata, a second run installs nothing, equivalent urls share a workspace, `--force` installs again, the bootstrap credential from the flag, from the variable, the flag winning, and refused before any request when it holds a space or a non-ASCII character.
- `prepare-private-options`: a module's lifecycle scripts are stripped from its copy; `generated-server-options.json` is 0600 while it holds a private value (also a nested one) and 0644 once emptied; a module without a supported range is warned about; one whose range excludes this release is refused before install.
- `prepare-failures`: without `--strict` prepare warns and exits 0 for a missing url, an invalid one, a closed port, 401, 403, manifest versions 1, 3 and none, another renderer's module, 500 and 404; with `--strict` it exits 2 for a missing or invalid url and 1 for the rest.
- `prepare-cache`: a failing backend falls back to the cache with a warning; a refusal never does; `--offline` and `DMS_OFFLINE` never ask the backend; offline without a cache is skipped; a cached module whose source is gone is reported.
- `prepare-trailing-slash`: a backend url with a trailing slash asks for `/dms/frontend` and posts the ready report to `/dms/frontend/ready`, as the one without does. Fails today: finding below.
- `prepare-discovered-credential`: the credential of `.antelope/dms-dev.json` goes to the project's own backend only, also in another spelling of its url; the flag and the variable win; a dead process's credential is not used.

## How to get to it (user POV)

- `ajs dms prepare -b <url>` in a module's `postinstall`; `ajs dms workspaces` and `ajs dms clean` to look after the disk.

## Driving it with dms-control

```bash
dms-control journey "$RUN" workspace
```

## Not driven

| Behaviour | Why |
|---|---|
| `dev` and `prepare -b` sharing one workspace, and the cookie-name suffix taken from the url | The cookie suffix is the sessions feature's; the sharing of `dev -b` is driven in the `build` feature (`dev-server`). |
| A manifest module whose supported range was published for another release in a real module store | Needs a module store; the journeys write the module's `engines` themselves. |
| The permissions of a workspace that existed before the hardening | There is no such workspace to start from; the 0644 to 0600 and back rewrite is driven instead. |

## Gotchas

- Known finding, kept as a failing journey: `prepare-trailing-slash` (AntelopeJS/dms-frontend#280): `-b http://host:port/` sends `//dms/frontend`, which a DMS backend answers with 404, and `prepare` hides it behind the cached manifest. 
- `prepare --offline` without a cache still creates the workspace directory with its metadata file (no `node_modules`, no cache), and `workspaces` then lists it.
- Journeys write workspaces by hand (a directory named after the SHA-256 of its key with a `.ajs-dms-meta.json`) and serve manifests from a backend of their own; `prepare` installs from the registry, so a package published minutes ago can make the install fail with a 404 until the registry catches up.
- Under `-q` every success and information line is left out, including the `Skipped` lines of `clean --all`.

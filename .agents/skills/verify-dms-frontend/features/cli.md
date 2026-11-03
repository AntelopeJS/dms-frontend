---
covers:
  - skills/dms-frontend/SKILL.md
  - src/cancellation.ts
  - src/child-output.ts
  - src/common.ts
  - src/config.ts
  - src/env-file.ts
  - src/help.ts
  - src/index.ts
  - src/internal/ensure.ts
  - src/internal/guards.ts
  - src/internal/plain-object.ts
  - src/internal/text-list.ts
  - src/node-options.ts
  - src/output.ts
  - src/ports.ts
  - src/update-check.ts
docs:
  - docs/3.cli/1.overview.md
  - docs/4.configuration.md
  - docs/9.troubleshooting.md
---

# cli

The `ajs dms` command line as a user meets it: its help and version, the options every command accepts, the exit codes and the framed output, the `.env` files and the environment variables, and the update notice.

## Sub-features

- `help-and-version`: `--version` and `-v` print the release alone on stdout; `--help`, `-h`, `help` and no argument print one help text equal to the overview page's; every command's help, in its three spellings, equals its page's text; an unknown help subject or option is a usage error.
- `environment-topic`: `help environment` lists the 26 variables of the configuration page in its order and words, then the `.env` rules.
- `global-options`: `-q`, `--quiet`, `ANTELOPEJS_QUIET` (0 and false keep it off), `--no-color`, `NO_COLOR`, `TERM=dumb`, `--verbose`, `--verbose=<channels>` and `ANTELOPEJS_VERBOSE` act before and after the command name, and given to `ajs` before the plugin name.
- `exit-codes`: usage errors exit 2 with the fix on stderr, failures exit 1, success 0; ports at 0, 1, 65535, 65536, a negative one and a trailing letter; the session secret at 31 and 32 characters, empty and unset; `--workspace` and `DMS_WORKSPACE_DIR` named in the missing-build fix.
- `env-files`: `.env.local` over `.env`, the shell over both, an empty variable counts as set, quotes and comments, no parent directory, an unreadable file is warned about and skipped, `clean` never reads the backend url from the environment.
- `boolean-variables`: `DMS_PREPARE_STRICT` is off for empty, 0, false, no and off in any case, on otherwise, and `--strict` wins over it.
- `update-notice`: on a terminal, a newer release in the daily cache is announced after a successful command; never for `--help`, `--version`, `-q`, `CI`, `NO_UPDATE_NOTIFIER`, `TERM=dumb`, `--no-update-check` before or after the command, a failed command or a pipe; never when the release is the latest or newer.

## How to get to it (user POV)

- `ajs dms <command>` in a shell; the journeys run `node <renderer>/dist/index.js` with a home and a working directory of their own.

## Driving it with dms-control

```bash
dms-control journey "$RUN" cli
```

## Not driven

| Behaviour | Why |
|---|---|
| The lookup of the newest release at npm, its one-hour retry after an empty answer, its 3-second deadline, and the daily throttle | The registry address is fixed to registry.npmjs.org and the answer changes over time. The journeys feed the notice through its cache file instead, so the stale-cache lookup is never started. |
| Ctrl+C of `build`, `start` and `dev` | Driven in the `build` feature, where the servers run. |
| The `update-notice` journey needs `script(1)` to give the CLI a terminal | It is in util-linux. Without it the journey fails on its first command. |

## Gotchas

- `ajs dms <command> --help` also prints a Global Options section and an Examples section that the docs pages leave out. The journeys compare the part the pages show and require the extra sections to be there.
- Under `-q` the success lines of `clean` and `prepare` are left out too: the quiet run of a successful command prints nothing.
- Under `CI=1`, colors are off even on a terminal; the color check runs with `CI` removed.

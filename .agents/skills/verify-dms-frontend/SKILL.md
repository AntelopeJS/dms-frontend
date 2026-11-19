---
name: verify-dms-frontend
description: "Drive the AntelopeJS DMS frontend renderer (@antelopejs/dms-frontend: the `ajs dms` CLI, the Vue renderer with Vite, Inertia and server-side rendering, the frontend server with its sessions, backend proxy, icons and e-mails) the way an operator and a visitor do, by serving this checkout as the dashboard of the dms playground on free ports with its own MongoDB database and a mail sink, and report a verdict with evidence. Use to prove a change to AntelopeJS/dms-frontend works before merge, or to verify a PR."
---

# Verify dms-frontend

Every deterministic step is a `dms-control` command. You choose which journeys to run and judge what they show; you never write a multi-step shell recipe. When a journey you need does not exist, add it to `e2e/journeys/<feature>.mjs`, describe it in its feature file, and run it.

This repository is the renderer, not a module: it has no backend or playground. `dms-control up --renderer` serves this checkout as the dashboard of the dms playground, so a journey reaches the renderer through the dashboard in a browser, plain HTTP to the frontend server, and the `ajs dms` CLI spawned from this checkout.

`dms-control` is the bin of `@antelopejs/dms`, a devDependency of this repository, run with Node 24. `verify.config.ts` names the playground in `DMS_PLAYGROUND` (default `~/code/dms/packages/dms/playground`) and `renderer: "."`.

```bash
C="pnpm exec dms-control"
$C                       # lists every command
```

## Before you launch

- The dms checkout is at the commit of the `@antelopejs/dms` this repository installs (`gitHead` in `node_modules/@antelopejs/dms/package.json`, or the tag `v<version>` when a release has none), as CI checks it out, and it is installed and built: `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm --dir packages/dms build`, `pnpm --dir packages/dms/playground build`. `prepare` of this skill installs and builds the renderer in this checkout (`--prepare`).
- The renderer checkout's version must satisfy the playground's `@antelopejs/dms-frontend` range. When it does not, `frontend-build` fails with a range error.
- `mongod` comes from `DMS_CONTROL_MONGOD`, `PATH`, or the mongodb-memory-server cache (`~/.cache/mongodb-binaries`).

## Launch

```bash
RUN=$($C up --prepare --skill "$PWD/.agents/skills/verify-dms-frontend")   # installs, builds, starts; prints the run folder
```

`up` lays the playground out again under `$RUN/root`, links this checkout as `@antelopejs/dms-frontend`, builds the playground's dashboard with it (`ajs dms build -e docs`) and serves it (`ajs dms start -e docs -b <api>`) on kernel-chosen ports, with a `mongod` the run owns, `HOME` at `$RUN/home` and a mail sink. `headSha` and the HEAD that `doctor` compares are this checkout's.

## Doctor

```bash
$C doctor "$RUN"          # prints only failing checks; --verbose prints all
```

Do not drive a run that fails doctor. It also fails a renderer `dist` older than its `src`.

## Drive

```bash
$C plan                                  # the diff mapped to features; unmapped surfaces
$C journey "$RUN" smoke
$C journey "$RUN" rendering [journey-id...]
$C formal "$RUN"                         # the formal checks that cover the diff (verdict rule 5)
```

- Each feature file in [features/](features/README.md) lists its source globs (`covers:`), its docs pages (`docs:`), its journeys and its "Not driven" rows; the journeys are in `e2e/journeys/<feature>.mjs`, with the helpers they share in `e2e/web.mjs` (HTTP against the frontend server, the Inertia page object and the payload) and `e2e/signin.mjs` (sign-in that survives a click before hydration), plus the helpers each feature names.
- A journey of the Playwright suite starts on an empty database of the run with the administrator onboarded, unless it says otherwise. It reads each result through a second view: the response headers and body, the rendered HTML, a reload, the captured mail, the CLI's output or a file the CLI wrote.
- Journeys that need the frontend server in a state the run does not offer (another backend, no session secret, a closed port) start their own `ajs dms start` from this checkout on a kernel port and stop it by PID.
- To look at the product yourself: `$C onboard "$RUN"`, `$C browser "$RUN" login`, `goto --path`, `snapshot`, `click --role --name`, `fill`, `press`, `screenshot`, `$C api "$RUN" <method> <path>`, `$C mail "$RUN"`, `$C reset "$RUN"`.

## The suite

`pnpm e2e` runs every journey a feature module exports as `journeys` as a Playwright test through `@antelopejs/dms/e2e`. Its global setup runs `prepare` and starts one run of the kit, each test drives one journey on a fresh database of that run, and the teardown stops the run. Set `DMS_PLAYGROUND` first.

```bash
pnpm e2e --grep @smoke                # the smoke set the full CI tier runs
pnpm e2e --grep '<journey-id>( @\S+)*$'   # one journey, tags or not
DMS_E2E_RUN="$RUN" pnpm e2e           # drive a run of `up` and leave it running
```

A journey can carry `tag` (`@smoke`), `knownFailures` (check name to the finding that makes it fail today) and `last: true` (it changes the run's playground for later journeys). CI runs the `@smoke` journeys on a pull request, and every journey in the merge queue, on a pull request labelled `ci:full`, on a manual run and each night.

Only a journey that opens a browser tab is a Playwright test. The others declare their runner (`e2e/standalone.mjs`), and `dms-control journey` runs none of them:

- `...cliOnly`: it needs no run at all, only the CLI of this checkout, a scratch run folder and a scratch HOME. Its feature module exports it as `cliJourneys`, and `tests/cli-journeys.test.mts` runs it in `pnpm test:cli`, which fails a journey that reads the run's playground, URLs, secrets or accounts.
- `...noBrowser`: it spawns the `ajs dms` CLI against the run's playground or calls the run's servers over HTTP. Its feature module exports it as `runJourneys`, and `tests/run.journeys.test.mts` runs it in `pnpm test:journeys`, on one run that `startRun()` of `@antelopejs/dms/e2e/run` starts for every such journey, with the administrator onboarded once. `DMS_JOURNEY_SHARD=<i>/<n>` runs every n-th of them, from the i-th. Set `DMS_PLAYGROUND` first.

## Evidence

Everything goes under `$RUN/evidence/`: `formal/<name>/` for each formal check, `<feature>/<journey>/NN-<step>/` with `action.json`, `url.txt`, `aria.yml` and `screenshot.png` for a browser step, `request.json` and `response.json` for an API step, `checks.json` for every step that checks something, and `result.json` plus `<feature>/feature.json` per journey. Read the evidence before you judge a PASS: a check passing proves only what it asserts.

## Cleanup

```bash
$C down "$RUN"
```

A journey that starts its own frontend server stops it itself; `down` stops every recorded process.

## Verdict rules

1. **Run every feature whose `covers:` globs the diff touches, plus the smoke journey.** `plan` prints that list as `run`.
2. **Unmapped surface fails the verdict.** User-facing code is `src/**`, `templates/**` (not the patches and the dotfile templates), `skills/**` and `package.json`. `map` checks the whole tree.
3. **Every registered journey of a feature in `run` must have run and passed.** A known finding is listed in its journey's `knownFailures` (see the feature files' Gotchas): its check reads `known` and does not fail the journey. Name each one in the reply as a note.
4. **Docs.** Judge every `docs:` page of each touched feature against what the journeys showed.
5. **Formal checks.** `verify.config.ts` lists each formal check with the files it covers and its own files. Today there are two. [`formal-backend-exposure`](../formal-backend-exposure/SKILL.md) runs the real frontend server on generated deployments and visits, and checks which requests reach the backend, on which path, with whose session and headers. [`formal-static-coding`](../formal-static-coding/SKILL.md) sends a built file under generated `Accept-Encoding` headers, and checks which copy the server picks. Run `$C formal "$RUN"` before the verdict. It runs the full configuration of every check whose covered files or own files the diff touches, records it under `evidence/formal/<name>/`, and decides with `emit` whether the diff changed what the covered code does:
   - a covered check that did not run, or exits non-zero (a tool error, or a check that no longer matches its record), fails the verdict;
   - recorded findings of a formal check (`formal-backend-exposure` has none today, `formal-static-coding` has F1) fail the verdict only when the covered behaviour changed; when it did not, the verdict reports them as known findings;
   - when the covered behaviour changed, or the diff changed the check's own files, `formal` also runs the check on the base. A rule the base broke counts as fixed only when HEAD reports it passing; a rule the base broke that HEAD does not report at all fails the verdict.

   `--all` runs the checks that do not cover the diff too, without gating. A check needs no running playground: `node .agents/skills/formal-backend-exposure/check.mjs --full` gives the same rules on HEAD, without the base comparison.
6. **One-way doors.** The section comes right after the result line and is mandatory. `$C doors` prints the `One-way-door:` line for the diff.
7. **Result.** FAIL if any of rules 1 to 6 fail. PASS+NOTES when something is not verified or needs the owner's attention. PASS otherwise.

State the verdict in your own reply: the result first, then the doors, then what each rule showed. A new push voids the verdict. Nothing is posted to GitHub.

## Gotchas

- The dashboard renders on the server and hydrates after `load`; a click that lands first does nothing. `e2e/signin.mjs` waits and tries again.
- The dashboard's realtime stream never lets the network go idle on a signed-in page; wait for an element, not `networkidle`.
- The run serves a production build, so development behaviour (hot reload, the `x-dms-route-owner` header, the e-mail bundle watcher) is not driven.

## Feature map

[features/README.md](features/README.md).

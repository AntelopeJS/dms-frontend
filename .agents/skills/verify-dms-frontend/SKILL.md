---
name: verify-dms-frontend
description: "Drive the AntelopeJS DMS frontend renderer (@antelopejs/dms-frontend: the `ajs dms` CLI, the Vue renderer with Vite, Inertia and server-side rendering, the frontend server with its sessions, backend proxy, icons and e-mails) the way an operator and a visitor do, by serving this checkout as the dashboard of the dms playground on free ports with its own MongoDB database and a mail sink, and post a verdict with evidence. Use to prove a change to AntelopeJS/dms-frontend works before merge, to verify a PR, or to check that a seeded break or a seeded one-way door is caught."
---

# Verify dms-frontend

Every deterministic step is a `dms-control` command. You choose which journeys to run and judge what they show; you never write a multi-step shell recipe. When a journey you need does not exist, add it to `journeys/<feature>.mjs`, describe it in its feature file, and run it.

This repository is the renderer, not a module: it has no backend or playground. `dms-control up --renderer` serves this checkout as the dashboard of the dms playground, so a journey reaches the renderer through the dashboard in a browser, plain HTTP to the frontend server, and the `ajs dms` CLI spawned from this checkout.

`dms-control` is the bin of `@antelopejs/dms` (`packages/dms/bin/dms-control.mjs`), from a dms checkout with Node 24. `verify.config.ts` names the playground in `DMS_PLAYGROUND` (default `~/code/dms/packages/dms/playground`) and `renderer: "."`.

```bash
C="node $DMS/packages/dms/bin/dms-control.mjs"   # dms-control from AntelopeJS/dms#743 or later
$C                       # lists every command
```

## Before you launch

- The dms checkout is installed and built: `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm --dir packages/dms build`, `pnpm --dir packages/dms/playground build`. `prepare` of this skill installs and builds the renderer in this checkout (`--prepare`).
- The renderer checkout's version must satisfy the playground's `@antelopejs/dms-frontend` range. When it does not, `frontend-build` fails with a range error.
- The playground loads `@antelopejs/api ^1.5.0` from the registry, which answers controller routes (every page layout, the data API) as 500 (AntelopeJS/dms#620). Point its `api` module at the api tarball of the dms checkout (`type: "local"`, `path` to `node_modules/.pnpm/@antelopejs+api@file*/node_modules/@antelopejs/api`) in your own copy of the playground until that is fixed. Journeys that open a data page fail without it.
- `mongod` comes from `DMS_CONTROL_MONGOD`, `PATH`, or the mongodb-memory-server cache (`~/.cache/mongodb-binaries`).

## Launch

```bash
RUN=$($C up --prepare --skill "$PWD/.agents/skills/verify-dms-frontend")   # installs, builds, starts; prints the run folder
```

`up` lays the playground out again under `$RUN/root`, links this checkout as `@antelopejs/dms-frontend`, builds the playground's dashboard with it (`ajs dms build -e docs`) and serves it (`ajs dms start -e docs -b <api>`) on kernel-chosen ports, with a `mongod` the run owns, `HOME` at `$RUN/home` and a mail sink. `headSha` and the HEAD that `doctor` and `verdict` compare are this checkout's.

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
```

- Each feature file in [features/](features/README.md) lists its source globs (`covers:`), its docs pages (`docs:`), its journeys and its "Not driven" rows; the journeys are in `journeys/<feature>.mjs`, with the helpers they share in `web.mjs` (HTTP against the frontend server, the Inertia page object and the payload) and `signin.mjs` (sign-in that survives a click before hydration), plus the helpers each feature names.
- A journey starts on an empty database of the run with the administrator onboarded, unless it says otherwise. It reads each result through a second view: the response headers and body, the rendered HTML, a reload, the captured mail, the CLI's output or a file the CLI wrote.
- Journeys that need the frontend server in a state the run does not offer (another backend, no session secret, a closed port) start their own `ajs dms start` from this checkout on a kernel port and stop it by PID.
- To look at the product yourself: `$C onboard "$RUN"`, `$C browser "$RUN" login`, `goto --path`, `snapshot`, `click --role --name`, `fill`, `press`, `screenshot`, `$C api "$RUN" <method> <path>`, `$C mail "$RUN"`, `$C reset "$RUN"`.

## Evidence

Everything goes under `$RUN/evidence/`: `<feature>/<journey>/NN-<step>/` with `action.json`, `url.txt`, `aria.yml` and `screenshot.png` for a browser step, `request.json` and `response.json` for an API step, `checks.json` for every step that checks something, and `result.json` plus `<feature>/feature.json` per journey. Read the evidence before you judge a PASS: a check passing proves only what it asserts.

## Cleanup

```bash
$C down "$RUN"
```

A journey that starts its own frontend server stops it itself; `down` stops every recorded process.

## Verdict rules

1. **Run every feature whose `covers:` globs the diff touches, plus the smoke journey.** `plan` prints that list as `run`.
2. **Unmapped surface fails the verdict.** User-facing code is `src/**`, `templates/**` (not the patches and the dotfile templates), `skills/**` and `package.json`. `map` checks the whole tree.
3. **Every registered journey of a feature in `run` must have run and passed.** Known findings stay as failing journeys (see the feature files' Gotchas): they fail a verdict only when the diff touches their feature.
4. **Docs.** Judge every `docs:` page of each touched feature against what the journeys showed.
5. **Formal checks.** None.
6. **One-way doors.** The section comes right after the result line and is mandatory. `$C doors` prints the `One-way-door:` line for the diff. No journey contains a Format door (the next release must read the workspace this one builds), so a Format row says so.
7. **Result.** FAIL if any of rules 1 to 6 fail. PASS+NOTES when something is not verified or needs the owner's attention. PASS otherwise.

Write `$RUN/evidence/judgement.json` (`doors`, `docs`, `notVerified`, `attention`, `verifier`), then `$C verdict "$RUN" --pr <n>` and, from a thread that did not write the change, `$C publish "$RUN" --pr <n>`.

## Trust

The skill is not Trusted yet. It becomes Trusted when it catches every seeded break and flags every seeded door, passes a shadow run of 10 consecutive agent PRs, and its last maintain pass is newer than the last change to the repository or its `@antelopejs` dependencies and at most 30 days old.

## Seeded breaks and doors

```bash
$C seeded smoke rendering icons
$C doors "$PWD/.agents/skills/verify-dms-frontend/seeded-doors/exposure.patch"
```

`seeded-breaks/<feature>.patch` is one minimal product bug per feature; `seeded` builds a control and a patched worktree of this checkout, builds the renderer in each, runs the feature's journeys in each, and prints `CAUGHT` with the journeys that caught it, or `MISSED`. A break counts only when a journey that passes in the control fails one of its checks with the patch. `seeded-doors/<kind>.patch` holds one change per door kind.

## Gotchas

- The dashboard renders on the server and hydrates after `load`; a click that lands first does nothing. `signin.mjs` waits and tries again.
- The dashboard's realtime stream never lets the network go idle on a signed-in page; wait for an element, not `networkidle`.
- The run serves a production build, so development behaviour (hot reload, the `x-dms-route-owner` header, the e-mail bundle watcher) is not driven.
- A step whose check fails because the backend or the dashboard stopped answering must not count as a catch: a `seeded` MISSED or a journey with no failing check is a harness error.

## Feature map

[features/README.md](features/README.md).

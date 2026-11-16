---
name: formal-static-coding
description: Property-based check, with fast-check, of which copy of a built file the frontend server sends for any Accept-Encoding header (templates/vue/server/static-files.mjs and the quality parser acceptedCodings in content.mjs). Generated headers (codings, q-values, wildcards, identity, spacing, case) and every set of precompressed copies run against the real serveStaticFile, and the check compares the copy that goes out with RFC 9110 §12.5.3. Use when a change touches a file in its coverage record, or when a change to static files, precompressed copies or content negotiation needs proof that no client gets a body it refused or cannot decode.
---

# Formal check: which coding a built file goes out in

`ajs dms start` serves the files of the build with the `.br` or `.gz` copy the build wrote next to them. The client states what it can decode in `Accept-Encoding`. A coding the header refuses with `q=0` is a body the browser cannot read: a blank page or a failed script, with nothing in the server's log. Before AntelopeJS/dms-frontend#311 the server picked the copy with a substring test, so `br;q=0, gzip` got Brotli and `gzip;q=0` got gzip (AntelopeJS/dms-frontend#277). `tests/static-files.test.mts` and the `static-files` journeys drive a few fixed headers. This check generates the headers and the copies.

The promise comes from RFC 9110 §12.5.3, and from the TSDoc of `acceptedCodings` where the RFC leaves a choice: implicit identity is a fallback, never a preference over a coding the header accepts. `contract.mjs` restates it apart from the code. There is no verifier for this JavaScript, so the check runs the real code on generated inputs, not a model of it. Each case is a built file with some set of copies (none, `.br`, `.gz`, both) and a request for it, with or without an `Accept-Encoding` header. `drive.mjs` writes those four files, and serves them the way `serveAsset` in `templates/vue/server.mjs` does: `publicBuildFile` names the file, `serveStaticFile` sends it. It sends the request over HTTP, and the rules read the status, `Content-Encoding` and which file's bytes came back.

- `contract.mjs` is the contract: how a header renders, the q-value of a coding (its own element, else `*`, else 0), and the set of copies the header allows the server to send.
- `inputs.mjs` generates cases: `br`, `gzip`, `deflate`, `zstd`, `compress`, `identity` and `*` once each in any order and case, every q-value form the grammar allows (`0`, `0.`, `0.000`, `1.`, `0.500`), blanks and tabs around `;` and `,`, empty list elements, and no header.
- `drive.mjs` starts the server and sends one case. `rules.mjs` holds the rules. `findings.mjs` records what the current code breaks. `check.mjs` runs everything.

## Run it

From the repository root, with Node 24 and `pnpm install` done (fast-check is a devDependency, pinned by the lockfile):

```sh
node .agents/skills/formal-static-coding/check.mjs           # 200 cases per rule
node .agents/skills/formal-static-coding/check.mjs --full    # 2,000 cases per rule
node .agents/skills/formal-static-coding/check.mjs --seed 7  # another sample
```

| Configuration | Cases | Wall time |
| --- | --- | --- |
| CI (no flag) | 200 per rule and per finding | under 1 s |
| Full (`--full`) | 2,000 per rule and per finding | about 2 s |

The seed defaults to `20261116`, and the same seed with the same fast-check version replays the same cases. `pnpm test` runs the CI configuration (`tests/formal-static-coding.test.ts`), and `dms-control formal` runs `--full` when a diff touches a covered file (`verify.config.ts`).

- Exit 0 means every rule that held still holds, and each finding still breaks.
- Exit 1 means a rule changed. `BROKEN <Rule>` names a rule that held and now breaks, with the shrunk case under it. `HOLDS  <Rule>` names a finding that no longer breaks.
- Exit 2 means the harness could not run (a request got no answer) or the arguments were wrong.

The lines that name a changed rule match `^(?:BROKEN|CHANGED|HOLDS) +(\w+)`, and `finding <Rule>` lines name a recorded finding. A rule that still holds prints in the lowercase `holds` line.

## When to run it

Run `--full` when a change touches a file in the coverage record below, this folder, or the `static-files` feature of the verify skill. A changed rule (exit 1) makes the Verdict FAIL. The recorded finding fails it only when the diff changes what the covered code does, which `dms-control formal` decides by comparing the covered files' JavaScript statements on the base and on HEAD (`verify-dms-frontend` verdict rule 5).

## The rules

| Rule | Plain sentence | Harm when it breaks | On main |
| --- | --- | --- | --- |
| `NoRefusedCoding` | The copy sent is never one the header gives `q=0`, or leaves out and covers with no `*`. | The browser gets a body it cannot decode. | holds |
| `HighestQualityWins` | Among the copies the build wrote, the server sends one the header ranks highest: the coding with the highest q-value, or the plain file when an `identity` element ranks it above them. A tie allows either. The plain file goes out when no copy is acceptable. | A client that asked for the plain file, or for a lighter coding, gets a heavier or less wanted one. | breaks on F1 |
| `BodyMatchesEncoding` | The status is 200, and the body is the copy `Content-Encoding` names, or the plain file when it names none. | A body in one coding under the label of another. | holds |

A case in a finding is left out of the rules that finding breaks. The check then confirms that the finding's rule still breaks on its own cases.

## Findings on main

F1 (`HighestQualityWins`): the header ranks `identity` above the copies the build wrote, but not above a coding that has no copy. `acceptedCodings` compares `identity` with `br` and `gzip` alone, and `acceptedVariant` then keeps the codings that have a copy, so the plain file loses to a lower-ranked copy. A real run of the server, as `check.mjs` prints it:

```
finding HighestQualityWins: F1, the answer is br, the header ranks plain first
  GET a built file with .br, Accept-Encoding: "identity,br;q=0.500,*"
```

Steps: the build wrote `app-abc123.js` and `app-abc123.js.br`, with no `.gz`. The client sends `identity, br;q=0.5, *`. `gzip` takes q=1 from `*`, so `identity` (1) does not outrank the best of `br` and `gzip` (1), and `acceptedCodings` answers `["gzip", "br"]`. No `.gz` exists, so the `.br` copy goes out. The client ranked the plain file (1) above Brotli (0.5). The body decodes, so no client breaks: the cost is the decode work on a client that asked not to have it. The fix belongs in `acceptedVariant`: rank `identity` against the codings that have a copy.

## Real bug or modeling error

The counterexample ran on the real code, so the request and the answer happened. The question is whether the rule reads the RFC right and whether the case can occur. Replay it alone with a scratch file next to `check.mjs` (delete it afterwards), pasting the printed case:

```js
import { startServer } from "./drive.mjs";
import { RULES } from "./rules.mjs";
const server = await startServer();
const current = { copies: { br: true, gzip: false }, method: "GET", header: [{ token: "identity", written: "identity", quality: null, semicolon: ";", weight: "q", separator: ", " }, { token: "br", written: "br", quality: "0.5", semicolon: ";", weight: "q", separator: ", " }, { token: "*", written: "*", quality: null, semicolon: ";", weight: "q", separator: "" }] };
const observation = await server.visit(current);
console.log(observation, RULES.map((rule) => `${rule.name}: ${rule.broken(current, observation) ?? "keeps"}`));
await server.close();
```

A modeling error sits in one of three places:

- `contract.mjs` reads the RFC wrongly. The contract's own readings: a coding the header does not name and no `*` covers is refused; an element with no q-value weighs 1; `identity` ranks only when the header names it; two codings at the same q-value are equally good, so either goes out.
- `inputs.mjs` makes a header no client sends. Every q-value it writes follows the grammar of RFC 9110 §12.4.2 (at most three decimals, at most 1). Each token appears once.
- `drive.mjs` serves the files differently from `serveAsset`. Keep the two calls the same.

Otherwise the break is real. Assert only what the visitor observes: the status, `Content-Encoding`, and the bytes.

## Changing the check

- For an intended change of behaviour, change the user docs and `contract.mjs` first, then rerun both configurations.
- Never weaken or drop a rule to make the check pass. A fixed finding leaves `FINDINGS` in `findings.mjs` once a replay confirms the fix (the check prints `HOLDS`). A new finding goes into `FINDINGS` with the cases it covers, and into this file with its counterexample.
- When you change `inputs.mjs`, rerun the scratch breaks below. The CI configuration must still catch each one with the rule it names.
- After you confirm that the check describes the code at a newer commit, move the sync commit forward. Do it only then.

## Coverage record

Paths are under `templates/vue/`.

| What the check drives | Code |
| --- | --- |
| Which copy goes out | `serveStaticFile`, `acceptedVariant`, `VARIANT_SUFFIXES` (server/static-files.mjs:53-125) |
| Reading the header | `acceptedCodings` (server/content.mjs:13-50) |
| Which file a path names | `publicBuildFile` (server/built-files.mjs:44) |

The sync commit is `4a736a7` on AntelopeJS/dms-frontend `next`.

## Bounds and what is left out

Each configuration covers its sample only: 200 or 2,000 generated headers per rule at a seed, with one to five elements from seven tokens, over the four sets of copies, with GET and HEAD. A pass says no case in the sample broke a rule, not that none can.

The check leaves out:

- bodies the server generates or relays (`acceptedEncoder` in `content.mjs`, `proxy-compression.mjs`): they share `acceptedCodings`, which this check covers, but the encoder around it is not driven.
- a header that repeats a token (`gzip;q=0, gzip`; the code keeps the lowest q-value), a malformed q-value (the code reads it as 0), `x-gzip`, and a header sent twice.
- `identity` given by `*` alone: RFC 9110 lets `*;q=0` refuse the plain file, and the code treats the plain file as the fallback in every case.
- the validators and the cache headers (`ETag`, `Vary`, `Cache-Control`, `304`), which `tests/static-files.test.mts` and the `static-files` journeys cover.
- the development server, which sends no precompressed copy.

## Confirm the check can fail

Each break was made in the real product code of the worktree and reverted with `git checkout` after the run. The CI configuration caught each one with exit 1, with the rule in the first column among the `BROKEN` lines.

| Rule | Scratch change | First `BROKEN` line of the rule |
| --- | --- | --- |
| `NoRefusedCoding` | the code before #311: `templates/vue/server/static-files.mjs` and `content.mjs` from `082e7dff3^` (`git checkout 082e7dff3^ -- templates/vue/server/static-files.mjs templates/vue/server/content.mjs`) | `the answer is gzip, which the header refuses with q=0 or does not name`, with `GET a built file with .gz, Accept-Encoding: "gzip;q=0"` |
| `HighestQualityWins` | the same | `the answer is gzip, the header ranks plain first`, with the same case |
| `BodyMatchesEncoding` | `acceptedVariant` labels every copy `gzip`: `{ file: ..., encoding }` becomes `{ file: ..., encoding: "gzip" }` (static-files.mjs:70) | `the Content-Encoding says gzip, the body is the br copy` |

With the change reverted, the check exits 0 and records only F1.

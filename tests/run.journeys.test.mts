import * as assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  runJourney,
  startRun,
  type FeatureResult,
  type StartedRun,
} from "@antelopejs/dms/e2e/run";
import { runFeatures } from "./helpers/journey-checks.ts";

const JOURNEY_TIMEOUT_MS = 900_000;
const SHARD = /^(\d+)\/(\d+)$/;

/**
 * Whether the journey at `position` of the whole list is this process's to run: every n-th one from the i-th by
 * `DMS_JOURNEY_SHARD=<i>/<n>`, all of them without it.
 *
 * @throws When the variable is not `<i>/<n>` with 1 ≤ i ≤ n
 */
function shardOf(spec: string | undefined): (position: number) => boolean {
  if (spec === undefined || spec === "") return () => true;
  const [, index = "", total = ""] = SHARD.exec(spec) ?? [];
  const [i, n] = [Number(index), Number(total)];
  if (!(i >= 1 && i <= n))
    throw new Error(
      `DMS_JOURNEY_SHARD is ${spec}: write <i>/<n>, with 1 ≤ i ≤ n`,
    );
  return (position) => position % n === i - 1;
}

/** What failed the kit's judgement of a journey: its error, the checks that failed unlisted, and the listed ones that passed. */
function problemsOf(result: FeatureResult): string[] {
  const checks = result.steps.flatMap((step) =>
    step.checks.flatMap((check) => {
      if (check.verdict === "fail")
        return [`${step.name} › ${check.name}: ${check.detail}`];
      if (check.verdict === "fixed")
        return [
          `${step.name} › ${check.name} passes: remove it from knownFailures`,
        ];
      return [];
    }),
  );
  return result.error === null ? checks : [result.error, ...checks];
}

const inShard = shardOf(process.env.DMS_JOURNEY_SHARD);
const selected = (await runFeatures())
  .flatMap(({ feature, journeys }) =>
    journeys.map((journey) => ({ feature, journey })),
  )
  .filter((_, position) => inShard(position));

void describe("journeys on a run of the kit", () => {
  let started: StartedRun | undefined;

  before(async () => {
    started = await startRun();
  });

  after(() => started?.stop());

  for (const { feature, journey } of selected) {
    void it(
      `${feature} › ${journey.id}`,
      { timeout: JOURNEY_TIMEOUT_MS },
      async () => {
        assert.ok(started, "the run started");
        const result = await runJourney(started.run, feature, journey);
        assert.deepEqual(
          problemsOf(result),
          [],
          `evidence in ${started.run.evidence}/${result.folder}`,
        );
        assert.equal(result.status, "PASS");
      },
    );
  }
});

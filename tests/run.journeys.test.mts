import * as assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  runJourney,
  startRun,
  type FeatureResult,
  type StartedRun,
} from "@antelopejs/dms/e2e/run";
import { runFeatures } from "./helpers/journey-checks.ts";
import { JOURNEY_SECONDS } from "./helpers/journey-seconds.ts";
import { journeysOfShard, parseShard } from "./helpers/journey-shards.ts";

const JOURNEY_TIMEOUT_MS = 900_000;

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

const all = (await runFeatures()).flatMap(({ feature, journeys }) =>
  journeys.map((journey) => ({
    feature,
    journey,
    name: `${feature} › ${journey.id}`,
  })),
);
const mine = new Set(
  journeysOfShard(
    all.map(({ name }) => name),
    JOURNEY_SECONDS,
    parseShard(process.env.DMS_JOURNEY_SHARD),
  ),
);
const selected = all.filter(({ name }) => mine.has(name));

void describe("journeys on a run of the kit", () => {
  let started: StartedRun | undefined;

  before(async () => {
    started = await startRun();
  });

  after(() => started?.stop());

  for (const { feature, journey, name } of selected) {
    void it(name, { timeout: JOURNEY_TIMEOUT_MS }, async () => {
      assert.ok(started, "the run started");
      const result = await runJourney(started.run, feature, journey);
      assert.deepEqual(
        problemsOf(result),
        [],
        `evidence in ${started.run.evidence}/${result.folder}`,
      );
      assert.equal(result.status, "PASS");
    });
  }
});

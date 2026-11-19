import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cliFeatures, judgeJourney } from "./helpers/journey-checks.ts";

const JOURNEY_TIMEOUT_MS = 600_000;

for (const { feature, journeys } of await cliFeatures()) {
  void describe(`${feature} journeys`, () => {
    for (const journey of journeys) {
      void it(journey.id, { timeout: JOURNEY_TIMEOUT_MS }, async () => {
        assert.deepEqual(await judgeJourney(journey), []);
      });
    }
  });
}

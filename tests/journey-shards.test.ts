import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOURNEY_SECONDS } from "./helpers/journey-seconds.ts";
import { journeysOfShard, parseShard } from "./helpers/journey-shards.ts";

const shards = (
  names: readonly string[],
  seconds: ReadonlyMap<string, number>,
  total: number,
) =>
  Array.from({ length: total }, (_, index) =>
    journeysOfShard(names, seconds, { index: index + 1, total }),
  );

const load = (names: readonly string[], seconds: ReadonlyMap<string, number>) =>
  names.reduce((sum, name) => sum + (seconds.get(name) ?? 0), 0);

void describe("journey shards", () => {
  void it("runs every journey once across the shards, recorded or not", () => {
    const names = [...JOURNEY_SECONDS.keys(), "new › unrecorded"];
    for (let total = 1; total <= 8; total++) {
      const dealt = shards(names, JOURNEY_SECONDS, total).flat();
      assert.deepEqual([...dealt].sort(), [...names].sort(), `${total} shards`);
    }
  });

  void it("deals by recorded time, not by position", () => {
    const seconds = new Map([
      ["a", 100],
      ["b", 1],
      ["c", 100],
      ["d", 1],
    ]);
    const dealt = shards([...seconds.keys()], seconds, 2);
    assert.deepEqual(
      dealt.map((names) => load(names, seconds)),
      [101, 101],
    );
  });

  void it("keeps each shard within the longest journey of the mean", () => {
    const names = [...JOURNEY_SECONDS.keys()];
    const longest = Math.max(...JOURNEY_SECONDS.values());
    for (let total = 2; total <= 8; total++) {
      const mean = load(names, JOURNEY_SECONDS) / total;
      for (const shard of shards(names, JOURNEY_SECONDS, total))
        assert.ok(load(shard, JOURNEY_SECONDS) <= mean + longest);
    }
  });

  void it("runs everything without a shard and refuses a shard out of range", () => {
    assert.equal(parseShard(undefined), undefined);
    assert.equal(parseShard(""), undefined);
    assert.deepEqual(parseShard("2/5"), { index: 2, total: 5 });
    assert.throws(() => parseShard("0/2"), /DMS_JOURNEY_SHARD is 0\/2/);
    assert.throws(() => parseShard("3/2"), /DMS_JOURNEY_SHARD is 3\/2/);
    assert.throws(() => parseShard("1-2"), /DMS_JOURNEY_SHARD is 1-2/);
  });
});

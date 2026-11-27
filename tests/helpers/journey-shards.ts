const SHARD = /^(\d+)\/(\d+)$/;

/** Shard `index` of `total`, counted from 1. */
export interface Shard {
  index: number;
  total: number;
}

/**
 * The shard `DMS_JOURNEY_SHARD=<i>/<n>` names; undefined when the variable is unset or empty.
 *
 * @throws When the variable is not `<i>/<n>` with 1 ≤ i ≤ n
 */
export function parseShard(spec: string | undefined): Shard | undefined {
  if (spec === undefined || spec === "") return undefined;
  const [, index = "", total = ""] = SHARD.exec(spec) ?? [];
  const [i, n] = [Number(index), Number(total)];
  if (!(i >= 1 && i <= n))
    throw new Error(
      `DMS_JOURNEY_SHARD is ${spec}: write <i>/<n>, with 1 ≤ i ≤ n`,
    );
  return { index: i, total: n };
}

/**
 * The names of `names` that `shard` runs, all of them without a shard. Journeys are dealt longest first, by their
 * `seconds`, each to the shard with the least time so far (the lowest index on a tie); a journey with no recorded
 * time counts the mean of the recorded ones. Every shard computes the same deal, so the shards together run each
 * name once.
 */
export function journeysOfShard(
  names: readonly string[],
  seconds: ReadonlyMap<string, number>,
  shard: Shard | undefined,
): string[] {
  if (shard === undefined) return [...names];
  const recorded = names.flatMap((name) => seconds.get(name) ?? []);
  const fallback =
    recorded.length === 0
      ? 1
      : recorded.reduce((sum, value) => sum + value, 0) / recorded.length;
  const weighed = names.map((name, position) => ({
    name,
    position,
    weight: seconds.get(name) ?? fallback,
  }));
  weighed.sort((a, b) => b.weight - a.weight || a.position - b.position);
  const loads = Array.from({ length: shard.total }, () => 0);
  const mine = new Set<number>();
  for (const { position, weight } of weighed) {
    const target = loads.indexOf(Math.min(...loads));
    loads[target] = (loads[target] ?? 0) + weight;
    if (target === shard.index - 1) mine.add(position);
  }
  return names.filter((_, position) => mine.has(position));
}

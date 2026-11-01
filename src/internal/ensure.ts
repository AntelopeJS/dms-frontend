import { CliError } from "@antelopejs/core/cli";

/**
 * Fails the running check with `title` unless `condition` holds.
 *
 * @internal
 */
export function ensure(
  condition: boolean,
  title: string,
  reason?: string,
): asserts condition {
  if (!condition) throw new CliError({ title, reason });
}

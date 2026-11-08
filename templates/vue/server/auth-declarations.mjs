import { authRejection } from "./auth-hooks.mjs";
import { compilePathPattern } from "./path-patterns.mjs";

/**
 * @import { AuthProvider, DeclaredModule } from "./module-route-types.mjs"
 */

/**
 * The auth hooks: those of the highest-priority module that registers them.
 * A module registering them twice, or after another one, is reported.
 *
 * @param {DeclaredModule[]} modules
 * @param {(message: string) => void} warn
 */
export function resolveAuth(modules, warn) {
  /** @type {AuthProvider | undefined} */
  let provider;
  for (const module of modules) {
    for (const auth of module.declared.auth) {
      const reason = authRejection(auth);
      if (reason) {
        warn(
          `Frontend module ${module.id} registers auth hooks, which are ignored: ${reason}.`,
        );
        continue;
      }
      if (provider) {
        warn(
          `Frontend module ${module.id} registers auth hooks, which are ignored: ${provider.id} (priority ${provider.priority ?? 0}) provides them.`,
        );
        continue;
      }
      provider = {
        id: module.id,
        priority: module.priority ?? 0,
        signInPath: auth.signInPath,
        signInExempt: auth.signInExempt?.flatMap(
          (pattern) => compilePathPattern(pattern) ?? [],
        ),
        refreshSession: auth.refreshSession?.bind(auth),
        publicSession: auth.publicSession?.bind(auth),
      };
    }
  }
  return provider;
}

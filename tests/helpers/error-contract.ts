/**
 * @fileoverview Test helper for the error-contract recovery wiring. Resolves the `recovery` string
 * a definition declares for a reason and returns it in the wire shape `ctx.recoveryFor()` produces,
 * so error-path assertions check that the authored guidance actually reaches `error.data` rather
 * than only living in the contract.
 * @module tests/helpers/error-contract
 */

/** Minimal structural view of an `errors[]` entry — avoids depending on the framework's type export. */
type DeclaredError = { reason: string; recovery: string };

/**
 * Wire-shaped recovery payload for `reason`, read from the definition's own `errors[]`.
 * Throws when the reason is not declared, so a renamed or removed contract entry fails the
 * assertion loudly instead of matching `undefined`.
 */
export function declaredRecovery(
  errors: readonly DeclaredError[] | undefined,
  reason: string,
): { hint: string } {
  const entry = errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`No errors[] entry declares reason "${reason}".`);
  return { hint: entry.recovery };
}

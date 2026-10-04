/**
 * @fileoverview Test helpers for the error-contract recovery wiring. The framework fills a declared
 * reason's `recovery` into the error envelope when the throw site carries none, so a handler's own
 * throw holds only `data.reason`; these helpers resolve the authored hint from `errors[]` and run a
 * tool through the contract runner, so error-path assertions check that the guidance actually
 * reaches the wire rather than only living in the contract.
 * @module tests/helpers/error-contract
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';

/** Minimal structural view of an `errors[]` entry — avoids depending on the framework's type export. */
type DeclaredError = { reason: string; recovery: string };

/** The `structuredContent.error` a failed tool call carries on the wire. */
type WireError = { code: number; message: string; data: Record<string, unknown> };

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

/**
 * Runs a tool through `runToolContract` — schema, handler, and the production error envelope,
 * declared-recovery fill included — and returns the error it reports. Throws when the call
 * succeeds, so a test expecting a failure cannot pass on a success result.
 */
export async function contractError(
  ...args: Parameters<typeof runToolContract>
): Promise<WireError> {
  const result = await runToolContract(...args);
  if (!result.isError) throw new Error('Expected the tool call to fail.');
  return (result.structuredContent as { error: WireError }).error;
}

/** Captures the error raised by a handler that may return either synchronously or asynchronously. */
export async function captureError(operation: () => unknown | Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }

  throw new Error('Expected operation to throw.');
}

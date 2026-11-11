/**
 * @fileoverview One wall-clock budget per tool call, shared by every USGS Water Data request the
 * call makes — each retry, backoff, page, and chained lookup draws on the same clock.
 * @module services/waterdata/request-deadline
 */

/**
 * Budget for one tool call's upstream work. It keeps the call under the 60-second default request
 * timeout of MCP SDK clients, so a stalled upstream ends in this server's classified timeout
 * instead of a transport timeout the caller cannot read.
 */
const TOOL_DEADLINE_MS = 45_000;

/** A running budget. Read the remainder at the moment a request starts, never cache it. */
export interface RequestDeadline {
  /** The whole budget in milliseconds, as started. */
  readonly budgetMs: number;
  /** Milliseconds since the budget started. */
  elapsedMs(): number;
  /** Milliseconds left, never negative. */
  remainingMs(): number;
}

/**
 * Start a budget on the wall clock (`Date.now()`, the clock `withRetry` measures its own deadline
 * with), so tests that fake `Date` and `setTimeout` move both together.
 */
export function startDeadline(budgetMs: number = TOOL_DEADLINE_MS): RequestDeadline {
  const startedAt = Date.now();
  return {
    budgetMs,
    elapsedMs: () => Date.now() - startedAt,
    remainingMs: () => Math.max(0, budgetMs - (Date.now() - startedAt)),
  };
}

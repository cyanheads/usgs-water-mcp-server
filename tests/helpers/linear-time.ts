/**
 * @fileoverview Test helper that asserts a function's CPU cost grows linearly with input size, so a
 * regex or parser that backtracks quadratically on caller-sized input fails the suite.
 * @module tests/helpers/linear-time
 */

import { expect } from 'vitest';

/** This thread's CPU time per call, in microseconds, across `calls` back-to-back runs. */
function cpuMicrosPerCall(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let i = 0; i < calls; i++) run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / calls;
}

const BASE_CHARS = 5_000;
const MAX_CHARS = 320_000;
/** Calls per 5k measurement; a larger size runs as many as keep the characters per measurement equal. */
const BASE_CALLS = 64;
const PAIRS = 5;

/**
 * Expect `run` to scale linearly over `shape`. The input doubles from 5k to 320k characters; at
 * each size the 5k baseline is timed again beside it, PAIRS times, and the least of those growth
 * ratios must stay under four times the size ratio (256 across the full 64×) before the next size
 * runs, so a quadratic fails within a few doublings instead of stalling on the largest input. CPU
 * time, never wall clock: a loaded machine descheduling the worker adds no CPU time.
 *
 * `maxCallMicros` is the CPU ceiling per call at any size; set it from the slowest shape's cost at
 * 320k characters.
 */
export function expectLinear(
  shape: (chars: number) => string,
  run: (input: string) => void,
  maxCallMicros: number,
): void {
  const base = shape(BASE_CHARS);
  for (let chars = BASE_CHARS * 2; chars <= MAX_CHARS; chars *= 2) {
    const input = shape(chars);
    const calls = Math.max(1, Math.round((BASE_CALLS * BASE_CHARS) / chars));
    let growth = Number.POSITIVE_INFINITY;
    let cost = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < PAIRS; pair++) {
      const baseline = cpuMicrosPerCall(() => run(base), BASE_CALLS);
      const sized = cpuMicrosPerCall(() => run(input), calls);
      growth = Math.min(growth, sized / baseline);
      cost = Math.min(cost, sized);
    }
    expect(growth, `growth at ${chars} characters`).toBeLessThan((4 * chars) / BASE_CHARS);
    expect(cost, `CPU µs per call at ${chars} characters`).toBeLessThan(maxCallMicros);
  }
}

/**
 * @fileoverview Resolve a caller-supplied canvas_id to its canvas, reporting an unknown or expired id
 * through the calling tool's own `canvas_not_found` contract entry.
 * @module services/canvas/acquire-canvas
 */

import type { HandlerContext } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance, DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { McpError } from '@cyanheads/mcp-ts-core/errors';

/**
 * Acquire the canvas a caller named by id. A `canvas_not_found` rejection from the registry is
 * re-thrown through `ctx.fail('canvas_not_found', …)` so it carries the calling tool's declared
 * recovery hint — the registry's own hint never names omitting canvas_id, which is the fresh-canvas
 * path the producing tools offer. Every other rejection (`canvas_capacity_exhausted`, a provider
 * fault) propagates as the same error instance.
 *
 * `ctx` is typed as the non-generic `HandlerContext<'canvas_not_found'>`: `fail` and `recoveryFor`
 * are contravariant in their reason, so any handler context whose contract declares
 * `canvas_not_found` is assignable, and one whose contract lacks it is a compile error.
 */
export async function acquireCanvas(
  canvas: DataCanvas,
  canvasId: string,
  ctx: HandlerContext<'canvas_not_found'>,
): Promise<CanvasInstance> {
  try {
    return await canvas.acquire(canvasId, ctx);
  } catch (err: unknown) {
    if (err instanceof McpError && err.data?.['reason'] === 'canvas_not_found') {
      throw ctx.fail(
        'canvas_not_found',
        `Canvas ${canvasId} not found or expired.`,
        ctx.recoveryFor('canvas_not_found'),
        { cause: err },
      );
    }
    throw err;
  }
}

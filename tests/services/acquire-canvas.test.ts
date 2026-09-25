/**
 * @fileoverview Tests for acquireCanvas — the caller-supplied canvas_id resolution shared by every
 * tool that accepts a canvas_id. Drives a fake DataCanvas through a mock context carrying a
 * `canvas_not_found` contract entry.
 * @module tests/services/acquire-canvas.test
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError, notFound, rateLimited } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { acquireCanvas } from '@/services/canvas/acquire-canvas.js';
import { captureError } from '../helpers/error-contract.js';

const CONTRACT = [
  {
    reason: 'canvas_not_found',
    code: JsonRpcErrorCode.NotFound,
    when: 'The canvas_id does not exist or has expired.',
    recovery: 'Omit canvas_id to start a fresh canvas for this call.',
  },
  {
    reason: 'canvas_disabled',
    code: JsonRpcErrorCode.InvalidRequest,
    when: 'DataCanvas is not enabled.',
    recovery: 'Read the data directly without a canvas on this server.',
  },
] as const;

/** A DataCanvas whose acquire() resolves or rejects as given; nothing else is reachable. */
function fakeCanvas(acquire: DataCanvas['acquire']): DataCanvas {
  return { acquire } as unknown as DataCanvas;
}

/** The error the canvas registry raises for an unknown or expired id. */
const registryNotFound = () =>
  notFound('Canvas not found or expired.', {
    reason: 'canvas_not_found',
    recovery: { hint: 'Re-run the tool that produced this canvas_id to stage fresh data.' },
  });

describe('acquireCanvas', () => {
  it('returns the acquired instance, passing the id and context through', async () => {
    const instance = { canvasId: 'abcdefghij' };
    const acquire = vi.fn().mockResolvedValue(instance);
    const ctx = createMockContext({ errors: CONTRACT });

    await expect(acquireCanvas(fakeCanvas(acquire), 'abcdefghij', ctx)).resolves.toBe(instance);
    expect(acquire).toHaveBeenCalledWith('abcdefghij', ctx);
  });

  it("re-throws canvas_not_found through the caller's contract, message and hint", async () => {
    const original = registryNotFound();
    const ctx = createMockContext({ errors: CONTRACT });
    const error = await captureError(() =>
      acquireCanvas(fakeCanvas(vi.fn().mockRejectedValue(original)), 'abcdefghij', ctx),
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Canvas abcdefghij not found or expired.',
      data: {
        reason: 'canvas_not_found',
        recovery: { hint: 'Omit canvas_id to start a fresh canvas for this call.' },
      },
    });
    expect((error as McpError).cause).toBe(original);
  });

  it.each([
    [
      'canvas_capacity_exhausted',
      () =>
        rateLimited('Tenant canvas cap reached.', {
          reason: 'canvas_capacity_exhausted',
          retryable: true,
        }),
    ],
    ['a NotFound with another reason', () => notFound('Missing.', { reason: 'missing_table' })],
    ['a plain Error', () => new Error('DuckDB connection pool exhausted')],
  ])('passes %s through as the same instance', async (_label, make) => {
    const original = make();
    const ctx = createMockContext({ errors: CONTRACT });
    const error = await captureError(() =>
      acquireCanvas(fakeCanvas(vi.fn().mockRejectedValue(original)), 'abcdefghij', ctx),
    );
    expect(error).toBe(original);
  });

  it('accepts only a context whose contract declares canvas_not_found (checked by tsc)', () => {
    type CtxParam = Parameters<typeof acquireCanvas>[2];
    const declares: CtxParam = createMockContext({ errors: CONTRACT });
    // @ts-expect-error — this contract lacks canvas_not_found, so ctx.fail cannot name it.
    const lacks: CtxParam = createMockContext({ errors: [CONTRACT[1]] as const });
    expect([declares, lacks]).toHaveLength(2);
  });
});

/**
 * @fileoverview Tests for water_dataframe_describe tool — list DataCanvas tables.
 * Mocks the canvas-accessor to avoid live DuckDB.
 * @module tests/tools/water-dataframe-describe.tool.test
 */

import { JsonRpcErrorCode, notFound } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterDataframeDescribe } from '@/mcp-server/tools/definitions/water-dataframe-describe.tool.js';
import { textContent } from '../helpers/content-block.js';
import { captureError, declaredRecovery } from '../helpers/error-contract.js';

let mockCanvasInstance: unknown;

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const recovery = (reason: string) => declaredRecovery(waterDataframeDescribe.errors, reason);

/**
 * The error the canvas registry raises for an unknown or expired canvas_id, copied from
 * `CanvasRegistry.canvasNotFound()` in @cyanheads/mcp-ts-core. It is a structured `McpError`
 * carrying `data.reason`, not a plain Error whose prose happens to say "not found".
 */
const canvasNotFound = (canvasId: string) =>
  notFound('Canvas not found or expired.', {
    reason: 'canvas_not_found',
    canvasId,
    recovery: {
      hint: 'Re-run the tool that produced this canvas_id to stage fresh data, or verify the id was copied correctly.',
    },
  });

const MOCK_TABLE_INFO = [
  {
    name: 'water_series_01646500_00060',
    kind: 'table' as const,
    rowCount: 600,
    columns: [
      { name: 'date_time', type: 'VARCHAR', nullable: false },
      { name: 'value', type: 'VARCHAR', nullable: false },
      { name: 'qualifiers', type: 'VARCHAR', nullable: true },
      { name: 'site_number', type: 'VARCHAR', nullable: false },
      { name: 'parameter_cd', type: 'VARCHAR', nullable: false },
      { name: 'unit_code', type: 'VARCHAR', nullable: false },
    ],
  },
];

describe('waterDataframeDescribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
  });

  it('throws canvas_disabled when canvas is not configured', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeDescribe.errors });
    const input = waterDataframeDescribe.input.parse({ canvas_id: 'canvas0001' });
    await expect(waterDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'canvas_disabled', recovery: recovery('canvas_disabled') },
    });
  });

  it('canvas_disabled error is agent-facing and omits the CANVAS_PROVIDER_TYPE env var (regression: #8)', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeDescribe.errors });
    const input = waterDataframeDescribe.input.parse({ canvas_id: 'canvas0001' });
    const error = (await captureError(() => waterDataframeDescribe.handler(input, ctx))) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('DataCanvas is not enabled on this server instance.');
    expect(error.message).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  it('throws canvas_not_found when acquire rejects a stale canvas_id', async () => {
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(canvasNotFound('stalecanv1')),
    };
    const ctx = createMockContext({ errors: waterDataframeDescribe.errors });
    const input = waterDataframeDescribe.input.parse({ canvas_id: 'stalecanv1' });
    await expect(waterDataframeDescribe.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
    });
  });

  it('declares canvas_not_found as service-thrown — the shared acquire helper raises it', () => {
    const entry = waterDataframeDescribe.errors!.find((e) => e.reason === 'canvas_not_found');
    expect(entry).toMatchObject({ code: JsonRpcErrorCode.NotFound, thrownBy: 'service' });
  });

  it('re-throws an unrecognized acquire failure instead of mislabelling it canvas_not_found', async () => {
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(new Error('DuckDB connection pool exhausted')),
    };
    const ctx = createMockContext({ errors: waterDataframeDescribe.errors });
    const input = waterDataframeDescribe.input.parse({ canvas_id: 'canvas0001' });
    await expect(waterDataframeDescribe.handler(input, ctx)).rejects.toThrow(
      'DuckDB connection pool exhausted',
    );
  });

  it('returns tables with columns and row count', async () => {
    const mockInstance = {
      canvasId: 'canvas0001',
      describe: vi.fn().mockResolvedValue(MOCK_TABLE_INFO),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeDescribe.errors });
    const input = waterDataframeDescribe.input.parse({ canvas_id: 'canvas0001' });
    const result = await waterDataframeDescribe.handler(input, ctx);

    expect(result.canvas_id).toBe('canvas0001');
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0]?.name).toBe('water_series_01646500_00060');
    expect(result.tables[0]?.kind).toBe('table');
    expect(result.tables[0]?.row_count).toBe(600);
    expect(result.tables[0]?.columns).toHaveLength(6);
    expect(result.tables[0]?.columns[0]).toEqual({
      name: 'date_time',
      type: 'VARCHAR',
      nullable: false,
    });
  });

  it('passes canvas_id to acquire', async () => {
    const mockInstance = {
      canvasId: 'mycanvasid',
      describe: vi.fn().mockResolvedValue([]),
    };
    const mockAcquire = vi.fn().mockResolvedValue(mockInstance);
    mockCanvasInstance = { acquire: mockAcquire };

    const ctx = createMockContext({ errors: waterDataframeDescribe.errors });
    const input = waterDataframeDescribe.input.parse({ canvas_id: 'mycanvasid' });
    await waterDataframeDescribe.handler(input, ctx);

    expect(mockAcquire).toHaveBeenCalledWith('mycanvasid', ctx);
  });

  it('formats tables as markdown schema', () => {
    const result = {
      canvas_id: 'canvas0001',
      tables: [
        {
          name: 'water_series_01646500_00060',
          kind: 'table' as const,
          row_count: 600,
          columns: [
            { name: 'date_time', type: 'VARCHAR', nullable: false },
            { name: 'value', type: 'VARCHAR', nullable: false },
          ],
        },
      ],
    };
    const blocks = waterDataframeDescribe.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('canvas0001');
    expect(text).toContain('water_series_01646500_00060');
    expect(text).toContain('600');
    expect(text).toContain('date_time');
    expect(text).toContain('VARCHAR');
  });
});

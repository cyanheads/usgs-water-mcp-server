/**
 * @fileoverview Tests for water_dataframe_query tool — SQL SELECT against canvas tables.
 * Mocks the canvas-accessor to avoid live DuckDB.
 * @module tests/tools/water-dataframe-query.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterDataframeQuery } from '@/mcp-server/tools/definitions/water-dataframe-query.tool.js';

let mockCanvasInstance: unknown;

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

const MOCK_QUERY_RESULT = {
  rows: [
    {
      date_time: '2024-01-01',
      value: '5000',
      qualifiers: 'A',
      site_number: '01646500',
      parameter_cd: '00060',
      unit_code: 'ft3/s',
    },
    {
      date_time: '2024-01-02',
      value: '5200',
      qualifiers: 'A',
      site_number: '01646500',
      parameter_cd: '00060',
      unit_code: 'ft3/s',
    },
  ],
  rowCount: 2,
  columns: ['date_time', 'value', 'qualifiers', 'site_number', 'parameter_cd', 'unit_code'],
};

describe('waterDataframeQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
  });

  it('throws canvas_disabled when canvas is not configured', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM water_series_01646500_00060 LIMIT 10',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidRequest,
      data: { reason: 'canvas_disabled' },
    });
  });

  it('canvas_disabled error is agent-facing and omits the CANVAS_PROVIDER_TYPE env var (regression: #8)', async () => {
    mockCanvasInstance = undefined;
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT * FROM water_series_01646500_00060 LIMIT 10',
    });
    const error = (await waterDataframeQuery.handler(input, ctx).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('DataCanvas is not enabled on this server instance.');
    expect(error.message).not.toContain('CANVAS_PROVIDER_TYPE');
  });

  it('throws canvas_not_found when acquire throws not found', async () => {
    mockCanvasInstance = {
      acquire: vi.fn().mockRejectedValue(new Error('canvas NotFound or expired')),
    };
    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'stalecanvas1',
      sql: 'SELECT date_time, value FROM water_series_01646500_00060',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'canvas_not_found' },
    });
  });

  it('throws invalid_sql when query engine rejects the statement', async () => {
    const mockInstance = {
      canvasId: 'canvas0001xx',
      query: vi.fn().mockRejectedValue(new Error('Parser Error: syntax error at SELECT')),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'INVALID SQL HERE',
    });
    await expect(waterDataframeQuery.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_sql' },
    });
  });

  it('returns rows and row_count for a valid SELECT', async () => {
    const mockInstance = {
      canvasId: 'canvas0001xx',
      query: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
    };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const input = waterDataframeQuery.input.parse({
      canvas_id: 'canvas0001xx',
      sql: 'SELECT date_time, value FROM water_series_01646500_00060 ORDER BY date_time LIMIT 10',
    });
    const result = await waterDataframeQuery.handler(input, ctx);

    expect(result.row_count).toBe(2);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.['date_time']).toBe('2024-01-01');
    expect(result.rows[0]?.['value']).toBe('5000');
  });

  it('passes the sql and signal to instance.query', async () => {
    const mockQuery = vi.fn().mockResolvedValue(MOCK_QUERY_RESULT);
    const mockInstance = { canvasId: 'canvas0001xx', query: mockQuery };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterDataframeQuery.errors });
    const sql = 'SELECT AVG(CAST(value AS DOUBLE)) FROM water_series_01646500_00060';
    const input = waterDataframeQuery.input.parse({ canvas_id: 'canvas0001xx', sql });
    await waterDataframeQuery.handler(input, ctx);

    expect(mockQuery).toHaveBeenCalledWith(sql, expect.objectContaining({ signal: ctx.signal }));
  });

  it('formats results as a markdown table with row count', () => {
    const result = {
      rows: MOCK_QUERY_RESULT.rows,
      row_count: 2,
    };
    const blocks = waterDataframeQuery.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('2 row(s)');
    expect(text).toContain('date_time');
    expect(text).toContain('2024-01-01');
    expect(text).toContain('5000');
  });

  it('formats empty result set gracefully', () => {
    const result = { rows: [], row_count: 0 };
    const blocks = waterDataframeQuery.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('0 row(s)');
  });
});

/**
 * @fileoverview Tests for water_get_series tool — time series with DataCanvas spillover.
 * Mocks nwis-service and canvas-accessor to avoid live API/DuckDB calls.
 * @module tests/tools/water-get-series.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetSeries } from '@/mcp-server/tools/definitions/water-get-series.tool.js';
import type { NwisTimeSeries } from '@/services/nwis/types.js';

vi.mock('@/services/nwis/nwis-service.js', () => ({
  getSeries: vi.fn(),
  getReadings: vi.fn(),
  getStats: vi.fn(),
  findSites: vi.fn(),
  getSiteInfo: vi.fn(),
}));

// Canvas mock — undefined (disabled) by default; overridden per test
let mockCanvasInstance: unknown;
vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
}));

// Spy on the spillover helper — only invoked on the canvas path
vi.mock('@cyanheads/mcp-ts-core/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/canvas')>();
  return { ...actual, spillover: vi.fn() };
});

import { spillover } from '@cyanheads/mcp-ts-core/canvas';

const mockSpillover = vi.mocked(spillover);

import { getSeries } from '@/services/nwis/nwis-service.js';

const mockGetSeries = vi.mocked(getSeries);

/** Build a mock time series with N value records. */
function makeSeries(count: number): NwisTimeSeries {
  return {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER AT LITTLE FALLS',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    values: Array.from({ length: count }, (_, i) => ({
      dateTime: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00`,
      value: String(5000 + i * 10),
      qualifiers: ['A'],
    })),
  };
}

describe('waterGetSeries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
  });

  it('returns inline series for small result set (no canvas)', async () => {
    mockGetSeries.mockResolvedValue([makeSeries(10)]);
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-01-10',
    });
    const result = await waterGetSeries.handler(input, ctx);
    expect(result.siteNumber).toBe('01646500');
    expect(result.truncated).toBe(false);
    expect(result.totalRecords).toBe(10);
    expect(result.values).toHaveLength(10);
    expect(result.canvas_id).toBeUndefined();
  });

  it('returns truncated inline (last 500) when >500 records and no canvas', async () => {
    mockGetSeries.mockResolvedValue([makeSeries(800)]);
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    const result = await waterGetSeries.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.totalRecords).toBe(800);
    expect(result.values).toHaveLength(500);
    expect(result.canvas_id).toBeUndefined();
  });

  it('spills to canvas when >500 records and canvas is enabled (spillover path)', async () => {
    const bigSeries = makeSeries(600);
    mockGetSeries.mockResolvedValue([bigSeries]);

    const previewRows = bigSeries.values.slice(0, 5).map((v) => ({
      date_time: v.dateTime,
      value: v.value,
      qualifiers: 'A',
      site_number: '01646500',
      parameter_cd: '00060',
      unit_code: 'ft3/s',
    }));

    mockSpillover.mockResolvedValue({
      spilled: true,
      previewRows,
      handle: { tableName: 'water_series_01646500_00060' },
    } as Awaited<ReturnType<typeof spillover>>);

    const mockInstance = { canvasId: 'canvas0001xx', expiresAt: '2026-07-01T00:00:00Z' };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    const result = await waterGetSeries.handler(input, ctx);

    // Canvas path: truncated=true, canvas_id and table_name present
    expect(result.truncated).toBe(true);
    expect(result.totalRecords).toBe(600);
    expect(result.canvas_id).toBe('canvas0001xx');
    expect(result.table_name).toBe('water_series_01646500_00060');
    expect(result.values).toHaveLength(5);
    // Verify spillover was called with the correct source rows
    expect(mockSpillover).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: mockInstance,
        tableName: expect.stringContaining('water_series_01646500_00060'),
        source: expect.arrayContaining([
          expect.objectContaining({ site_number: '01646500', parameter_cd: '00060' }),
        ]),
      }),
    );
  });

  it('does NOT spill when ≤500 records even if canvas is enabled', async () => {
    mockGetSeries.mockResolvedValue([makeSeries(400)]);
    const mockInstance = { canvasId: 'canvas0002xx', acquire: vi.fn() };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-06-30',
    });
    const result = await waterGetSeries.handler(input, ctx);
    expect(result.truncated).toBe(false);
    expect(mockSpillover).not.toHaveBeenCalled();
    expect(result.canvas_id).toBeUndefined();
  });

  it('rejects non-ISO startDate at Zod parse level (format error)', () => {
    expect(() =>
      waterGetSeries.input.parse({
        site: '01646500',
        parameterCd: '00060',
        startDate: 'June 1 2024',
        endDate: '2024-06-10',
      }),
    ).toThrow();
  });

  it('rejects non-ISO endDate at Zod parse level (format error)', () => {
    expect(() =>
      waterGetSeries.input.parse({
        site: '01646500',
        parameterCd: '00060',
        startDate: '2024-01-01',
        endDate: 'not-a-date',
      }),
    ).toThrow();
  });

  it('throws invalid_date_range for calendar-invalid startDate (month 13)', async () => {
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    // Bypass Zod regex with a raw object — the regex allows YYYY-MM-DD shape, handler validates calendar
    const input = {
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-13-99',
      endDate: '2024-12-31',
      seriesType: 'daily' as const,
    };
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range for rollover startDate (Feb 30 → normalizes to Mar 1)', async () => {
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = {
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-02-30',
      endDate: '2024-12-31',
      seriesType: 'daily' as const,
    };
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws invalid_date_range when endDate is before startDate', async () => {
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-12-31',
      endDate: '2024-01-01',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('throws no_data_for_range when service returns empty array', async () => {
    // NWIS returns timeSeries:[] for both unknown sites and out-of-range dates;
    // no_data_for_range is the more actionable error (callers can retry with a narrower range).
    mockGetSeries.mockResolvedValue([]);
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '99999999',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_range' },
    });
  });

  it('throws no_data_for_range when series has no values', async () => {
    mockGetSeries.mockResolvedValue([makeSeries(0)]);
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '1800-01-01',
      endDate: '1800-12-31',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_range' },
    });
  });

  it('maps service ValidationError to invalid_date_range', async () => {
    mockGetSeries.mockRejectedValue(
      new Error('NWIS rejected the request: ValidationError date out of bounds'),
    );
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_date_range' },
    });
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockGetSeries.mockRejectedValue(new Error('NWIS service unavailable'));
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats inline series as markdown with value rows', () => {
    const series = makeSeries(5);
    const result = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
      seriesType: 'daily' as const,
      values: series.values,
      totalRecords: 5,
      truncated: false,
      canvas_id: undefined,
      table_name: undefined,
    };
    const blocks = waterGetSeries.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    expect(text).toContain('00060');
    expect(text).toContain('Streamflow');
    expect(text).toContain('5');
  });

  it('formats truncated canvas result with canvas_id reference', () => {
    const result = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
      seriesType: 'daily' as const,
      values: makeSeries(5).values,
      totalRecords: 600,
      truncated: true,
      canvas_id: 'canvas0001xx',
      table_name: 'water_series_01646500_00060',
    };
    const blocks = waterGetSeries.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('canvas0001xx');
    expect(text).toContain('water_series_01646500_00060');
    expect(text).toContain('water_dataframe_query');
  });
});

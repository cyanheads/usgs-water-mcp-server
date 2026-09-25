/**
 * @fileoverview Tests for water_get_series tool — time series with DataCanvas spillover.
 * Mocks nwis-service and canvas-accessor to avoid live API/DuckDB calls.
 * @module tests/tools/water-get-series.tool.test
 */

import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetSeries } from '@/mcp-server/tools/definitions/water-get-series.tool.js';
import type { NwisTimeSeries } from '@/services/nwis/types.js';
import { textContent } from '../helpers/content-block.js';
import { captureError, declaredRecovery } from '../helpers/error-contract.js';

const recovery = (reason: string) => declaredRecovery(waterGetSeries.errors, reason);

// Stub the network calls; keep the real classifyNwisFailure — it is pure, and it is the mapping
// under test here.
vi.mock('@/services/nwis/nwis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nwis/nwis-service.js')>()),
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

import { CANVAS_IDENTIFIER_REGEX, spillover } from '@cyanheads/mcp-ts-core/canvas';

const mockSpillover = vi.mocked(spillover);

import { getSeries } from '@/services/nwis/nwis-service.js';

const mockGetSeries = vi.mocked(getSeries);

/** Build a mock time series with N chronological value records, oldest first. */
function makeSeries(count: number, overrides: Partial<NwisTimeSeries> = {}): NwisTimeSeries {
  return {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER AT LITTLE FALLS',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    methodId: '68478',
    methodDescription: null,
    statCd: '00003',
    statName: 'Mean',
    values: Array.from({ length: count }, (_, i) => ({
      dateTime: `2024-01-${String(i + 1).padStart(2, '0')}T00:00:00`,
      value: String(5000 + i * 10),
      qualifiers: ['A'],
    })),
    ...overrides,
  };
}

/**
 * A `format()` argument carrying the series metadata every formatting case shares, so each test
 * states only its own delta — the inline slice, the upstream count, and the canvas fields.
 */
function formatResult(
  overrides: {
    values?: NwisTimeSeries['values'];
    totalRecords?: number;
    truncated?: boolean;
    canvas_id?: string;
    table_name?: string;
  } = {},
) {
  return {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    seriesType: 'daily' as const,
    statCd: '00003',
    statName: 'Mean',
    methodId: '68478',
    methodDescription: null,
    values: overrides.values ?? makeSeries(5).values,
    totalRecords: overrides.totalRecords ?? 5,
    truncated: overrides.truncated ?? false,
    canvas_id: overrides.canvas_id,
    table_name: overrides.table_name,
    otherSeries: [],
  };
}

/** The canonical spilling query — a range wide enough that every canvas test starts from it. */
const SPILLING_INPUT = {
  site: '01646500',
  parameterCd: '00060',
  startDate: '2023-01-01',
  endDate: '2024-12-31',
} as const;

/** Install a canvas mock whose acquire resolves to a fixed instance. */
function stageCanvas(canvasId = 'canvas0001') {
  const acquire = vi.fn().mockResolvedValue({ canvasId });
  mockCanvasInstance = { acquire };
  return { acquire };
}

/**
 * Drive the spillover mock off the rows the handler actually passes: preview the FIRST
 * `previewCount` of them, as the real helper does, and echo back the table name the handler
 * derived. Assertions then read the tail-slicing and the name derivation under test rather than a
 * literal fixed by the mock. `spilled: false` models a source that fit the character budget whole.
 */
function mockSpill(previewCount: number, { spilled = true }: { spilled?: boolean } = {}) {
  mockSpillover.mockImplementation(async (opts) => {
    const rows = [...(opts.source as Iterable<Record<string, unknown>>)];
    if (!spilled) return { spilled: false, previewRows: rows };
    return {
      spilled: true,
      previewRows: rows.slice(0, previewCount),
      handle: {
        tableName: opts.tableName ?? 'spilled_00000000',
        columns: Object.keys(rows[0] ?? {}),
        rowCount: rows.length,
      },
      truncated: false,
    };
  });
}

/** The table name the handler derived on its first (only) spillover call. */
function spilledTableName(callIndex = 0): string {
  const tableName = mockSpillover.mock.calls[callIndex]?.[0]?.tableName;
  if (!tableName) throw new Error('spillover() was not called with a derived table name.');
  return tableName;
}

/** The rows the handler handed to spillover(), in the order it handed them over. */
function spilledRows(callIndex = 0): Record<string, unknown>[] {
  const source = mockSpillover.mock.calls[callIndex]?.[0]?.source;
  if (!source) throw new Error('spillover() was not called.');
  return [...(source as Iterable<Record<string, unknown>>)];
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
    mockGetSeries.mockResolvedValue([makeSeries(600)]);
    stageCanvas();
    mockSpill(5);

    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse(SPILLING_INPUT);
    const result = await waterGetSeries.handler(input, ctx);

    // Canvas path: truncated=true, canvas_id and table_name present
    expect(result.truncated).toBe(true);
    expect(result.totalRecords).toBe(600);
    expect(result.canvas_id).toBe('canvas0001');
    expect(result.table_name).toBe('water_series_01646500_00060_dv_20230101_20241231');
    expect(result.values).toHaveLength(5);

    // #19 regression: the spillover notice must report the ACTUAL preview count
    // (previewRows.length — 5 here), not the fixed SPILLOVER_THRESHOLD (500). spillover() sizes its
    // preview by a character budget, so the real count varies and this test's mock (5 rows against a
    // 500 threshold) is exactly the mismatch the old hardcoded notice got wrong.
    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('Showing last 5 of 600 records');
    expect(notice).not.toContain('last 500 of');
    expect(notice).toContain('Staged all 600 records'); // totalRecords named accurately

    // Verify spillover was called with the correct source rows
    expect(mockSpillover).toHaveBeenCalledWith(
      expect.objectContaining({
        canvas: expect.objectContaining({ canvasId: 'canvas0001' }),
        tableName: 'water_series_01646500_00060_dv_20230101_20241231',
        source: expect.arrayContaining([
          expect.objectContaining({ site_number: '01646500', parameter_cd: '00060' }),
        ]),
      }),
    );
  });

  it('does NOT spill when ≤500 records even if canvas is enabled', async () => {
    mockGetSeries.mockResolvedValue([makeSeries(400)]);
    const mockInstance = { canvasId: 'canvas0002', acquire: vi.fn() };
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
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range', recovery: recovery('invalid_date_range') },
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
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range', recovery: recovery('invalid_date_range') },
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
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_date_range', recovery: recovery('invalid_date_range') },
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
      data: { reason: 'no_data_for_range', recovery: recovery('no_data_for_range') },
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
      data: { reason: 'no_data_for_range', recovery: recovery('no_data_for_range') },
    });
  });

  it('maps an NWIS rejection to invalid_request, not invalid_date_range', async () => {
    // The dates here are valid — NWIS is complaining about the parameter code. Reporting this as
    // a date-range problem sends the caller after the wrong field.
    mockGetSeries.mockRejectedValue(
      validationError(
        'NWIS rejected the request: HTTP Status 400 - ParameterCd: length must be no less than 5 characters',
        { httpStatus: 400 },
      ),
    );
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
      message: expect.stringContaining('ParameterCd'),
    });
  });

  it('still reports the handler-owned date checks as invalid_date_range', async () => {
    // invalid_date_range survives for the case it actually describes: this tool's own
    // calendar/order validation, which never reaches NWIS.
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-12-31',
      endDate: '2024-01-01',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_date_range', recovery: recovery('invalid_date_range') },
    });
    expect(mockGetSeries).not.toHaveBeenCalled();
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockGetSeries.mockRejectedValue(
      serviceUnavailable('NWIS returned HTTP 503: Service Unavailable', { status: 503 }),
    );
    const ctx = createMockContext({ errors: waterGetSeries.errors });
    const input = waterGetSeries.input.parse({
      site: '01646500',
      parameterCd: '00060',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    });
    await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
    });
  });

  it('rejects a malformed parameterCd at Zod parse level, before any NWIS call', () => {
    expect(() =>
      waterGetSeries.input.parse({
        site: '01646500',
        parameterCd: 'BAD',
        startDate: '2024-01-01',
        endDate: '2024-01-03',
      }),
    ).toThrow();
    expect(mockGetSeries).not.toHaveBeenCalled();
  });

  it('rejects a comma-separated parameterCd (this tool returns a single series)', () => {
    expect(() =>
      waterGetSeries.input.parse({
        site: '01646500',
        parameterCd: '00060,00065',
        startDate: '2024-01-01',
        endDate: '2024-01-03',
      }),
    ).toThrow();
  });

  it('rejects a malformed site at Zod parse level', () => {
    expect(() =>
      waterGetSeries.input.parse({
        site: 'BADSITE',
        parameterCd: '00060',
        startDate: '2024-01-01',
        endDate: '2024-01-03',
      }),
    ).toThrow();
  });

  it('formats inline series as markdown with value rows', () => {
    const blocks = waterGetSeries.format!(formatResult());
    const text = textContent(blocks[0]);
    expect(text).toContain('01646500');
    expect(text).toContain('00060');
    expect(text).toContain('Streamflow');
    expect(text).toContain('5');
  });

  it('renders every value record in content[], mirroring structuredContent.values (regression: #16)', () => {
    // 500 records = the no-canvas cap ceiling and well past the old inline 20-record preview slice.
    // format-parity cannot catch this: it synthesizes a 1-element array, so a formatter that only
    // rendered the last 20 passed trivially. Measure real format() output against a worst-case set.
    const series = makeSeries(500);
    const blocks = waterGetSeries.format!(
      formatResult({ values: series.values, totalRecords: 500 }),
    );
    const text = textContent(blocks[0]);

    // The first record — dropped by the old `slice(-20)` — is now present in content[].
    expect(text).toContain('2024-01-01T00:00:00');
    // Every value renders as its own bullet line: content[] carries all 500, not a 20-record preview.
    const valueLines = text.split('\n').filter((l) => l.startsWith('- '));
    expect(valueLines).toHaveLength(500);
    // The stale "showing 20 of N inline records" caption is gone (it no longer applies).
    expect(text).not.toContain('showing 20 of');
  });

  it('formats truncated canvas result with canvas_id reference', () => {
    const blocks = waterGetSeries.format!(
      formatResult({
        totalRecords: 600,
        truncated: true,
        canvas_id: 'canvas0001',
        table_name: 'water_series_01646500_00060_dv_20230101_20241231',
      }),
    );
    const text = textContent(blocks[0]);
    expect(text).toContain('canvas0001');
    expect(text).toContain('water_series_01646500_00060_dv_20230101_20241231');
    expect(text).toContain('water_dataframe_query');
  });

  describe('missing records on the canvas (#45)', () => {
    it('stages a record NWIS reported as no data with a null value, keeping its qualifiers', async () => {
      const series = makeSeries(600);
      series.values[0] = { dateTime: '2024-01-01T00:00:00', value: '', qualifiers: ['P', 'Ice'] };
      mockGetSeries.mockResolvedValue([series]);
      stageCanvas();
      mockSpill(5);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      const rows = spilledRows();
      expect(rows[0]).toMatchObject({ value: null, qualifiers: 'P,Ice' });
      // A measured record keeps its value string.
      expect(rows[1]?.['value']).toBe(series.values[1]?.value);
    });
  });

  describe('preview orientation (#27)', () => {
    it('inlines the most recent records on the canvas path, not the oldest', async () => {
      // spillover() previews the HEAD of its source, so reading `previewRows` straight back dropped
      // the newest records — the end of a time series that almost always carries the answer.
      const series = makeSeries(600);
      mockGetSeries.mockResolvedValue([series]);
      stageCanvas();
      mockSpill(5);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const result = await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      expect(result.values).toEqual(series.values.slice(-5));
      expect(result.values.at(-1)).toEqual(series.values.at(-1));
      expect(result.values[0]).not.toEqual(series.values[0]);
    });

    it('stages every record chronologically while the inline slice comes off the tail', async () => {
      const series = makeSeries(600);
      mockGetSeries.mockResolvedValue([series]);
      stageCanvas();
      mockSpill(5);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      // Reversing the source to orient the preview would have reversed the staged table with it.
      const rows = spilledRows();
      expect(rows).toHaveLength(600);
      expect(rows[0]?.['date_time']).toBe(series.values[0]?.dateTime);
      expect(rows.at(-1)?.['date_time']).toBe(series.values.at(-1)?.dateTime);
    });

    it('keeps the no-canvas path on the most recent 500 (characterization)', async () => {
      const series = makeSeries(800);
      mockGetSeries.mockResolvedValue([series]);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const result = await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      expect(result.values).toEqual(series.values.slice(-500));
      expect(getEnrichment(ctx).notice).toContain('the most recent 500 of 800 records');
    });

    it('inlines nothing when the preview budget fits no rows at all', async () => {
      // The boundary that makes a negative slice offset wrong: slice(-0) returns the WHOLE array,
      // which would silently inline all 600 records under a "preview" caption.
      mockGetSeries.mockResolvedValue([makeSeries(600)]);
      stageCanvas();
      mockSpill(0);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const result = await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      expect(result.values).toEqual([]);
      expect(result.totalRecords).toBe(600);
      expect(result.truncated).toBe(true);
    });

    it('names the direction in the canvas caption, not just the no-canvas one', () => {
      const canvasText = textContent(
        waterGetSeries.format!(
          formatResult({
            totalRecords: 600,
            truncated: true,
            canvas_id: 'canvas0001',
            table_name: 'water_series_01646500_00060_dv_20230101_20241231',
          }),
        )[0],
      );

      expect(canvasText).toContain('showing last 5 of 600 records');
    });

    it('states in the values description and the tool description which end is returned', () => {
      expect(waterGetSeries.output.shape.values.description).toMatch(/most recent/i);
      expect(waterGetSeries.description).toMatch(/most recent/i);
    });
  });

  describe('canvas table naming (#28)', () => {
    /** Derive a staged table name for one query, from a clean mock slate. */
    async function stagedNameFor(
      overrides: Record<string, unknown> = {},
      series = makeSeries(600),
    ) {
      vi.clearAllMocks();
      mockGetSeries.mockResolvedValue([series]);
      stageCanvas();
      mockSpill(5);
      const ctx = createMockContext({ errors: waterGetSeries.errors });
      await waterGetSeries.handler(
        waterGetSeries.input.parse({ ...SPILLING_INPUT, ...overrides }),
        ctx,
      );
      return spilledTableName();
    }

    it('carries site, parameter code, series type, and both range bounds', async () => {
      expect(await stagedNameFor()).toBe('water_series_01646500_00060_dv_20230101_20241231');
    });

    it('abbreviates the series type so the name fits the identifier cap', async () => {
      expect(await stagedNameFor({ seriesType: 'instantaneous' })).toBe(
        'water_series_01646500_00060_iv_20230101_20241231',
      );
    });

    it('is idempotent — the identical query re-stages to the same table', async () => {
      expect(await stagedNameFor()).toBe(await stagedNameFor());
    });

    it('separates two queries whose staged rows differ', async () => {
      // The #28 repro: a daily and an instantaneous staging of one site previously collapsed onto
      // one name — different quantities, identical columns, no way to tell them apart.
      const base = await stagedNameFor();
      for (const overrides of [
        { seriesType: 'instantaneous' },
        { startDate: '2010-01-01' },
        { endDate: '2024-12-30' },
        { parameterCd: '00065' },
      ]) {
        expect(await stagedNameFor(overrides)).not.toBe(base);
      }
      expect(
        await stagedNameFor({ site: '01646501' }, makeSeries(600, { siteNumber: '01646501' })),
      ).not.toBe(base);
    });

    it('stays a legal identifier at the 15-digit-site worst case', async () => {
      const name = await stagedNameFor(
        { site: '123456789012345', seriesType: 'instantaneous' },
        makeSeries(600, { siteNumber: '123456789012345' }),
      );

      expect(name).toBe('water_series_123456789012345_00060_iv_20230101_20241231');
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(CANVAS_IDENTIFIER_REGEX);
    });

    it('is unchanged by canvas_id — the same query accumulates under one name', async () => {
      expect(await stagedNameFor({ canvas_id: 'canvas0001' })).toBe(await stagedNameFor());
    });

    it('describes canvas_id as adding a table, not appending to one', () => {
      const description = waterGetSeries.input.shape.canvas_id.description ?? '';
      expect(description).not.toMatch(/append/i);
      expect(description).toMatch(/table/i);
    });
  });

  describe('canvas table naming across statistics and methods (#43)', () => {
    /** Three series one daily query can return: a maximum and two mean sensors. */
    const offered = () => [
      makeSeries(600, { statCd: '00001', statName: 'Maximum', methodId: '11' }),
      makeSeries(600, { statCd: '00003', statName: 'Mean', methodId: '31' }),
      makeSeries(600, { statCd: '00003', statName: 'Mean', methodId: '32' }),
    ];

    /** Stage one selection out of `list` and return the derived table name and staged rows. */
    async function stage(overrides: Record<string, unknown>, list: NwisTimeSeries[] = offered()) {
      vi.clearAllMocks();
      mockGetSeries.mockResolvedValue(list);
      stageCanvas();
      mockSpill(5);
      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const result = await waterGetSeries.handler(
        waterGetSeries.input.parse({ ...SPILLING_INPUT, ...overrides }),
        ctx,
      );
      return { name: spilledTableName(), rows: spilledRows(), result };
    }

    it('gives each statistic and method selected from one query its own table', async () => {
      const selections = [{}, { statCd: '00001' }, { methodId: '32' }];
      const staged = [];
      for (const selection of selections) staged.push(await stage(selection));

      expect(staged.map((s) => [s.result.statCd, s.result.methodId])).toEqual([
        ['00003', '31'],
        ['00001', '11'],
        ['00003', '32'],
      ]);
      expect(new Set(staged.map((s) => s.name)).size).toBe(3);
      for (const { name } of staged) {
        expect(name).toMatch(/^water_series_01646500_00060_dv_20230101_20241231_[0-9a-f]{7}$/);
      }
    });

    it('names a selection the same way however it was reached', async () => {
      // The default pick and an explicit request for the same series stage identical rows.
      expect((await stage({})).name).toBe((await stage({ statCd: '00003', methodId: '31' })).name);
    });

    it('suffixes a filtered request even when NWIS returned one series', async () => {
      const bare = await stage({}, [makeSeries(600)]);
      const filtered = await stage({ statCd: '00003' }, [makeSeries(600)]);

      expect(bare.name).toBe('water_series_01646500_00060_dv_20230101_20241231');
      expect(filtered.name).not.toBe(bare.name);
    });

    it('stays a legal identifier at the 15-digit-site worst case with a selection suffix', async () => {
      const { name } = await stage(
        { site: '123456789012345', seriesType: 'instantaneous', methodId: '31' },
        offered().map((s) => ({ ...s, siteNumber: '123456789012345' })),
      );

      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(CANVAS_IDENTIFIER_REGEX);
    });

    it('falls back to the first statistic with values when the mean came back empty', async () => {
      const { result } = await stage({}, [
        makeSeries(600, { statCd: '00001', statName: 'Maximum', methodId: '11' }),
        makeSeries(0, { statCd: '00003', statName: 'Mean', methodId: '31' }),
      ]);

      expect(result).toMatchObject({ statCd: '00001', methodId: '11', totalRecords: 600 });
      expect(result.otherSeries).toEqual([
        {
          statCd: '00003',
          statName: 'Mean',
          methodId: '31',
          methodDescription: null,
          recordCount: 0,
        },
      ]);
    });

    it('stages the statistic and method on every row', async () => {
      const { rows } = await stage({ statCd: '00001' });
      expect(rows[0]).toMatchObject({ stat_cd: '00001', method_id: '11' });
      expect(rows.at(-1)).toMatchObject({ stat_cd: '00001', method_id: '11' });
    });
  });

  describe('canvas handoff notice (#34)', () => {
    it('names water_dataframe_describe before water_dataframe_query and carries the table name', async () => {
      mockGetSeries.mockResolvedValue([makeSeries(600)]);
      stageCanvas();
      mockSpill(5);
      const result = await runToolContract(waterGetSeries, SPILLING_INPUT);
      const tableName = spilledTableName();

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain('water_dataframe_describe');
      expect(notice.indexOf('water_dataframe_describe')).toBeLessThan(
        notice.indexOf('water_dataframe_query'),
      );
      expect(notice).toContain(tableName);
      expect(notice).toContain('canvas0001');

      // content[] gets the same pointer — the format() caption plus the enrichment trailer.
      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).toContain('water_dataframe_describe');
      expect(rendered.indexOf('water_dataframe_describe')).toBeLessThan(
        rendered.indexOf('water_dataframe_query'),
      );
      expect(rendered).toContain(tableName);
    });

    it('names water_dataframe_describe before water_dataframe_query in the canvas caption', () => {
      // content[0] is the block a text-only client renders first; an agent that reads only this one
      // has to learn the describe-then-query order from it, not from the schema.
      const text = textContent(
        waterGetSeries.format!(
          formatResult({
            totalRecords: 600,
            truncated: true,
            canvas_id: 'canvas0001',
            table_name: 'water_series_01646500_00060_dv_20230101_20241231',
          }),
        )[0],
      );

      expect(text).toContain('water_dataframe_describe');
      expect(text.indexOf('water_dataframe_describe')).toBeLessThan(
        text.indexOf('water_dataframe_query'),
      );
    });
  });

  describe('canvas error contract (#39)', () => {
    it('declares canvas_not_found and canvas_capacity_exhausted as service-thrown', () => {
      const byReason = Object.fromEntries(waterGetSeries.errors!.map((e) => [e.reason, e]));

      expect(byReason['canvas_not_found']).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        thrownBy: 'service',
      });
      expect(byReason['canvas_capacity_exhausted']).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        retryable: true,
        thrownBy: 'service',
      });
    });

    it('re-throws canvas_not_found with a hint naming the omit-for-a-fresh-canvas path', async () => {
      // The framework's own hint deliberately avoids suggesting omission — correct for a
      // describe/query tool, wrong for a producer, which mints a usable canvas when asked to.
      mockGetSeries.mockResolvedValue([makeSeries(600)]);
      mockCanvasInstance = {
        acquire: vi
          .fn()
          .mockRejectedValue(
            notFound('Canvas aaaaaaaaaa not found.', { reason: 'canvas_not_found' }),
          ),
      };

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const input = waterGetSeries.input.parse({ ...SPILLING_INPUT, canvas_id: 'aaaaaaaaaa' });
      const error = (await captureError(() => waterGetSeries.handler(input, ctx))) as McpError;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
      });
      expect(error.data?.['recovery']).toMatchObject({ hint: expect.stringMatching(/omit/i) });
      expect(error.cause).toBeInstanceOf(McpError);
    });

    it('lets an unrelated acquire failure through untouched', async () => {
      mockGetSeries.mockResolvedValue([makeSeries(600)]);
      mockCanvasInstance = {
        acquire: vi.fn().mockRejectedValue(serviceUnavailable('canvas provider is down')),
      };

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const input = waterGetSeries.input.parse({ ...SPILLING_INPUT, canvas_id: 'aaaaaaaaaa' });
      const error = (await captureError(() => waterGetSeries.handler(input, ctx))) as McpError;

      expect(error.data?.['reason']).toBeUndefined();
      expect(error.message).toContain('canvas provider is down');
    });
  });

  describe('supplied canvas_id resolution (#40)', () => {
    it('resolves a supplied canvas_id before the NWIS request', async () => {
      const acquire = vi
        .fn()
        .mockRejectedValue(
          notFound('Canvas aaaaaaaaaa not found.', { reason: 'canvas_not_found' }),
        );
      mockCanvasInstance = { acquire };
      mockGetSeries.mockResolvedValue([makeSeries(600)]);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const input = waterGetSeries.input.parse({ ...SPILLING_INPUT, canvas_id: 'aaaaaaaaaa' });
      await expect(waterGetSeries.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'canvas_not_found' },
      });

      // A bad id costs no upstream round trip.
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(mockGetSeries).not.toHaveBeenCalled();
    });

    it('keeps minting lazy — no canvas is acquired when none was supplied and nothing spills', async () => {
      mockGetSeries.mockResolvedValue([makeSeries(400)]);
      const { acquire } = stageCanvas();

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      expect(acquire).not.toHaveBeenCalled();
      expect(mockSpillover).not.toHaveBeenCalled();
    });

    it('reuses the pre-resolved canvas rather than acquiring twice when the series spills', async () => {
      mockGetSeries.mockResolvedValue([makeSeries(600)]);
      const { acquire } = stageCanvas();
      mockSpill(5);

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const input = waterGetSeries.input.parse({ ...SPILLING_INPUT, canvas_id: 'canvas0001' });
      const result = await waterGetSeries.handler(input, ctx);

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(acquire).toHaveBeenCalledWith('canvas0001', ctx);
      expect(result.canvas_id).toBe('canvas0001');
    });

    it('says on both surfaces that nothing was staged when the series comes back inline', async () => {
      mockGetSeries.mockResolvedValue([makeSeries(400)]);
      stageCanvas();
      const result = await runToolContract(waterGetSeries, {
        ...SPILLING_INPUT,
        canvas_id: 'canvas0001',
      });

      const structured = result.structuredContent as { notice?: string; canvas_id?: string };
      expect(structured.notice).toContain('canvas0001');
      expect(structured.notice).toMatch(/nothing was staged/i);
      expect(structured.canvas_id).toBeUndefined();

      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).toContain('canvas0001');
      expect(rendered).toMatch(/nothing was staged/i);
    });

    it('says the same when the series clears the record threshold but fits the preview budget', async () => {
      // spillover() gates on characters, not records: past 500 rows it can still register nothing,
      // and a supplied canvas_id goes just as unused as it does below the threshold.
      mockGetSeries.mockResolvedValue([makeSeries(600)]);
      stageCanvas();
      mockSpill(0, { spilled: false });

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      const input = waterGetSeries.input.parse({ ...SPILLING_INPUT, canvas_id: 'canvas0001' });
      const result = await waterGetSeries.handler(input, ctx);

      expect(result.truncated).toBe(false);
      expect(result.values).toHaveLength(600);
      expect(result.canvas_id).toBeUndefined();
      expect(result.table_name).toBeUndefined();
      expect(getEnrichment(ctx).notice).toMatch(/nothing was staged on canvas "canvas0001"/);
    });

    it('names the unused canvas on a truncated result with no provider enabled', async () => {
      // mockCanvasInstance stays undefined — over the threshold, but nothing can be staged, so the
      // truncation notice alone would leave the supplied id unaccounted for.
      mockGetSeries.mockResolvedValue([makeSeries(800)]);
      const result = await runToolContract(waterGetSeries, {
        ...SPILLING_INPUT,
        canvas_id: 'canvas0001',
      });

      const structured = result.structuredContent as { notice?: string; canvas_id?: string };
      expect(structured.notice).toContain('the most recent 500 of 800 records');
      expect(structured.notice).toMatch(/DataCanvas is not enabled/);
      expect(structured.notice).toContain('canvas0001');
      expect(structured.canvas_id).toBeUndefined();

      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).toContain('DataCanvas is not enabled');
    });

    it('emits no such notice when no canvas_id was supplied', async () => {
      mockGetSeries.mockResolvedValue([makeSeries(400)]);
      stageCanvas();

      const ctx = createMockContext({ errors: waterGetSeries.errors });
      await waterGetSeries.handler(waterGetSeries.input.parse(SPILLING_INPUT), ctx);

      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });
  });
});

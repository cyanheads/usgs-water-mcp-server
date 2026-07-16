/**
 * @fileoverview Tests for water_get_conditions tool — current value with historical percentile context.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-get-conditions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetConditions } from '@/mcp-server/tools/definitions/water-get-conditions.tool.js';
import type { NwisStatResult, NwisStatRow, NwisTimeSeries } from '@/services/nwis/types.js';

vi.mock('@/services/nwis/nwis-service.js', () => ({
  getReadings: vi.fn(),
  getStats: vi.fn(),
  getSeries: vi.fn(),
  findSites: vi.fn(),
  getSiteInfo: vi.fn(),
}));

import { getReadings, getStats } from '@/services/nwis/nwis-service.js';

const mockGetReadings = vi.mocked(getReadings);
const mockGetStats = vi.mocked(getStats);

/** A deterministic date that maps to month=6, day=4 for stat lookup. */
const CURRENT_DATETIME = '2026-06-04T14:15:00-04:00';

const MOCK_IV: NwisTimeSeries[] = [
  {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER AT LITTLE FALLS',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    values: [
      { dateTime: '2026-06-04T14:00:00-04:00', value: '5000', qualifiers: ['A'] },
      { dateTime: CURRENT_DATETIME, value: '6000', qualifiers: ['A'] },
    ],
  },
];

/**
 * A June stat row for one calendar day. Only dayNu and p50 vary — every threshold that drives the
 * percentile class is held constant, so asserting p50 identifies which day's row was matched
 * without perturbing the classification.
 */
function statRowForDay(dayNu: number, p50: number): NwisStatRow {
  return {
    monthNu: 6,
    dayNu,
    beginYr: 1930,
    endYr: 2025,
    countNu: 95,
    p05: 2000,
    p10: 3000,
    p25: 4500,
    p50,
    p75: 9000,
    p95: 14000,
    maxVa: 22000,
    minVa: 800,
    meanVa: 7000,
  };
}

/** Stat result with a row for June 4 (month=6, day=4). */
const MOCK_STAT: NwisStatResult = {
  siteNumber: '01646500',
  parameterCd: '00060',
  rows: [statRowForDay(4, 6000)],
};

/** Stat rows for three adjacent calendar days, each carrying a distinct p50. */
const MOCK_STAT_ADJACENT_DAYS: NwisStatResult = {
  siteNumber: '01646500',
  parameterCd: '00060',
  rows: [statRowForDay(27, 4990), statRowForDay(28, 4780), statRowForDay(29, 4610)],
};

/** p50 of the June 28 row — the calendar day every timestamp in the date-selection cases names. */
const JUNE_28_P50 = 4780;

describe('waterGetConditions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns current value with percentile classification (normal)', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.siteNumber).toBe('01646500');
    expect(result.currentValue).toBe('6000');
    expect(result.qualifiers).toContain('A');
    expect(result.historicalContext).not.toBeNull();
    // 6000 is at p50 — sits in p25–p75 → normal
    expect(result.historicalContext?.percentileClass).toBe('normal');
    expect(result.historicalContext?.percentileLabel).toBe('25th–75th percentile');
    expect(result.historicalContext?.periodOfRecord).toBe('1930–2025');
  });

  it('classifies record-high when value >= p95', async () => {
    const highIv: NwisTimeSeries[] = [
      {
        ...MOCK_IV[0]!,
        values: [{ dateTime: CURRENT_DATETIME, value: '20000', qualifiers: ['P'] }],
      },
    ];
    mockGetReadings.mockResolvedValue(highIv);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.historicalContext?.percentileClass).toBe('record-high');
    // The class name says "record"; the label is what tells a consumer it is a percentile extreme.
    expect(result.historicalContext?.percentileLabel).toBe(
      '≥ 95th percentile (percentile-of-record extreme, not a verified all-time record)',
    );
  });

  it('classifies record-low when value < p05', async () => {
    const lowIv: NwisTimeSeries[] = [
      { ...MOCK_IV[0]!, values: [{ dateTime: CURRENT_DATETIME, value: '500', qualifiers: ['P'] }] },
    ];
    mockGetReadings.mockResolvedValue(lowIv);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.historicalContext?.percentileClass).toBe('record-low');
    expect(result.historicalContext?.percentileLabel).toBe(
      '< 5th percentile (percentile-of-record extreme, not a verified all-time record)',
    );
  });

  /**
   * The stat table's month_nu/day_nu are plain calendar integers, so the row must be chosen from
   * the observation's own calendar date — the date the NWIS timestamp already states. Converting
   * through `Date` re-projects the instant into whatever timezone the runner happens to be in and
   * lands on a neighboring row near midnight.
   *
   * Each case below names June 28 and asserts June 28's p50. The three offsets are chosen so no
   * runner timezone passes all three against a local-time lookup: the first fails west of -04:00,
   * the second east of it, and the third — a positive offset, which US territory coverage reaches
   * — fails everywhere but the far-eastern zones, closing the gap at -04:00 itself where the first
   * two coincidentally agree. UTC getters are no substitute either: they resolve the first case and
   * fail the third.
   */
  describe('stat row selection follows the observation date, not the runtime timezone', () => {
    async function conditionsAt(dateTime: string) {
      mockGetReadings.mockResolvedValue([
        { ...MOCK_IV[0]!, values: [{ dateTime, value: '6000', qualifiers: ['P'] }] },
      ]);
      mockGetStats.mockResolvedValue(MOCK_STAT_ADJACENT_DAYS);
      const ctx = createMockContext({ errors: waterGetConditions.errors });
      const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
      return waterGetConditions.handler(input, ctx);
    }

    it('matches June 28 for a reading just after midnight at -04:00', async () => {
      // 2026-06-28T04:50Z — a runner behind -04:00 (e.g. US Pacific) reads this back as June 27.
      const result = await conditionsAt('2026-06-28T00:50:00.000-04:00');
      expect(result.historicalContext?.p50).toBe(JUNE_28_P50);
    });

    it('matches June 28 for a reading just before midnight at -04:00', async () => {
      // 2026-06-29T03:50Z — a runner ahead of -04:00 (e.g. UTC on CI) reads this forward as June 29.
      const result = await conditionsAt('2026-06-28T23:50:00.000-04:00');
      expect(result.historicalContext?.p50).toBe(JUNE_28_P50);
    });

    it('matches June 28 for a reading just after midnight at +10:00', async () => {
      // 2026-06-27T14:30Z — Guam is a US territory NWIS covers. Every runner behind +09:30 reads
      // this back as June 27.
      const result = await conditionsAt('2026-06-28T00:30:00.000+10:00');
      expect(result.historicalContext?.p50).toBe(JUNE_28_P50);
    });
  });

  it('returns historicalContext: null with note when stat data is unavailable (new site)', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV);
    mockGetStats.mockResolvedValue({ siteNumber: '01646500', parameterCd: '00060', rows: [] });

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    // Partial success — not a throw
    expect(result.currentValue).toBe('6000');
    expect(result.historicalContext).toBeNull();
    expect(result.note).toBeDefined();
    expect(result.note).toContain('No historical');
  });

  it('returns historicalContext: null when stat service throws (non-fatal)', async () => {
    mockGetReadings.mockResolvedValue(MOCK_IV);
    mockGetStats.mockRejectedValue(new Error('stat service unavailable'));

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    const result = await waterGetConditions.handler(input, ctx);

    expect(result.currentValue).toBe('6000');
    expect(result.historicalContext).toBeNull();
  });

  it('throws no_data_for_parameter when IV returns empty (ambiguous: site not found or no data)', async () => {
    mockGetReadings.mockResolvedValue([]);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '99999999', parameterCd: '00060' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter' },
    });
  });

  it('throws no_data_for_parameter when IV series has no values', async () => {
    mockGetReadings.mockResolvedValue([{ ...MOCK_IV[0]!, values: [] }]);
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '99999' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter' },
    });
  });

  it('maps 5xx on IV call to upstream_error', async () => {
    mockGetReadings.mockRejectedValue(new Error('NWIS service unavailable'));
    mockGetStats.mockResolvedValue(MOCK_STAT);

    const ctx = createMockContext({ errors: waterGetConditions.errors });
    const input = waterGetConditions.input.parse({ site: '01646500', parameterCd: '00060' });
    await expect(waterGetConditions.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats result with current value and percentile class', () => {
    const result = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER AT LITTLE FALLS',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
      currentValue: '6000',
      currentDateTime: CURRENT_DATETIME,
      qualifiers: ['A'],
      historicalContext: {
        percentileClass: 'normal' as const,
        percentileLabel: '25th–75th percentile',
        p05: 2000,
        p10: 3000,
        p25: 4500,
        p50: 6000,
        p75: 9000,
        p95: 14000,
        periodOfRecord: '1930–2025',
      },
      note: undefined,
    };
    const blocks = waterGetConditions.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    expect(text).toContain('6000');
    expect(text).toContain('[A]');
    expect(text).toContain('normal');
    expect(text).toContain('1930–2025');
    expect(text).toContain('p50=6000');
    // structuredContent and content[] must carry the same data — the label is not schema-only.
    expect(text).toContain('25th–75th percentile');
  });

  it('formats result with null historicalContext gracefully', () => {
    const result = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER',
      parameterCd: '00060',
      parameterName: 'Streamflow, ft³/s',
      unitCode: 'ft3/s',
      currentValue: '6000',
      currentDateTime: CURRENT_DATETIME,
      qualifiers: [],
      historicalContext: null,
      note: 'No historical percentile data available.',
    };
    const blocks = waterGetConditions.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('No historical context');
    expect(text).toContain('No historical percentile data available');
  });
});

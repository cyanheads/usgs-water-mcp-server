/**
 * @fileoverview Tests for water_get_conditions tool — current value with historical percentile context.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-get-conditions.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetConditions } from '@/mcp-server/tools/definitions/water-get-conditions.tool.js';
import type { NwisStatResult, NwisTimeSeries } from '@/services/nwis/types.js';

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

/** Stat result with a row for June 4 (month=6, day=4). */
const MOCK_STAT: NwisStatResult = {
  siteNumber: '01646500',
  parameterCd: '00060',
  rows: [
    {
      monthNu: 6,
      dayNu: 4,
      beginYr: 1930,
      endYr: 2025,
      countNu: 95,
      p05: 2000,
      p10: 3000,
      p25: 4500,
      p50: 6000,
      p75: 9000,
      p95: 14000,
      maxVa: 22000,
      minVa: 800,
      meanVa: 7000,
    },
  ],
};

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
      code: JsonRpcErrorCode.InternalError,
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

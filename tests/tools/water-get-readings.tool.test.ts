/**
 * @fileoverview Tests for water_get_readings tool — IV real-time values.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-get-readings.tool.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetReadings } from '@/mcp-server/tools/definitions/water-get-readings.tool.js';
import type { NwisTimeSeries } from '@/services/nwis/types.js';
import { declaredRecovery } from '../helpers/error-contract.js';

const recovery = (reason: string) => declaredRecovery(waterGetReadings.errors, reason);

// Stub the network calls; keep the real classifyNwisFailure — it is pure, and it is the mapping
// under test here.
vi.mock('@/services/nwis/nwis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nwis/nwis-service.js')>()),
  getReadings: vi.fn(),
  getStats: vi.fn(),
  getSeries: vi.fn(),
  findSites: vi.fn(),
  getSiteInfo: vi.fn(),
}));

import { getReadings } from '@/services/nwis/nwis-service.js';

const mockGetReadings = vi.mocked(getReadings);

const MOCK_SERIES: NwisTimeSeries[] = [
  {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER AT LITTLE FALLS PUMP STA',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    values: [
      { dateTime: '2026-06-04T14:00:00-04:00', value: '7660', qualifiers: ['P'] },
      { dateTime: '2026-06-04T14:15:00-04:00', value: '7700', qualifiers: ['P'] },
    ],
  },
];

/** The documented per-series cap on returned value records. */
const VALUES_CAP = 10;

/** Build a mock IV series carrying `count` value records for one site+parameter. */
function makeSeries(count: number, siteNumber = '01646500'): NwisTimeSeries {
  return {
    siteNumber,
    siteName: 'POTOMAC RIVER AT LITTLE FALLS PUMP STA',
    parameterCd: '00060',
    parameterName: 'Streamflow, ft³/s',
    unitCode: 'ft3/s',
    values: Array.from({ length: count }, (_, i) => ({
      dateTime: `2026-06-04T${String(i % 24).padStart(2, '0')}:00:00-04:00`,
      value: String(7000 + i),
      qualifiers: ['P'],
    })),
  };
}

describe('waterGetReadings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns readings with site+parameter records', async () => {
    mockGetReadings.mockResolvedValue(MOCK_SERIES);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['00060'] });
    const result = await waterGetReadings.handler(input, ctx);
    expect(result.total).toBe(1);
    expect(result.readings[0]?.siteNumber).toBe('01646500');
    expect(result.readings[0]?.parameterCd).toBe('00060');
    expect(result.readings[0]?.values).toHaveLength(2);
    expect(result.readings[0]?.values[0]?.qualifiers).toContain('P');
  });

  it('throws no_data_for_parameter when service returns empty array (ambiguous: site not found or no data)', async () => {
    mockGetReadings.mockResolvedValue([]);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['99999999'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
    });
  });

  it('throws no_data_for_parameter when all series have empty values', async () => {
    mockGetReadings.mockResolvedValue([{ ...MOCK_SERIES[0]!, values: [] }]);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['99999'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
    });
  });

  it('maps an NWIS rejection to invalid_request without naming a field', async () => {
    // NWIS names the offending field itself; the wrapper text is identical whatever the field is,
    // so the reason must not claim it was the site number.
    mockGetReadings.mockRejectedValue(
      validationError('NWIS rejected the request: HTTP Status 400 - period: Invalid format: "P1"', {
        httpStatus: 400,
      }),
    );
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
      message: expect.stringContaining('period: Invalid format'),
    });
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockGetReadings.mockRejectedValue(
      serviceUnavailable('NWIS returned HTTP 503: Service Unavailable', { status: 503 }),
    );
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
    });
  });

  it('rethrows an unclassified error rather than guessing a reason', async () => {
    mockGetReadings.mockRejectedValue(new TypeError('fetch failed'));
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toThrow('fetch failed');
  });

  it('formats readings as markdown with values', () => {
    const result = {
      readings: MOCK_SERIES.map((s) => ({ ...s, totalValues: s.values.length })),
      total: 1,
      truncated: false,
      missingSites: [],
    };
    const blocks = waterGetReadings.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    expect(text).toContain('Streamflow');
    expect(text).toContain('00060');
    expect(text).toContain('ft3/s');
    expect(text).toContain('7700');
    expect(text).toContain('[P]');
  });

  it('supports multi-site batch input', async () => {
    mockGetReadings.mockResolvedValue([
      ...MOCK_SERIES,
      { ...MOCK_SERIES[0]!, siteNumber: '14211720' },
    ]);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500', '14211720'] });
    const result = await waterGetReadings.handler(input, ctx);
    expect(result.total).toBe(2);
  });

  it('populates query enrichment on successful result', async () => {
    mockGetReadings.mockResolvedValue(MOCK_SERIES);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({
      sites: ['01646500'],
      parameterCd: ['00060'],
      period: 'P1D',
    });
    await waterGetReadings.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({
      query: expect.objectContaining({
        sites: ['01646500'],
        parameterCd: ['00060'],
        period: 'P1D',
      }),
    });
  });

  describe('value cap', () => {
    it('caps values per series in structuredContent and reports the true count', async () => {
      // A P1D lookback at this site returns ~250 records upstream; the handler must not pass the
      // whole series through structuredContent just because format() only shows a preview.
      mockGetReadings.mockResolvedValue([makeSeries(277)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({
        sites: ['01646500'],
        parameterCd: ['00060'],
        period: 'P1D',
      });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.readings[0]?.values).toHaveLength(VALUES_CAP);
      expect(result.readings[0]?.totalValues).toBe(277);
      expect(result.truncated).toBe(true);
    });

    it('keeps the most recent records when capping', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(277)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500'], period: 'P1D' });
      const result = await waterGetReadings.handler(input, ctx);

      // makeSeries values ascend from 7000, so the newest record is 7000 + 276.
      expect(result.readings[0]?.values.at(-1)?.value).toBe('7276');
      expect(result.readings[0]?.values[0]?.value).toBe(String(7000 + 277 - VALUES_CAP));
    });

    it('leaves a series at or under the cap untouched', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(VALUES_CAP)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500'] });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.readings[0]?.values).toHaveLength(VALUES_CAP);
      expect(result.readings[0]?.totalValues).toBe(VALUES_CAP);
      expect(result.truncated).toBe(false);
    });

    it('reports the same record count in structuredContent and format()', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(277)]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500'], period: 'P1D' });
      const result = await waterGetReadings.handler(input, ctx);
      const text = waterGetReadings.format!(result)[0]?.text ?? '';

      expect(text).toContain(`showing the latest ${VALUES_CAP} of 277 records`);
      expect(text).toContain('truncated');
      expect(text).toContain('water_get_series');
    });
  });

  describe('partial batches', () => {
    it('names requested sites that returned no series', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(2, '01646500')]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({
        sites: ['01646500', '99999999'],
        parameterCd: ['00060'],
      });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(result.missingSites).toEqual(['99999999']);
    });

    it('renders missing sites in format() so content-only clients see the gap', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(2, '01646500')]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500', '99999999'] });
      const result = await waterGetReadings.handler(input, ctx);
      const text = waterGetReadings.format!(result)[0]?.text ?? '';

      expect(text).toContain('99999999');
      expect(text).toContain('No data returned for');
    });

    it('leaves missingSites empty when every requested site returns data', async () => {
      mockGetReadings.mockResolvedValue([makeSeries(2, '01646500'), makeSeries(2, '14211720')]);
      const ctx = createMockContext({ errors: waterGetReadings.errors });
      const input = waterGetReadings.input.parse({ sites: ['01646500', '14211720'] });
      const result = await waterGetReadings.handler(input, ctx);

      expect(result.missingSites).toEqual([]);
    });
  });

  describe('input validation', () => {
    it('rejects a malformed period at Zod parse level, before any NWIS call', () => {
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], period: 'not-a-duration' }),
      ).toThrow();
      expect(mockGetReadings).not.toHaveBeenCalled();
    });

    it('rejects a negative period (NWIS refuses these)', () => {
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], period: 'P-T2H' }),
      ).toThrow();
    });

    it('accepts ISO 8601 durations NWIS supports', () => {
      for (const period of ['PT2H', 'P1D', 'P7D', 'PT15M', 'P1Y2M3DT4H5M6S']) {
        expect(() => waterGetReadings.input.parse({ sites: ['01646500'], period })).not.toThrow();
      }
    });

    it('rejects a non-numeric site number at Zod parse level', () => {
      expect(() => waterGetReadings.input.parse({ sites: ['BADSITE'] })).toThrow();
    });

    it('rejects a site number outside 8–15 digits', () => {
      expect(() => waterGetReadings.input.parse({ sites: ['1646500'] })).toThrow();
      expect(() => waterGetReadings.input.parse({ sites: ['0164650012345678'] })).toThrow();
    });

    it('rejects a parameter code that is not exactly 5 digits', () => {
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['BAD'] }),
      ).toThrow();
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['0006'] }),
      ).toThrow();
      expect(() =>
        waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['000600'] }),
      ).toThrow();
    });
  });
});

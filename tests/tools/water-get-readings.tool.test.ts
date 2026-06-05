/**
 * @fileoverview Tests for water_get_readings tool — IV real-time values.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-get-readings.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterGetReadings } from '@/mcp-server/tools/definitions/water-get-readings.tool.js';
import type { NwisTimeSeries } from '@/services/nwis/types.js';

vi.mock('@/services/nwis/nwis-service.js', () => ({
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

  it('throws site_not_found when service returns empty array', async () => {
    mockGetReadings.mockResolvedValue([]);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['99999999'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'site_not_found' },
    });
  });

  it('throws no_data_for_parameter when all series have empty values', async () => {
    mockGetReadings.mockResolvedValue([{ ...MOCK_SERIES[0]!, values: [] }]);
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'], parameterCd: ['99999'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data_for_parameter' },
    });
  });

  it('maps HTML 400 error to invalid_site_format', async () => {
    mockGetReadings.mockRejectedValue(new Error('NWIS rejected the request: ValidationError'));
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['BADSITE'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_site_format' },
    });
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockGetReadings.mockRejectedValue(new Error('NWIS service unavailable'));
    const ctx = createMockContext({ errors: waterGetReadings.errors });
    const input = waterGetReadings.input.parse({ sites: ['01646500'] });
    await expect(waterGetReadings.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats readings as markdown with values', () => {
    const result = { readings: MOCK_SERIES, total: 1 };
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
});

/**
 * @fileoverview Tests for water_find_sites tool — NWIS site discovery.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-find-sites.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterFindSites } from '@/mcp-server/tools/definitions/water-find-sites.tool.js';
import type { NwisSite } from '@/services/nwis/types.js';

vi.mock('@/services/nwis/nwis-service.js', () => ({
  findSites: vi.fn(),
}));

import { findSites } from '@/services/nwis/nwis-service.js';

const mockFindSites = vi.mocked(findSites);

const MOCK_SITES: NwisSite[] = [
  {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER AT LITTLE FALLS PUMP STA NEAR WASHINGTON, DC',
    siteType: 'ST',
    latitude: 38.9495,
    longitude: -77.1273,
    stateCd: '24',
    countyCd: '031',
    hucCd: '02070008',
    drainageArea: 11560,
    altitude: 35.12,
    contributingArea: 11550,
  },
];

/** Build N minimal mock sites (basic mode — no expanded fields). */
function makeSites(count: number): NwisSite[] {
  return Array.from({ length: count }, (_, i) => ({
    siteNumber: String(10000000 + i).padStart(8, '0'),
    siteName: `MOCK SITE ${i}`,
    siteType: 'GW',
    latitude: 38.0 + i * 0.01,
    longitude: -98.0,
    hucCd: '10270206',
  }));
}

describe('waterFindSites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching sites with truncated=false when under cap', async () => {
    mockFindSites.mockResolvedValue(MOCK_SITES);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ bbox: '-77.5,38.5,-76.5,39.5' });
    const result = await waterFindSites.handler(input, ctx);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.upstreamTotal).toBe(1);
    expect(result.sites[0]?.siteNumber).toBe('01646500');
  });

  it('caps at 500 and returns truncated=true + upstreamTotal when over cap', async () => {
    mockFindSites.mockResolvedValue(makeSites(800));
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'KS', siteType: 'GW' });
    const result = await waterFindSites.handler(input, ctx);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
    expect(result.upstreamTotal).toBe(800);
    expect(result.sites).toHaveLength(500);
  });

  it('throws no_sites_found when service returns empty array', async () => {
    mockFindSites.mockResolvedValue([]);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'AK', siteType: 'OC' });
    await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_sites_found' },
    });
  });

  it('maps HTML 400 error to invalid_filter', async () => {
    mockFindSites.mockRejectedValue(
      new Error('NWIS rejected the request: ValidationError — bad bBox'),
    );
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ bbox: 'bad-value' });
    await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_filter' },
    });
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockFindSites.mockRejectedValue(new Error('NWIS service unavailable'));
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'VA' });
    await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats sites as structured markdown with site number, type, coords', () => {
    const result = { sites: MOCK_SITES, total: 1, truncated: false, upstreamTotal: 1 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    expect(text).toContain('POTOMAC');
    expect(text).toContain('ST');
    expect(text).toContain('38.9495');
    expect(text).toContain('02070008');
    // stateCd and countyCd are populated in this mock (expanded mode)
    expect(text).toContain('24');
    expect(text).toContain('031');
    // Expanded drainage/altitude fields
    expect(text).toContain('11560');
    expect(text).toContain('35.12');
  });

  it('formats sites without state/county when absent (basic mode)', () => {
    const basicSite: NwisSite = {
      ...MOCK_SITES[0]!,
      stateCd: undefined,
      countyCd: undefined,
      drainageArea: undefined,
      altitude: undefined,
    };
    const result = { sites: [basicSite], total: 1, truncated: false, upstreamTotal: 1 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    // Should not show empty state/county or drainage labels
    expect(text).not.toContain('State: undefined');
    expect(text).not.toContain('County: undefined');
    expect(text).not.toContain('Drainage area');
  });

  it('formats truncated result with cap notice', () => {
    const result = { sites: makeSites(500), total: 500, truncated: true, upstreamTotal: 800 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('800');
    expect(text).toContain('truncated');
  });

  it('populates filter enrichment on successful result', async () => {
    mockFindSites.mockResolvedValue(MOCK_SITES);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({
      stateCd: 'MD',
      siteType: 'ST',
      parameterCd: '00060',
    });
    await waterFindSites.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment).toMatchObject({
      filters: expect.objectContaining({
        stateCd: 'MD',
        siteType: 'ST',
        parameterCd: '00060',
        siteOutput: 'basic',
      }),
    });
  });

  it('passes through optional filters to findSites', async () => {
    mockFindSites.mockResolvedValue(MOCK_SITES);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({
      stateCd: 'MD',
      siteType: 'ST',
      parameterCd: '00060',
      hasDataTypeCd: 'iv',
    });
    await waterFindSites.handler(input, ctx);
    expect(mockFindSites).toHaveBeenCalledWith(
      expect.objectContaining({
        stateCd: 'MD',
        siteType: 'ST',
        parameterCd: '00060',
        hasDataTypeCd: 'iv',
      }),
      expect.anything(),
    );
  });
});

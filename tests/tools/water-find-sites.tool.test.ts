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
    dataTypes: ['iv', 'dv'],
    parameterCds: ['00060', '00065'],
  },
];

describe('waterFindSites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns matching sites', async () => {
    mockFindSites.mockResolvedValue(MOCK_SITES);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ bbox: '-77.5,38.5,-76.5,39.5' });
    const result = await waterFindSites.handler(input, ctx);
    expect(result.total).toBe(1);
    expect(result.sites[0]?.siteNumber).toBe('01646500');
    expect(result.sites[0]?.dataTypes).toContain('iv');
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
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'invalid_filter' },
    });
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockFindSites.mockRejectedValue(new Error('NWIS service unavailable'));
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'VA' });
    await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InternalError,
      data: { reason: 'upstream_error' },
    });
  });

  it('formats sites as structured markdown with site number, type, coords', () => {
    const result = { sites: MOCK_SITES, total: 1 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    expect(text).toContain('POTOMAC');
    expect(text).toContain('ST');
    expect(text).toContain('38.9495');
    expect(text).toContain('02070008');
    expect(text).toContain('iv');
    // stateCd and countyCd are populated in this mock (expanded mode)
    expect(text).toContain('24');
    expect(text).toContain('031');
  });

  it('formats sites without state/county when absent (basic mode)', () => {
    const basicSite = { ...MOCK_SITES[0]!, stateCd: undefined, countyCd: undefined };
    const result = { sites: [basicSite], total: 1 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('01646500');
    // Should not show empty state/county labels
    expect(text).not.toContain('State: undefined');
    expect(text).not.toContain('County: undefined');
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

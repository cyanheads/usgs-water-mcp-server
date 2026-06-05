/**
 * @fileoverview Tests for usgs-water://site/{siteId} resource.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/resources/water-site.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterSiteResource } from '@/mcp-server/resources/definitions/water-site.resource.js';
import type { NwisSite } from '@/services/nwis/types.js';

vi.mock('@/services/nwis/nwis-service.js', () => ({
  getSiteInfo: vi.fn(),
  findSites: vi.fn(),
  getReadings: vi.fn(),
  getSeries: vi.fn(),
  getStats: vi.fn(),
}));

import { getSiteInfo } from '@/services/nwis/nwis-service.js';

const mockGetSiteInfo = vi.mocked(getSiteInfo);

const MOCK_SITE: NwisSite = {
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
};

describe('waterSiteResource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns site metadata for a valid site number', async () => {
    mockGetSiteInfo.mockResolvedValue(MOCK_SITE);
    const ctx = createMockContext({ uri: new URL('usgs-water://site/01646500') });
    const result = await waterSiteResource.handler({ siteId: '01646500' }, ctx);
    expect((result as NwisSite).siteNumber).toBe('01646500');
    expect((result as NwisSite).siteName).toContain('POTOMAC');
    expect((result as NwisSite).latitude).toBe(38.9495);
  });

  it('throws NotFound when getSiteInfo returns null (unknown site)', async () => {
    mockGetSiteInfo.mockResolvedValue(null);
    const ctx = createMockContext({ uri: new URL('usgs-water://site/99999999') });
    await expect(waterSiteResource.handler({ siteId: '99999999' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('maps ServiceUnavailable upstream error correctly', async () => {
    mockGetSiteInfo.mockRejectedValue(new Error('NWIS service unavailable: HTTP 503'));
    const ctx = createMockContext({ uri: new URL('usgs-water://site/01646500') });
    await expect(waterSiteResource.handler({ siteId: '01646500' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('passes siteId through to getSiteInfo', async () => {
    mockGetSiteInfo.mockResolvedValue(MOCK_SITE);
    const ctx = createMockContext({ uri: new URL('usgs-water://site/01646500') });
    await waterSiteResource.handler({ siteId: '01646500' }, ctx);
    expect(mockGetSiteInfo).toHaveBeenCalledWith('01646500', expect.anything());
  });

  it('list() returns known example sites', () => {
    const listing = waterSiteResource.list!();
    expect(listing.resources.length).toBeGreaterThan(0);
    expect(listing.resources.some((r) => r.uri.includes('01646500'))).toBe(true);
    expect(listing.resources.every((r) => r.mimeType === 'application/json')).toBe(true);
  });
});

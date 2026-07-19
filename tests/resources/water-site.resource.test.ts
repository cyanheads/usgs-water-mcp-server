/**
 * @fileoverview Tests for usgs-water://site/{siteId} resource.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/resources/water-site.resource.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterSiteResource } from '@/mcp-server/resources/definitions/water-site.resource.js';
import type { NwisSite } from '@/services/nwis/types.js';
import { declaredRecovery } from '../helpers/error-contract.js';

const recovery = (reason: string) => declaredRecovery(waterSiteResource.errors, reason);

// Stub only the network call; keep the real classifyNwisFailure — it is pure, and it is the
// mapping the resource's catch block runs, exercised by the error tests below.
vi.mock('@/services/nwis/nwis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nwis/nwis-service.js')>()),
  getSiteInfo: vi.fn(),
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
  // 12 digits, as NWIS actually returns for this site — hucCd carries no fixed width.
  hucCd: '020700081005',
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

  it('throws not_found when getSiteInfo returns null (unknown site)', async () => {
    mockGetSiteInfo.mockResolvedValue(null);
    const ctx = createMockContext({
      uri: new URL('usgs-water://site/99999999'),
      errors: waterSiteResource.errors,
    });
    await expect(waterSiteResource.handler({ siteId: '99999999' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      // The pre-existing siteId payload survives alongside the recovery hint (regression: #24).
      data: { reason: 'not_found', siteId: '99999999', recovery: recovery('not_found') },
    });
  });

  it('maps an upstream 5xx to upstream_error', async () => {
    mockGetSiteInfo.mockRejectedValue(
      serviceUnavailable('NWIS returned HTTP 503: Service Unavailable', { status: 503 }),
    );
    const ctx = createMockContext({
      uri: new URL('usgs-water://site/01646500'),
      errors: waterSiteResource.errors,
    });
    await expect(waterSiteResource.handler({ siteId: '01646500' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
    });
  });

  it('maps an NWIS rejection of a well-formed site number to invalid_request', async () => {
    // '00000000' passes the 8–15 digit edge schema but NWIS still refuses it — the resource maps
    // that upstream ValidationError to the typed invalid_request reason.
    mockGetSiteInfo.mockRejectedValue(
      validationError('NWIS rejected the request: HTTP Status 400 - no sites found', {
        httpStatus: 400,
      }),
    );
    const ctx = createMockContext({
      uri: new URL('usgs-water://site/00000000'),
      errors: waterSiteResource.errors,
    });
    await expect(waterSiteResource.handler({ siteId: '00000000' }, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
    });
  });

  it('passes siteId through to getSiteInfo', async () => {
    mockGetSiteInfo.mockResolvedValue(MOCK_SITE);
    const ctx = createMockContext({ uri: new URL('usgs-water://site/01646500') });
    await waterSiteResource.handler({ siteId: '01646500' }, ctx);
    expect(mockGetSiteInfo).toHaveBeenCalledWith('01646500', expect.anything());
  });

  describe('siteId validation', () => {
    it('rejects a malformed siteId at the schema level, before any NWIS call', () => {
      expect(() => waterSiteResource.params!.parse({ siteId: 'abc' })).toThrow();
      expect(mockGetSiteInfo).not.toHaveBeenCalled();
    });

    it('rejects site numbers outside the 8–15 digit range', () => {
      // Too short, too long, and non-digit forms all fail at the edge, never reaching NWIS.
      for (const siteId of ['123', '0123456789012345', '01646500a', '']) {
        expect(() => waterSiteResource.params!.parse({ siteId })).toThrow();
      }
      expect(mockGetSiteInfo).not.toHaveBeenCalled();
    });

    it('accepts a well-formed 8–15 digit site number', () => {
      expect(() => waterSiteResource.params!.parse({ siteId: '01646500' })).not.toThrow();
      expect(() => waterSiteResource.params!.parse({ siteId: '020700081005' })).not.toThrow();
    });
  });

  it('list() returns known example sites', () => {
    const listing = waterSiteResource.list!();
    expect(listing.resources.length).toBeGreaterThan(0);
    expect(listing.resources.some((r) => r.uri.includes('01646500'))).toBe(true);
    expect(listing.resources.every((r) => r.mimeType === 'application/json')).toBe(true);
  });
});

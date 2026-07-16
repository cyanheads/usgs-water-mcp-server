/**
 * @fileoverview Tests for water_find_sites tool — NWIS site discovery.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-find-sites.tool.test
 */

import {
  JsonRpcErrorCode,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterFindSites } from '@/mcp-server/tools/definitions/water-find-sites.tool.js';
import type { NwisSite } from '@/services/nwis/types.js';

// Stub the network calls; keep the real classifyNwisFailure — it is pure, and it is the mapping
// under test here.
vi.mock('@/services/nwis/nwis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nwis/nwis-service.js')>()),
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
    // 12 digits, as NWIS actually returns for this site. Paired with the 8-digit hucCd in
    // makeSites() below, the fixtures carry both HUC levels site records come back at.
    hucCd: '020700081005',
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

  it('maps an NWIS rejection to invalid_request, surfacing the field NWIS named', async () => {
    // A two-letter state code that isn't a real state passes the edge schema and still reaches the
    // service; the reason must not pretend to know which filter was at fault when only NWIS's
    // message does. Rejection text is NWIS's own, verbatim.
    mockFindSites.mockRejectedValue(
      validationError(
        'NWIS rejected the request: HTTP Status 400 - stateCd not found, server=[caas01]',
        { httpStatus: 400 },
      ),
    );
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'ZZ' });
    await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
      message: expect.stringContaining('stateCd not found'),
    });
  });

  it('maps 5xx/timeout to upstream_error', async () => {
    mockFindSites.mockRejectedValue(
      serviceUnavailable('NWIS returned HTTP 503: Service Unavailable', { status: 503 }),
    );
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
    expect(text).toContain('020700081005');
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

  describe('input validation', () => {
    it('rejects a malformed bbox at Zod parse level, before any NWIS call', () => {
      expect(() => waterFindSites.input.parse({ bbox: 'bad-value' })).toThrow();
      expect(mockFindSites).not.toHaveBeenCalled();
    });

    it('rejects a bbox without exactly four decimal numbers', () => {
      expect(() => waterFindSites.input.parse({ bbox: '-77.5,38.5,-76.5' })).toThrow();
      expect(() => waterFindSites.input.parse({ bbox: '-77.5,38.5,-76.5,39.5,1' })).toThrow();
    });

    it('accepts a well-formed bbox', () => {
      expect(() => waterFindSites.input.parse({ bbox: '-77.5,38.5,-76.5,39.5' })).not.toThrow();
      expect(() => waterFindSites.input.parse({ bbox: '-180,-90,180,90' })).not.toThrow();
    });

    it('accepts only the 2- and 8-digit HUC lengths NWIS supports', () => {
      expect(() => waterFindSites.input.parse({ huc: '02' })).not.toThrow();
      expect(() => waterFindSites.input.parse({ huc: '02070008' })).not.toThrow();
      // NWIS returns 400 "invalid huc argument" for 4- and 6-digit HUCs, and
      // "length must be no greater than 8" for 10- and 12-digit HUCs.
      for (const huc of ['0207', '020700', '0207000810', '020700081005']) {
        expect(() => waterFindSites.input.parse({ huc })).toThrow();
      }
    });

    it('accepts a bare 5-digit FIPS countyCd and rejects the colon form', () => {
      expect(() => waterFindSites.input.parse({ countyCd: '51013' })).not.toThrow();
      expect(() => waterFindSites.input.parse({ countyCd: '51059,51061' })).not.toThrow();
      // NWIS: 400 "invalid fips5 county code string argument length".
      expect(() => waterFindSites.input.parse({ countyCd: '51:013' })).toThrow();
    });

    it('rejects a stateCd longer than 2 characters', () => {
      expect(() => waterFindSites.input.parse({ stateCd: 'WA' })).not.toThrow();
      expect(() => waterFindSites.input.parse({ stateCd: 'WAS' })).toThrow();
    });

    it('preserves comma-separated multi-value parameterCd', () => {
      // NWIS accepts a parameterCd list on the site service — a single-value pattern here would
      // regress the multi-code filtering this tool documents.
      expect(() => waterFindSites.input.parse({ parameterCd: '00060' })).not.toThrow();
      expect(() => waterFindSites.input.parse({ parameterCd: '00060,00065' })).not.toThrow();
      expect(() => waterFindSites.input.parse({ parameterCd: '0006' })).toThrow();
      expect(() => waterFindSites.input.parse({ parameterCd: '00060, 00065' })).toThrow();
    });
  });
});

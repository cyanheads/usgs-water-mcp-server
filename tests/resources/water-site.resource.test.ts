/**
 * @fileoverview Tests for usgs-water://site/{siteId} resource. The handler's own logic runs with
 * the site-discovery service's getSite mocked; its error paths run at the fetch seam, where the
 * Water Data fake serves the upstream answers and getSite, the client's retries, and the failure
 * classifier all execute. getSite's reads are pinned in tests/services/site-discovery.test.ts.
 * @module tests/resources/water-site.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterSiteResource } from '@/mcp-server/resources/definitions/water-site.resource.js';
import type { NwisSite } from '@/services/waterdata/types.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

const recovery = (reason: string) => declaredRecovery(waterSiteResource.errors, reason);

// Stub only the network call; the resource's classifier (water-data-errors) stays real — it is
// pure, and it is the mapping the resource's catch block runs, exercised by the error tests below.
vi.mock('@/services/waterdata/site-discovery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/waterdata/site-discovery.js')>()),
  getSite: vi.fn(),
}));

import { getSite } from '@/services/waterdata/site-discovery.js';

const mockGetSiteInfo = vi.mocked(getSite);

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
    const ctx = createMockContext({
      uri: new URL('usgs-water://site/01646500'),
      errors: waterSiteResource.errors,
    });
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

  it('passes siteId through to getSiteInfo', async () => {
    mockGetSiteInfo.mockResolvedValue(MOCK_SITE);
    const ctx = createMockContext({
      uri: new URL('usgs-water://site/01646500'),
      errors: waterSiteResource.errors,
    });
    await waterSiteResource.handler({ siteId: '01646500' }, ctx);
    expect(mockGetSiteInfo).toHaveBeenCalledWith(
      '01646500',
      expect.objectContaining({ operation: 'getSite', signal: ctx.signal }),
    );
  });

  it('points an unknown site at water_get_site_data_catalog, never at water_find_sites (#52)', () => {
    const hint = recovery('not_found').hint;
    expect(hint).toContain('water_get_site_data_catalog');
    expect(hint).not.toContain('water_find_sites');
    expect(recovery('invalid_request').hint).not.toContain('water_find_sites');
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

  it('list() returns known example sites', async () => {
    const listing = await waterSiteResource.list!(null as never);
    expect(listing.resources.length).toBeGreaterThan(0);
    expect(listing.resources.some((r) => r.uri.includes('01646500'))).toBe(true);
    expect(listing.resources.every((r) => r.mimeType === 'application/json')).toBe(true);
  });
});

describe('waterSiteResource errors at the fetch seam', () => {
  const RESOLVER_PROPERTIES =
    'monitoring_location_number,monitoring_location_name,agency_code,time_zone_abbreviation,uses_daylight_savings';
  const EXPANDED_PROPERTIES =
    'monitoring_location_number,monitoring_location_name,site_type_code,altitude,hydrologic_unit_code,state_code,county_code,drainage_area,contributing_drainage_area';

  let resource: typeof waterSiteResource;
  let water: WaterDataFake;

  // A fresh module graph per test: the real getSite in place of the mock above, and an empty
  // resolver cache and host cooldown gate.
  beforeEach(async () => {
    vi.doUnmock('@/services/waterdata/site-discovery.js');
    vi.resetModules();
    vi.stubEnv('USGS_API_KEY', undefined);
    ({ waterSiteResource: resource } = await import(
      '@/mcp-server/resources/definitions/water-site.resource.js'
    ));
    water = createWaterDataFake();
    water.install();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    water.restore();
  });

  const resolverRoute = () =>
    ogcRoute(
      'monitoring-locations',
      () => jsonResponse(waterDataFixture('monitoring-locations-by-number.json')),
      { query: { properties: RESOLVER_PROPERTIES } },
    );
  const detailRoute = (respond: () => Response) =>
    ogcRoute('monitoring-locations', respond, {
      query: { monitoring_location_number: '01646500', properties: EXPANDED_PROPERTIES },
    });
  const unavailable = () => new Response('Unavailable', { status: 503 });

  /** The error a read of `siteId` raises; throws when the read succeeds. */
  async function failedRead(siteId: string): Promise<McpError> {
    const ctx = createMockContext({
      uri: new URL(`usgs-water://site/${siteId}`),
      errors: resource.errors,
    });
    try {
      await resource.handler({ siteId }, ctx);
    } catch (error) {
      if (error instanceof McpError) return error;
      throw error;
    }
    throw new Error('Expected the read to fail.');
  }

  it('answers not_found, pointing at water_get_site_data_catalog, when no location has the number', async () => {
    water.route(
      ogcRoute('monitoring-locations', () => jsonResponse(ogcPage([])), {
        query: { properties: RESOLVER_PROPERTIES },
      }),
    );
    const error = await failedRead('99999999');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'Site 99999999 not found.',
      data: {
        reason: 'not_found',
        siteId: '99999999',
        recovery: declaredRecovery(resource.errors, 'not_found'),
      },
    });
    expect(error.data?.['recovery']).toMatchObject({
      hint: expect.stringContaining('water_get_site_data_catalog'),
    });
    // The resolver's miss ends the read: no detail request follows it.
    expect(water.requests).toHaveLength(1);
    expect(water.requests[0]?.url.searchParams.get('monitoring_location_number')).toBe('99999999');
  });

  it('answers not_found when the detail read no longer holds the location the resolver picked', async () => {
    const detail = JSON.parse(waterDataFixture('site-detail-01646500.json')) as {
      features: { id: string }[];
    };
    water.route(
      resolverRoute(),
      detailRoute(() =>
        jsonResponse({
          ...detail,
          features: detail.features.map((f) => ({ ...f, id: 'MD001-01646500' })),
        }),
      ),
    );
    const error = await failedRead('01646500');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: {
        reason: 'not_found',
        recovery: { hint: expect.stringContaining('water_get_site_data_catalog') },
      },
    });
    expect(water.requests).toHaveLength(2);
  });

  it.each([
    ['the resolver', () => [ogcRoute('monitoring-locations', unavailable)], 4],
    ['the detail read', () => [resolverRoute(), detailRoute(unavailable)], 5],
  ])(
    'answers upstream_error once a 503 on %s outlasts the retries',
    async (_read, routes, sent) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(...routes());
      const pending = failedRead('01646500');
      await vi.advanceTimersByTimeAsync(10_000);
      const error = await pending;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'USGS Water Data OGC API answered HTTP 503: Unavailable (failed after 4 attempts)',
        data: {
          reason: 'upstream_error',
          recovery: declaredRecovery(resource.errors, 'upstream_error'),
        },
      });
      expect(water.requests).toHaveLength(sent);
    },
  );

  it('answers upstream_error for an unreadable body without re-sending it', async () => {
    water.route(
      resolverRoute(),
      detailRoute(() => jsonResponse({ features: 'truncated' })),
    );
    const error = await failedRead('01646500');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'upstream_error',
        recovery: declaredRecovery(resource.errors, 'upstream_error'),
      },
    });
    expect(water.requests).toHaveLength(2);
  });

  it('answers invalid_request with the API’s own description, pointing at water_get_site_data_catalog', async () => {
    // The captured 400 body of the OGC collections; its description is the upstream's own text.
    water.route(
      resolverRoute(),
      detailRoute(() =>
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
    );
    const error = await failedRead('01646500');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message:
        'USGS Water Data OGC API rejected the request: bbox should be either 4 values (minx,miny,maxx,maxy) or 6 values (minx,miny,minz,maxx,maxy,maxz)',
      data: {
        reason: 'invalid_request',
        recovery: { hint: expect.stringContaining('water_get_site_data_catalog') },
      },
    });
    // A 400 is not retried.
    expect(water.requests).toHaveLength(2);
  });
});

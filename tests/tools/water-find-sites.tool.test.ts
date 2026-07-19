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
import { declaredRecovery } from '../helpers/error-contract.js';

const recovery = (reason: string) => declaredRecovery(waterFindSites.errors, reason);

// Stub the network calls; keep the real classifyNwisFailure — it is pure, and it is the mapping
// under test here.
vi.mock('@/services/nwis/nwis-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/nwis/nwis-service.js')>()),
  findSites: vi.fn(),
}));

// Canvas mock — undefined (disabled) by default; overridden per test to exercise the staging path.
let mockCanvasInstance: unknown;
vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: () => mockCanvasInstance,
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

/**
 * Build N minimal mock sites (basic mode — no expanded fields). Pass includeHuc=false to model
 * sites NWIS assigned no HUC to (hucCd omitted, as mapSiteRow now does for a blank huc_cd).
 */
function makeSites(count: number, includeHuc = true): NwisSite[] {
  return Array.from({ length: count }, (_, i) => ({
    siteNumber: String(10000000 + i).padStart(8, '0'),
    siteName: `MOCK SITE ${i}`,
    siteType: 'GW',
    latitude: 38.0 + i * 0.01,
    longitude: -98.0,
    ...(includeHuc ? { hucCd: '10270206' } : {}),
  }));
}

describe('waterFindSites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCanvasInstance = undefined;
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

  it('stages the full match set to canvas and returns canvas_id/table_name when truncated + canvas enabled', async () => {
    mockFindSites.mockResolvedValue(makeSites(800));
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'water_sites_KS_GW',
      rowCount: 800,
      columns: [
        'site_number',
        'site_name',
        'site_type',
        'latitude',
        'longitude',
        'huc_cd',
        'state_cd',
        'county_cd',
        'drainage_area',
        'altitude',
        'contributing_area',
      ],
    });
    const mockInstance = { canvasId: 'canvas_sites01', registerTable };
    mockCanvasInstance = { acquire: vi.fn().mockResolvedValue(mockInstance) };

    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'KS', siteType: 'GW' });
    const result = await waterFindSites.handler(input, ctx);

    // Inline stays count-capped; the canvas carries the full, uncapped set.
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
    expect(result.upstreamTotal).toBe(800);
    expect(result.sites).toHaveLength(500);
    expect(result.canvas_id).toBe('canvas_sites01');
    expect(result.table_name).toBe('water_sites_KS_GW');

    // registerTable received the FULL 800-site set (not the capped 500), as snake_case canvas rows.
    // The table name is derived from the filters, preserving their case (KS/GW).
    expect(registerTable).toHaveBeenCalledTimes(1);
    const [tableArg, rowsArg] = registerTable.mock.calls[0]!;
    expect(tableArg).toBe('water_sites_KS_GW');
    expect(rowsArg).toHaveLength(800);
    expect(rowsArg[0]).toMatchObject({
      site_number: expect.any(String),
      site_name: expect.any(String),
      site_type: 'GW',
      huc_cd: expect.any(String),
    });
  });

  it('stages huc_cd as null for sites NWIS assigned no HUC (regression: #22)', async () => {
    // Every staged site lacks hucCd. The canvas row must carry huc_cd: null, not undefined — the
    // first row seeds DuckDB column types, so a bare undefined would leave the column untyped.
    mockFindSites.mockResolvedValue(makeSites(600, false));
    const registerTable = vi
      .fn()
      .mockResolvedValue({ tableName: 'water_sites_KS_GW', rowCount: 600, columns: [] });
    mockCanvasInstance = {
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas_nohuc', registerTable }),
    };

    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'KS', siteType: 'GW' });
    await waterFindSites.handler(input, ctx);

    const [, rowsArg] = registerTable.mock.calls[0]!;
    expect(rowsArg[0].huc_cd).toBeNull();
  });

  it('does NOT stage to canvas when the result is under the cap even if canvas is enabled', async () => {
    mockFindSites.mockResolvedValue(makeSites(100));
    const registerTable = vi.fn();
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas_sites02', registerTable });
    mockCanvasInstance = { acquire };

    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'RI', siteType: 'GW' });
    const result = await waterFindSites.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.total).toBe(100);
    expect(acquire).not.toHaveBeenCalled();
    expect(registerTable).not.toHaveBeenCalled();
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
  });

  it('falls back to the count cap with no canvas fields when the provider is disabled', async () => {
    // mockCanvasInstance stays undefined (default) — getCanvas() returns undefined.
    mockFindSites.mockResolvedValue(makeSites(800));
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'VA', siteType: 'GW' });
    const result = await waterFindSites.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
    expect(result.upstreamTotal).toBe(800);
    expect(result.canvas_id).toBeUndefined();
    expect(result.table_name).toBeUndefined();
  });

  it('throws no_sites_found when service returns empty array', async () => {
    mockFindSites.mockResolvedValue([]);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'AK', siteType: 'OC' });
    await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_sites_found', recovery: recovery('no_sites_found') },
    });
  });

  it('delivers the declared recovery hint on the wire, not just in the contract (regression: #24)', async () => {
    // The issue's repro: a bbox over open ocean matching nothing. The authored recovery has to
    // reach error.data so both structuredContent and the mirrored content[] text carry it.
    mockFindSites.mockResolvedValue([]);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ bbox: '-160.0,5.0,-159.9,5.1' });
    const error = (await waterFindSites.handler(input, ctx).catch((e: unknown) => e)) as {
      data?: { recovery?: { hint?: string } };
    };
    expect(error.data?.recovery?.hint).toBe(
      'Broaden the bounding box, remove parameterCd or siteType filters, or try a different state/HUC.',
    );
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
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
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
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
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

  it('renders altitude in basic mode when drainageArea is absent (regression: #16 sub-case 3)', () => {
    // altitude populates in BOTH basic and expanded mode; drainageArea only in expanded. The old
    // formatter gated altitude behind `drainageArea !== undefined`, so a basic-mode site with an
    // altitude silently dropped it from content[] while structuredContent kept it. format-parity
    // can't catch this — it always synthesizes both siblings populated together, never the real
    // "drainageArea absent, altitude present" combination basic mode produces.
    const basicSiteWithAltitude: NwisSite = {
      siteNumber: '363319076253301',
      siteName: 'GROUNDWATER WELL NEAR SUFFOLK, VA',
      siteType: 'GW',
      latitude: 36.55,
      longitude: -76.42,
      hucCd: '03010205',
      altitude: 22,
      // drainageArea, contributingArea, stateCd, countyCd all absent — basic mode.
    };
    const result = { sites: [basicSiteWithAltitude], total: 1, truncated: false, upstreamTotal: 1 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';

    expect(text).toContain('**Altitude:** 22 ft');
    // The decoupled fields that are absent must not render their labels.
    expect(text).not.toContain('Drainage area');
    expect(text).not.toContain('Contributing area');
  });

  it('omits the HUC line entirely when NWIS assigned no HUC (regression: #22)', () => {
    // A groundwater site NWIS gave no HUC: mapSiteRow now omits hucCd (like every sparse sibling)
    // instead of backfilling '', so format() must skip the label rather than print a bare "HUC:".
    const noHucSite: NwisSite = {
      siteNumber: '363835076202001',
      siteName: '60B 27',
      siteType: 'GW',
      latitude: 36.643206,
      longitude: -76.3385525,
      altitude: 16,
      // hucCd, stateCd, countyCd, drainageArea, contributingArea all absent — basic-mode GW site.
    };
    const result = { sites: [noHucSite], total: 1, truncated: false, upstreamTotal: 1 };
    const text = waterFindSites.format!(result)[0]?.text ?? '';

    expect(text).toContain('60B 27');
    expect(text).toContain('**Altitude:** 16 ft');
    // No bare label and no stringified undefined for the omitted HUC.
    expect(text).not.toContain('**HUC:**');
    expect(text).not.toContain('undefined');
  });

  it('renders State/County even when HUC is absent (decoupled location parts)', () => {
    // HUC and state/county are independent — an absent HUC must not suppress the state/county that
    // expanded mode does carry.
    const site: NwisSite = {
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER',
      siteType: 'ST',
      latitude: 38.9495,
      longitude: -77.1273,
      stateCd: '24',
      countyCd: '031',
      // hucCd absent.
    };
    const result = { sites: [site], total: 1, truncated: false, upstreamTotal: 1 };
    const text = waterFindSites.format!(result)[0]?.text ?? '';

    expect(text).toContain('**State:** 24');
    expect(text).toContain('**County:** 031');
    expect(text).not.toContain('**HUC:**');
  });

  it('formats truncated result with cap notice', () => {
    const result = { sites: makeSites(500), total: 500, truncated: true, upstreamTotal: 800 };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('800');
    expect(text).toContain('truncated');
  });

  it('formats a truncated canvas result with the canvas_id / table_name reference', () => {
    const result = {
      sites: makeSites(500),
      total: 500,
      truncated: true,
      upstreamTotal: 800,
      canvas_id: 'canvas_sites01',
      table_name: 'water_sites_KS_GW',
    };
    const blocks = waterFindSites.format!(result);
    const text = blocks[0]?.text ?? '';
    expect(text).toContain('canvas_sites01');
    expect(text).toContain('water_sites_KS_GW');
    expect(text).toContain('water_dataframe_query');
    expect(text).toContain('800');
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

  it('echoes countyCd in both filter enrichment and the rendered trailer', async () => {
    mockFindSites.mockResolvedValue(MOCK_SITES);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({
      stateCd: 'VA',
      countyCd: '51013',
      siteType: 'ST',
    });
    await waterFindSites.handler(input, ctx);

    // structuredContent path: the enrichment object carries countyCd
    expect(getEnrichment(ctx)).toMatchObject({
      filters: expect.objectContaining({ countyCd: '51013' }),
    });

    // content[] path: the trailer renderer surfaces countyCd
    const rendered = waterFindSites.enrichmentTrailer!.filters!.render!({
      stateCd: 'VA',
      countyCd: '51013',
      siteType: 'ST',
      siteOutput: 'basic',
    });
    expect(rendered).toContain('countyCd=51013');
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

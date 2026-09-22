/**
 * @fileoverview Tests for water_find_sites tool — NWIS site discovery.
 * Mocks the nwis-service module to avoid live API calls.
 * @module tests/tools/water-find-sites.tool.test
 */

import { CANVAS_IDENTIFIER_REGEX } from '@cyanheads/mcp-ts-core/canvas';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waterFindSites } from '@/mcp-server/tools/definitions/water-find-sites.tool.js';
import type { NwisSite } from '@/services/nwis/types.js';
import { textContent } from '../helpers/content-block.js';
import { captureError, declaredRecovery } from '../helpers/error-contract.js';

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

/**
 * Install a canvas mock whose registerTable echoes back the name the handler derived, so
 * `result.table_name` reflects the derivation under test rather than a literal fixed by the mock.
 */
function stageCanvas(canvasId = 'cnvsites01') {
  const registerTable = vi.fn((name: string, rows: Record<string, unknown>[]) =>
    Promise.resolve({ tableName: name, rowCount: rows.length, columns: [] }),
  );
  const acquire = vi.fn().mockResolvedValue({ canvasId, registerTable });
  mockCanvasInstance = { acquire };
  return { acquire, registerTable };
}

/** The derived table name the handler passed to registerTable on its first (only) staging call. */
function stagedTableName(registerTable: ReturnType<typeof stageCanvas>['registerTable']): string {
  return registerTable.mock.calls[0]![0];
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
    const { registerTable } = stageCanvas();

    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'KS', siteType: 'GW' });
    const result = await waterFindSites.handler(input, ctx);

    // Inline stays count-capped; the canvas carries the full, uncapped set.
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(500);
    expect(result.upstreamTotal).toBe(800);
    expect(result.sites).toHaveLength(500);
    expect(result.canvas_id).toBe('cnvsites01');
    expect(result.table_name).toBe(stagedTableName(registerTable));

    // registerTable received the FULL 800-site set (not the capped 500), as snake_case canvas rows.
    // The table name is derived from the filters, preserving their case (KS/GW).
    expect(registerTable).toHaveBeenCalledTimes(1);
    const [tableArg, rowsArg] = registerTable.mock.calls[0]!;
    expect(tableArg).toMatch(/^water_sites_KS_GW_[0-9a-f]{8}$/);
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
    const { registerTable } = stageCanvas('canvasnohu');

    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ stateCd: 'KS', siteType: 'GW' });
    await waterFindSites.handler(input, ctx);

    const [, rowsArg] = registerTable.mock.calls[0]!;
    expect(rowsArg[0]!.huc_cd).toBeNull();
  });

  it('does NOT stage to canvas when the result is under the cap even if canvas is enabled', async () => {
    mockFindSites.mockResolvedValue(makeSites(100));
    const { acquire, registerTable } = stageCanvas('canvassit02');

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
    const error = (await captureError(() => waterFindSites.handler(input, ctx))) as {
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
    const text = textContent(blocks[0]);
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
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER AT LITTLE FALLS PUMP STA NEAR WASHINGTON, DC',
      siteType: 'ST',
      latitude: 38.9495,
      longitude: -77.1273,
      hucCd: '020700081005',
    };
    const result = { sites: [basicSite], total: 1, truncated: false, upstreamTotal: 1 };
    const blocks = waterFindSites.format!(result);
    const text = textContent(blocks[0]);
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
    const text = textContent(blocks[0]);

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
    const text = textContent(waterFindSites.format!(result)[0]);

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
    const text = textContent(waterFindSites.format!(result)[0]);

    expect(text).toContain('**State:** 24');
    expect(text).toContain('**County:** 031');
    expect(text).not.toContain('**HUC:**');
  });

  it('formats truncated result with cap notice', () => {
    const result = { sites: makeSites(500), total: 500, truncated: true, upstreamTotal: 800 };
    const blocks = waterFindSites.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('800');
    expect(text).toContain('truncated');
  });

  it('formats a truncated canvas result with the canvas_id / table_name reference', () => {
    const result = {
      sites: makeSites(500),
      total: 500,
      truncated: true,
      upstreamTotal: 800,
      canvas_id: 'cnvsites01',
      table_name: 'water_sites_KS_GW_0a1b2c3d',
    };
    const blocks = waterFindSites.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('cnvsites01');
    expect(text).toContain('water_sites_KS_GW_0a1b2c3d');
    expect(text).toContain('water_dataframe_query');
    expect(text).toContain('800');
  });

  it('names water_dataframe_describe before water_dataframe_query in the canvas caption (#34)', () => {
    // content[0] is the block a text-only client renders first; an agent that reads only this one
    // has to learn the describe-then-query order from it, not from the schema.
    const text = textContent(
      waterFindSites.format!({
        sites: makeSites(500),
        total: 500,
        truncated: true,
        upstreamTotal: 800,
        canvas_id: 'cnvsites01',
        table_name: 'water_sites_KS_GW_0a1b2c3d',
      })[0],
    );

    expect(text).toContain('water_dataframe_describe');
    expect(text.indexOf('water_dataframe_describe')).toBeLessThan(
      text.indexOf('water_dataframe_query'),
    );
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
    // countyCd stands alone — its 5 FIPS digits already encode the state, and NWIS rejects it
    // paired with stateCd (#36).
    mockFindSites.mockResolvedValue(MOCK_SITES);
    const ctx = createMockContext({ errors: waterFindSites.errors });
    const input = waterFindSites.input.parse({ countyCd: '51013', siteType: 'ST' });
    await waterFindSites.handler(input, ctx);

    // structuredContent path: the enrichment object carries countyCd
    expect(getEnrichment(ctx)).toMatchObject({
      filters: expect.objectContaining({ countyCd: '51013' }),
    });

    // content[] path: the trailer renderer surfaces countyCd
    const rendered = waterFindSites.enrichmentTrailer!.filters!.render!({
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

  describe('major-filter rule (#36)', () => {
    const NARROWING = { siteType: 'ST', parameterCd: '00060', hasDataTypeCd: 'iv' };

    it('fails with missing_major_filter before any NWIS call when none is present', async () => {
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse(NARROWING);
      await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'missing_major_filter',
          recovery: recovery('missing_major_filter'),
        },
      });
      // The whole point of the guard: NWIS answers this with "no major-filter pairs supplied by
      // user", which names no field, so the round trip buys nothing.
      expect(mockFindSites).not.toHaveBeenCalled();
    });

    it('fails with conflicting_major_filters naming the fields that were sent', async () => {
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({
        stateCd: 'PA',
        countyCd: '42043',
        siteType: 'ST',
      });
      const error = (await captureError(() => waterFindSites.handler(input, ctx))) as McpError;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'conflicting_major_filters',
          recovery: recovery('conflicting_major_filters'),
        },
      });
      expect(error.message).toContain('stateCd');
      expect(error.message).toContain('countyCd');
      expect(mockFindSites).not.toHaveBeenCalled();
    });

    it('reports all three when three major filters are sent', async () => {
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({
        stateCd: 'PA',
        huc: '02050106',
        bbox: '-77.5,38.5,-76.5,39.5',
      });
      const error = (await captureError(() => waterFindSites.handler(input, ctx))) as McpError;
      for (const field of ['bbox', 'stateCd', 'huc']) expect(error.message).toContain(field);
    });

    it.each(['bbox', 'stateCd', 'countyCd', 'huc'] as const)(
      'passes the guard with %s as the only major filter, narrowing filters present',
      async (field) => {
        const value = {
          bbox: '-77.5,38.5,-76.5,39.5',
          stateCd: 'VA',
          countyCd: '51013',
          huc: '02070008',
        }[field];
        mockFindSites.mockResolvedValue(MOCK_SITES);
        const ctx = createMockContext({ errors: waterFindSites.errors });
        const input = waterFindSites.input.parse({ [field]: value, ...NARROWING });

        await expect(waterFindSites.handler(input, ctx)).resolves.toMatchObject({ total: 1 });
        expect(mockFindSites).toHaveBeenCalledTimes(1);
      },
    );

    it('passes the guard with one major filter and no narrowing filters at all', async () => {
      mockFindSites.mockResolvedValue(MOCK_SITES);
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'VA' });
      await expect(waterFindSites.handler(input, ctx)).resolves.toMatchObject({ total: 1 });
    });

    it('stops recommending the stateCd + countyCd pairing NWIS rejects', () => {
      const countyCd = waterFindSites.input.shape.countyCd.description ?? '';
      expect(countyCd).not.toContain('Use with stateCd');
      expect(countyCd.length).toBeGreaterThan(0);
    });

    it('states the exclusivity rule across the whole major-filter set, not bbox alone', () => {
      const bbox = waterFindSites.input.shape.bbox.description ?? '';
      for (const field of ['stateCd', 'countyCd', 'huc']) expect(bbox).toContain(field);
    });

    it('states in the tool description that exactly one major filter is required', () => {
      expect(waterFindSites.description).toMatch(/exactly one/i);
      for (const field of ['bbox', 'stateCd', 'countyCd', 'huc']) {
        expect(waterFindSites.description).toContain(field);
      }
    });

    it('no longer promises the NWIS message names the field it rejected', () => {
      const entry = waterFindSites.errors!.find((e) => e.reason === 'invalid_request')!;
      expect(`${entry.when} ${entry.recovery}`).not.toMatch(/names the field/i);
    });
  });

  describe('limit / offset paging (#29)', () => {
    it('slices the in-memory result set', async () => {
      mockFindSites.mockResolvedValue(makeSites(100));
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', limit: 5, offset: 2 });
      const result = await waterFindSites.handler(input, ctx);

      expect(result.total).toBe(5);
      expect(result.sites).toHaveLength(5);
      expect(result.upstreamTotal).toBe(100);
      expect(result.sites[0]?.siteNumber).toBe('10000002');
      expect(result.sites[4]?.siteNumber).toBe('10000006');
      expect(result.truncated).toBe(true);
    });

    it('defaults to the first 500 — byte-for-byte the pre-paging behavior', async () => {
      mockFindSites.mockResolvedValue(makeSites(800));
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'KS' });

      expect(input.limit).toBe(500);
      expect(input.offset).toBe(0);
      const result = await waterFindSites.handler(input, ctx);
      expect(result.total).toBe(500);
      expect(result.truncated).toBe(true);
      expect(result.sites[0]?.siteNumber).toBe('10000000');
    });

    it('sets truncated from the window, not the cap alone', async () => {
      mockFindSites.mockResolvedValue(makeSites(100));
      const ctx = createMockContext({ errors: waterFindSites.errors });

      // A window that reaches the end of a sub-cap match set is NOT truncated...
      const full = await waterFindSites.handler(
        waterFindSites.input.parse({ stateCd: 'RI', limit: 100 }),
        ctx,
      );
      expect(full.truncated).toBe(false);

      // ...and the last page of a paged walk closes it out the same way.
      const lastPage = await waterFindSites.handler(
        waterFindSites.input.parse({ stateCd: 'RI', limit: 40, offset: 60 }),
        ctx,
      );
      expect(lastPage.total).toBe(40);
      expect(lastPage.truncated).toBe(false);
    });

    it('returns a short final page when limit overruns the end of the match set', async () => {
      mockFindSites.mockResolvedValue(makeSites(100));
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', limit: 50, offset: 80 });
      const result = await waterFindSites.handler(input, ctx);

      expect(result.total).toBe(20);
      expect(result.truncated).toBe(false);
    });

    it('returns an empty page with a range notice when offset is at or past the total', async () => {
      mockFindSites.mockResolvedValue(makeSites(100));
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', offset: 100 });
      const result = await waterFindSites.handler(input, ctx);

      // Never no_sites_found: the filters matched 100 sites, the caller just asked past the end.
      expect(result.sites).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.upstreamTotal).toBe(100);

      const { notice } = getEnrichment(ctx) as { notice: string };
      expect(notice).toContain('100');
      expect(notice).toContain('0');
    });

    it('still throws no_sites_found when the filters match nothing upstream', async () => {
      // The empty-page case above must stay distinguishable from a genuinely empty match set.
      mockFindSites.mockResolvedValue([]);
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', offset: 100 });
      await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'no_sites_found' },
      });
    });

    it('keeps canvas staging keyed to upstreamTotal alone, independent of limit', async () => {
      mockFindSites.mockResolvedValue(makeSites(800));
      const { registerTable } = stageCanvas();
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'KS', limit: 10 });
      const result = await waterFindSites.handler(input, ctx);

      expect(result.total).toBe(10);
      expect(result.canvas_id).toBe('cnvsites01');
      // The FULL set still stages — the SQL path stays available to a small-limit caller.
      expect(registerTable.mock.calls[0]![1]).toHaveLength(800);
    });

    it('does not stage a sub-cap match set however small the limit', async () => {
      mockFindSites.mockResolvedValue(makeSites(100));
      const { acquire, registerTable } = stageCanvas();
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', limit: 1 });
      const result = await waterFindSites.handler(input, ctx);

      expect(result.total).toBe(1);
      expect(acquire).not.toHaveBeenCalled();
      expect(registerTable).not.toHaveBeenCalled();
    });

    it('rejects limit and offset outside their bounds at parse level', () => {
      expect(() => waterFindSites.input.parse({ stateCd: 'RI', limit: 0 })).toThrow();
      expect(() => waterFindSites.input.parse({ stateCd: 'RI', limit: 501 })).toThrow();
      expect(() => waterFindSites.input.parse({ stateCd: 'RI', limit: 1.5 })).toThrow();
      expect(() => waterFindSites.input.parse({ stateCd: 'RI', offset: -1 })).toThrow();
      expect(() =>
        waterFindSites.input.parse({ stateCd: 'RI', limit: 500, offset: 0 }),
      ).not.toThrow();
    });

    it('carries the window in the format() header on both bounds', () => {
      const text = textContent(
        waterFindSites.format!({
          sites: makeSites(5),
          total: 5,
          truncated: true,
          upstreamTotal: 100,
        })[0],
      );
      expect(text).toContain('5');
      expect(text).toContain('100');
    });
  });

  describe('truncation notice (#35)', () => {
    it('names the caller’s own limit as the bound when it, not the cap, cut the page', async () => {
      // "Result capped at 500 of 4220" would misreport why 5 sites came back.
      mockFindSites.mockResolvedValue(makeSites(4220));
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', limit: 5, offset: 2 });
      await waterFindSites.handler(input, ctx);

      const { notice } = getEnrichment(ctx) as { notice: string };
      expect(notice).not.toContain('capped at 500');
      expect(notice).toContain('Showing sites 3 to 7 of 4220');
      // Still past the cap, so narrowing is still worth naming.
      expect(notice).toContain('narrow the query');
      expect(notice).not.toContain('CANVAS_PROVIDER_TYPE');
    });

    it('names the window rather than the cap once the caller has paged past the first page', async () => {
      // Default limit, non-zero offset: "Result capped at 500 of 4220" is true of the first page
      // and says nothing about which 500 of 4220 this one holds.
      mockFindSites.mockResolvedValue(makeSites(4220));
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', offset: 600 });
      await waterFindSites.handler(input, ctx);

      const { notice } = getEnrichment(ctx) as { notice: string };
      expect(notice).not.toContain('capped at 500');
      expect(notice).toContain('Showing sites 601 to 1100 of 4220');
      expect(notice).toContain('narrow the query');
    });

    it('omits CANVAS_PROVIDER_TYPE from the no-canvas notice on both surfaces', async () => {
      mockFindSites.mockResolvedValue(makeSites(3231));
      const result = await runToolContract(waterFindSites, { stateCd: 'TX', siteType: 'ST' });

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toBe(
        'Result capped at 500 of 3231 matching sites. Add bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd filters to narrow the query.',
      );

      // content[] carries the same enrichment through the default scalar trailer.
      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).not.toContain('CANVAS_PROVIDER_TYPE');
      expect(rendered).toContain('narrow the query');
    });
  });

  describe('canvas table naming (#28)', () => {
    async function stagedNameFor(input: Record<string, unknown>, sites = makeSites(800)) {
      mockFindSites.mockResolvedValue(sites);
      const { registerTable } = stageCanvas();
      const ctx = createMockContext({ errors: waterFindSites.errors });
      await waterFindSites.handler(waterFindSites.input.parse(input), ctx);
      return stagedTableName(registerTable);
    }

    it('carries scope, siteType, and a filter digest', async () => {
      expect(await stagedNameFor({ stateCd: 'KS', siteType: 'GW' })).toMatch(
        /^water_sites_KS_GW_[0-9a-f]{8}$/,
      );
    });

    it('collapses the scope to a literal for county, huc, and bbox', async () => {
      expect(await stagedNameFor({ countyCd: '51013' })).toMatch(/^water_sites_county_all_/);
      expect(await stagedNameFor({ huc: '02070008' })).toMatch(/^water_sites_huc_all_/);
      expect(await stagedNameFor({ bbox: '-77.5,38.5,-76.5,39.5' })).toMatch(
        /^water_sites_bbox_all_/,
      );
    });

    it('is idempotent — the identical filter set re-stages to the same table', async () => {
      const first = await stagedNameFor({ stateCd: 'KS', siteType: 'GW' });
      const second = await stagedNameFor({ stateCd: 'KS', siteType: 'GW' });
      expect(second).toBe(first);
    });

    it('separates two queries whose results differ', async () => {
      // The #28 repro: two unrelated bboxes previously both landed on water_sites_bbox_all.
      const dc = await stagedNameFor({ bbox: '-77.5,38.5,-76.5,39.5' });
      const pugetSound = await stagedNameFor({ bbox: '-122.5,47.0,-121.5,48.0' });
      expect(pugetSound).not.toBe(dc);

      // And every dimension the old name dropped now moves it.
      const base = await stagedNameFor({ stateCd: 'KS', siteType: 'GW' });
      for (const extra of [
        { parameterCd: '00060' },
        { hasDataTypeCd: 'iv' },
        { siteOutput: 'expanded' },
      ]) {
        expect(await stagedNameFor({ stateCd: 'KS', siteType: 'GW', ...extra })).not.toBe(base);
      }
    });

    it('is unchanged by limit and offset — staging always holds the full match set', async () => {
      const base = await stagedNameFor({ stateCd: 'RI' });
      expect(await stagedNameFor({ stateCd: 'RI', limit: 5, offset: 2 })).toBe(base);
      expect(await stagedNameFor({ stateCd: 'RI', limit: 500, offset: 0 })).toBe(base);
    });

    it('is unchanged by canvas_id — the same query accumulates under one name', async () => {
      const base = await stagedNameFor({ stateCd: 'RI' });
      expect(await stagedNameFor({ stateCd: 'RI', canvas_id: 'cnvsites01' })).toBe(base);
    });

    it('never derives an illegal identifier from a multi-value countyCd or siteType', async () => {
      for (const input of [
        { countyCd: '51059,51061,51013,51107,51153,51683,51685,51600,51610,51510' },
        { stateCd: 'KS', siteType: 'ST,GW,LK,SP,AT,OC,ES' },
        { bbox: '-122.5,47.0,-121.5,48.0', siteType: 'ST,GW' },
      ]) {
        const name = await stagedNameFor(input);
        expect(name).toMatch(CANVAS_IDENTIFIER_REGEX);
        expect(name).not.toContain(',');
      }
    });

    it('describes canvas_id as adding a table, not appending to one', () => {
      const description = waterFindSites.input.shape.canvas_id.description ?? '';
      expect(description).not.toMatch(/append/i);
      expect(description).toMatch(/table/i);
    });
  });

  describe('canvas handoff notice (#34)', () => {
    it('names water_dataframe_describe before water_dataframe_query and carries the table name', async () => {
      mockFindSites.mockResolvedValue(makeSites(800));
      const { registerTable } = stageCanvas();
      const result = await runToolContract(waterFindSites, { stateCd: 'KS', siteType: 'GW' });
      const tableName = stagedTableName(registerTable);

      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toContain('water_dataframe_describe');
      expect(notice.indexOf('water_dataframe_describe')).toBeLessThan(
        notice.indexOf('water_dataframe_query'),
      );
      expect(notice).toContain(tableName);
      expect(notice).toContain('cnvsites01');

      // content[] gets the same pointer — the format() caption plus the enrichment trailer.
      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).toContain('water_dataframe_describe');
      expect(rendered).toContain(tableName);
    });
  });

  describe('canvas error contract (#39)', () => {
    it('declares canvas_not_found and canvas_capacity_exhausted as service-thrown', () => {
      const byReason = Object.fromEntries(waterFindSites.errors!.map((e) => [e.reason, e]));

      expect(byReason['canvas_not_found']).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        thrownBy: 'service',
      });
      expect(byReason['canvas_capacity_exhausted']).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        retryable: true,
        thrownBy: 'service',
      });
    });

    it('re-throws canvas_not_found with a hint naming the omit-for-a-fresh-canvas path', async () => {
      // The framework's own hint deliberately avoids suggesting omission — correct for a
      // describe/query tool, wrong for a producer, which mints a usable canvas when asked to.
      mockFindSites.mockResolvedValue(makeSites(800));
      mockCanvasInstance = {
        acquire: vi
          .fn()
          .mockRejectedValue(
            notFound('Canvas aaaaaaaaaa not found.', { reason: 'canvas_not_found' }),
          ),
      };

      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', canvas_id: 'aaaaaaaaaa' });
      const error = (await captureError(() => waterFindSites.handler(input, ctx))) as McpError;

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.NotFound,
        data: { reason: 'canvas_not_found', recovery: recovery('canvas_not_found') },
      });
      expect(error.data?.['recovery']).toMatchObject({ hint: expect.stringMatching(/omit/i) });
      expect(error.cause).toBeInstanceOf(McpError);
    });

    it('lets an unrelated acquire failure through untouched', async () => {
      mockFindSites.mockResolvedValue(makeSites(800));
      mockCanvasInstance = {
        acquire: vi.fn().mockRejectedValue(serviceUnavailable('canvas provider is down')),
      };

      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', canvas_id: 'aaaaaaaaaa' });
      const error = (await captureError(() => waterFindSites.handler(input, ctx))) as McpError;
      expect(error.data?.['reason']).toBeUndefined();
      expect(error.message).toContain('canvas provider is down');
    });
  });

  describe('supplied canvas_id resolution (#40)', () => {
    it('resolves a supplied canvas_id before the NWIS request', async () => {
      const acquire = vi
        .fn()
        .mockRejectedValue(
          notFound('Canvas aaaaaaaaaa not found.', { reason: 'canvas_not_found' }),
        );
      mockCanvasInstance = { acquire };
      mockFindSites.mockResolvedValue(makeSites(800));

      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', canvas_id: 'aaaaaaaaaa' });
      await expect(waterFindSites.handler(input, ctx)).rejects.toMatchObject({
        data: { reason: 'canvas_not_found' },
      });

      // A bad id costs no upstream round trip.
      expect(acquire).toHaveBeenCalledTimes(1);
      expect(mockFindSites).not.toHaveBeenCalled();
    });

    it('keeps minting lazy — no canvas is acquired when none was supplied and nothing stages', async () => {
      mockFindSites.mockResolvedValue(makeSites(100));
      const { acquire } = stageCanvas();
      const ctx = createMockContext({ errors: waterFindSites.errors });
      await waterFindSites.handler(waterFindSites.input.parse({ stateCd: 'RI' }), ctx);
      expect(acquire).not.toHaveBeenCalled();
    });

    it('reuses the pre-resolved canvas rather than acquiring twice when the result stages', async () => {
      mockFindSites.mockResolvedValue(makeSites(800));
      const { acquire, registerTable } = stageCanvas();
      const ctx = createMockContext({ errors: waterFindSites.errors });
      const input = waterFindSites.input.parse({ stateCd: 'RI', canvas_id: 'cnvsites01' });
      const result = await waterFindSites.handler(input, ctx);

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(acquire).toHaveBeenCalledWith('cnvsites01', ctx);
      expect(registerTable).toHaveBeenCalledTimes(1);
      expect(result.canvas_id).toBe('cnvsites01');
    });

    it('says on both surfaces that nothing was staged when the result fits inline', async () => {
      mockFindSites.mockResolvedValue(makeSites(74));
      stageCanvas();
      const result = await runToolContract(waterFindSites, {
        stateCd: 'RI',
        hasDataTypeCd: 'dv',
        canvas_id: 'cnvsites01',
      });

      const structured = result.structuredContent as { notice?: string; canvas_id?: string };
      expect(structured.notice).toContain('cnvsites01');
      expect(structured.notice).toMatch(/nothing was staged|inline/i);
      expect(structured.canvas_id).toBeUndefined();

      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).toContain('cnvsites01');
    });

    it('does not claim the set fit inline when it exceeded the cap with no canvas provider', async () => {
      // mockCanvasInstance stays undefined — no provider, so a supplied canvas_id cannot be used.
      mockFindSites.mockResolvedValue(makeSites(800));
      const result = await runToolContract(waterFindSites, {
        stateCd: 'RI',
        canvas_id: 'cnvsites01',
      });

      const structured = result.structuredContent as { notice?: string; canvas_id?: string };
      expect(structured.notice).toContain('cnvsites01');
      expect(structured.notice).not.toMatch(/fits within/);
      expect(structured.notice).toMatch(/DataCanvas is not enabled/);
      expect(structured.canvas_id).toBeUndefined();

      const rendered = result.content.map((b) => ('text' in b ? b.text : '')).join('\n');
      expect(rendered).toContain('DataCanvas is not enabled');
    });

    it('emits no such notice when no canvas_id was supplied', async () => {
      mockFindSites.mockResolvedValue(makeSites(74));
      stageCanvas();
      const ctx = createMockContext({ errors: waterFindSites.errors });
      await waterFindSites.handler(waterFindSites.input.parse({ stateCd: 'RI' }), ctx);
      expect(getEnrichment(ctx)).not.toHaveProperty('notice');
    });
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

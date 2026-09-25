/**
 * @fileoverview Tests for the USGS parameter-code catalog reader and search, run at the fetch seam:
 * a strict fetch mock serves captured catalog pages, so the real request, paging, response
 * validation, cache, and single-flight logic all execute. Each test loads a fresh module graph so
 * the module-scope cache starts empty.
 * @module tests/services/parameter-catalog.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from '../helpers/error-contract.js';
import {
  CATALOG_RECORD_COUNT,
  catalogRoutes,
  failingCatalogRoute,
  PAGE_2_OFFSET,
} from '../helpers/waterdata-fixtures.js';

type CatalogModule = typeof import('@/services/waterdata/parameter-catalog.js');

let http: FetchMockHarness;
let catalog: CatalogModule;

beforeEach(async () => {
  vi.resetModules();
  catalog = await import('@/services/waterdata/parameter-catalog.js');
  http = createFetchMock();
  http.install();
});

afterEach(() => {
  http.restore();
  vi.useRealTimers();
  delete process.env.USGS_REQUEST_TIMEOUT_MS;
});

describe('getParameterCatalog', () => {
  it('reads every page by following next links, sorted by code', async () => {
    http.route(...catalogRoutes());
    const records = await catalog.getParameterCatalog(createMockContext());

    expect(records).toHaveLength(CATALOG_RECORD_COUNT);
    expect(http.calls).toHaveLength(2);
    const second = new URL(http.calls[1]?.request.url ?? '');
    expect(second.searchParams.get('offset')).toBe(String(PAGE_2_OFFSET));
    const first = new URL(http.calls[0]?.request.url ?? '');
    expect(first.searchParams.get('limit')).toBe('50000');
    expect(first.searchParams.get('properties')).toBe(
      'parameter_name,unit_of_measure,parameter_description',
    );
    const codes = records.map((r) => r.code);
    expect(codes).toEqual([...codes].sort());
    expect(records.find((r) => r.code === '62610')).toEqual({
      code: '62610',
      name: 'Elevation, GW, NGVD29',
      unit: 'ft',
      description: 'Groundwater level above NGVD 1929, feet',
    });
  });

  it('decodes the HTML entities the catalog writes for < and >', async () => {
    http.route(...catalogRoutes());
    const records = await catalog.getParameterCatalog(createMockContext());
    expect(records.find((r) => r.code === '52140')).toMatchObject({
      name: 'Nitrate + nitrite, bs<63um',
      description:
        'Nitrate plus nitrite, bed sediment <63 microns, dry weight, milligrams per kilogram as nitrogen',
    });
    expect(records.some((r) => /&(lt|gt);/.test(r.name + r.description))).toBe(false);
  });

  it('sends the configured User-Agent', async () => {
    http.route(...catalogRoutes());
    await catalog.getParameterCatalog(createMockContext());
    expect(http.calls[0]?.request.headers.get('user-agent')).toMatch(/^usgs-water-mcp-server\//);
  });

  it('serves repeat reads from the cache for 24 hours, then refetches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
    http.route(...catalogRoutes());
    const ctx = createMockContext();

    const first = await catalog.getParameterCatalog(ctx);
    vi.setSystemTime(new Date('2026-09-25T23:59:59Z'));
    const cached = await catalog.getParameterCatalog(ctx);
    expect(cached).toBe(first);
    expect(http.calls).toHaveLength(2);

    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
    const refreshed = await catalog.getParameterCatalog(ctx);
    expect(http.calls).toHaveLength(4);
    expect(refreshed).toEqual(first);
    expect(refreshed).not.toBe(first);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    http.route(...catalogRoutes());
    const [a, b, c] = await Promise.all([
      catalog.getParameterCatalog(createMockContext()),
      catalog.getParameterCatalog(createMockContext()),
      catalog.getParameterCatalog(createMockContext()),
    ]);
    expect(http.calls).toHaveLength(2);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('raises ServiceUnavailable on an HTTP failure and caches nothing', async () => {
    http.route({ ...failingCatalogRoute(503, 'Service Unavailable'), once: true });
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toMatch(/parameter-code catalog/i);

    http.route(...catalogRoutes());
    const records = await catalog.getParameterCatalog(createMockContext());
    expect(records).toHaveLength(CATALOG_RECORD_COUNT);
    expect(http.calls).toHaveLength(3);
  });

  it('raises ServiceUnavailable when a later page fails, discarding the pages already read', async () => {
    const [page1] = catalogRoutes();
    http.route(page1!, {
      method: 'GET',
      match: (request) => new URL(request.url).searchParams.get('offset') === String(PAGE_2_OFFSET),
      respond: () => new Response('bad gateway', { status: 502 }),
      once: true,
    });
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);

    http.route(...catalogRoutes());
    await expect(catalog.getParameterCatalog(createMockContext())).resolves.toHaveLength(
      CATALOG_RECORD_COUNT,
    );
  });

  it('raises ServiceUnavailable when the request times out', async () => {
    process.env.USGS_REQUEST_TIMEOUT_MS = '50';
    vi.resetModules();
    catalog = await import('@/services/waterdata/parameter-catalog.js');
    http.route({
      method: 'GET',
      match: () => true,
      respond: (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason));
        }),
    });
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toMatch(/parameter-code catalog/i);
  });

  it('raises ServiceUnavailable on a body that is not a catalog page', async () => {
    http.route({
      method: 'GET',
      match: () => true,
      respond: () => new Response('<html>maintenance</html>', { status: 200 }),
    });
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });
});

describe('searchParameters', () => {
  /** A hand-built catalog slice: the cases below exercise ranking, not upstream parsing. */
  const RECORDS = [
    {
      code: '00060',
      name: 'Discharge',
      unit: 'ft3/s',
      description: 'Discharge, cubic feet per second',
    },
    {
      code: '00061',
      name: 'Discharge, instant.',
      unit: 'ft3/s',
      description: 'Discharge, instantaneous, cubic feet per second',
    },
    {
      code: '00400',
      name: 'pH',
      unit: 'std units',
      description: 'pH, water, unfiltered, field, standard units',
    },
    {
      code: '00403',
      name: 'pH, lab',
      unit: 'std units',
      description: 'pH, water, unfiltered, laboratory, standard units',
    },
    {
      code: '30208',
      name: 'Q, Xsec',
      unit: 'm3/s',
      description: 'Discharge, cross section, cubic meters per second',
    },
    { code: '99999', name: 'Phosphate', unit: 'mg/l', description: 'Phosphate, water, filtered' },
  ];

  it('orders curated matches first, then name matches, then description-only matches, each by code', () => {
    const results = catalog.searchParameters(RECORDS, 'discharge');
    expect(results.map((r) => [r.code, r.source])).toEqual([
      ['00060', 'curated'],
      ['00061', 'usgs-catalog'],
      ['30208', 'usgs-catalog'],
    ]);
    expect(results[0]).toEqual({
      code: '00060',
      name: 'Discharge',
      unit: 'ft³/s',
      group: 'streamflow',
      source: 'curated',
    });
    expect(results[1]).toEqual({ ...RECORDS[1], source: 'usgs-catalog' });
  });

  it('matches case-insensitively at the start of any word, requiring every token', () => {
    expect(catalog.searchParameters(RECORDS, 'PH LAB').map((r) => r.code)).toEqual(['00403']);
    expect(catalog.searchParameters(RECORDS, 'ph').map((r) => r.code)).toEqual([
      '00400',
      '00403',
      '99999',
    ]);
    expect(catalog.searchParameters(RECORDS, 'harge')).toEqual([]);
  });

  it('lets each token match in either the name or the description', () => {
    // "instant" is in 00061's name, "cubic" only in its description.
    expect(catalog.searchParameters(RECORDS, 'instant cubic').map((r) => r.code)).toEqual([
      '00061',
    ]);
  });

  it('treats a bare 5-digit query as a code lookup', () => {
    expect(catalog.searchParameters(RECORDS, '30208').map((r) => r.code)).toEqual(['30208']);
    expect(catalog.searchParameters(RECORDS, ' 00400 ')).toEqual([
      expect.objectContaining({ code: '00400', source: 'curated' }),
    ]);
    expect(catalog.searchParameters(RECORDS, '12345')).toEqual([]);
  });

  it('matches nothing for a query with no letters or digits', () => {
    expect(catalog.searchParameters(RECORDS, '--')).toEqual([]);
  });
});

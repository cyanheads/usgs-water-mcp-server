/**
 * @fileoverview Tests for the USGS parameter-code catalog reader and search, run at the fetch seam:
 * the Water Data fake serves captured catalog pages, so the real request core (retries, deadline,
 * error classification), paging, response validation, cache, and single-flight logic all execute.
 * Each test loads a fresh module graph so the module-scope cache, the client's cooldown gate, and
 * the parsed config start clean.
 * @module tests/services/parameter-catalog.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureError } from '../helpers/error-contract.js';
import {
  CATALOG_RECORD_COUNT,
  catalogRoutes,
  createWaterDataFake,
  failingCatalogRoute,
  jsonResponse,
  ogcRoute,
  PAGE_2_OFFSET,
  rateLimitResponse,
  stalled,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type CatalogModule = typeof import('@/services/waterdata/parameter-catalog.js');

let water: WaterDataFake;
let catalog: CatalogModule;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  catalog = await import('@/services/waterdata/parameter-catalog.js');
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

/** Fake the clocks the call deadline and the retry backoff read. */
function useFakeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
}

/** Settle a catalog read whose retries wait on the fake clock, capturing its rejection first. */
async function settle(operation: Promise<unknown>, advanceMs: number): Promise<unknown> {
  const outcome = operation.then(
    () => undefined,
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(advanceMs);
  return outcome;
}

/** Requests the code under test sent for the catalog's first page. */
function firstPageRequests() {
  return water.requests.filter((r) => !r.url.searchParams.has('offset'));
}

describe('getParameterCatalog', () => {
  it('reads every page by following next links, sorted by code', async () => {
    water.route(...catalogRoutes());
    const records = await catalog.getParameterCatalog(createMockContext());

    expect(records).toHaveLength(CATALOG_RECORD_COUNT);
    expect(water.requests).toHaveLength(2);
    const second = water.requests[1]!.url;
    expect(second.searchParams.get('offset')).toBe(String(PAGE_2_OFFSET));
    const first = water.requests[0]!.url;
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
    water.route(...catalogRoutes());
    const records = await catalog.getParameterCatalog(createMockContext());
    expect(records.find((r) => r.code === '52140')).toMatchObject({
      name: 'Nitrate + nitrite, bs<63um',
      description:
        'Nitrate plus nitrite, bed sediment <63 microns, dry weight, milligrams per kilogram as nitrogen',
    });
    expect(records.some((r) => /&(lt|gt);/.test(r.name + r.description))).toBe(false);
  });

  it('sends the configured User-Agent and no X-Api-Key without USGS_API_KEY', async () => {
    water.route(...catalogRoutes());
    await catalog.getParameterCatalog(createMockContext());
    expect(water.requests[0]?.headers.get('user-agent')).toMatch(/^usgs-water-mcp-server\//);
    expect(water.requests.every((r) => !r.headers.has('x-api-key'))).toBe(true);
  });

  it('sends USGS_API_KEY as X-Api-Key on every page, never in the URL', async () => {
    vi.stubEnv('USGS_API_KEY', 'catalog-test-key');
    vi.resetModules();
    catalog = await import('@/services/waterdata/parameter-catalog.js');
    water.route(...catalogRoutes());
    await catalog.getParameterCatalog(createMockContext());
    expect(water.requests).toHaveLength(2);
    for (const r of water.requests) {
      expect(r.headers.get('x-api-key')).toBe('catalog-test-key');
      expect(r.url.href).not.toContain('catalog-test-key');
    }
  });

  it('serves repeat reads from the cache for 24 hours, then refetches', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-25T00:00:00Z'));
    water.route(...catalogRoutes());
    const ctx = createMockContext();

    const first = await catalog.getParameterCatalog(ctx);
    vi.setSystemTime(new Date('2026-09-25T23:59:59Z'));
    const cached = await catalog.getParameterCatalog(ctx);
    expect(cached).toBe(first);
    expect(water.requests).toHaveLength(2);

    vi.setSystemTime(new Date('2026-09-26T00:00:00Z'));
    const refreshed = await catalog.getParameterCatalog(ctx);
    expect(water.requests).toHaveLength(4);
    expect(refreshed).toEqual(first);
    expect(refreshed).not.toBe(first);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    water.route(...catalogRoutes());
    const [a, b, c] = await Promise.all([
      catalog.getParameterCatalog(createMockContext()),
      catalog.getParameterCatalog(createMockContext()),
      catalog.getParameterCatalog(createMockContext()),
    ]);
    expect(water.requests).toHaveLength(2);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("never fails the shared fetch on the starting caller's cancellation", async () => {
    water.route(...catalogRoutes());
    const starter = new AbortController();
    starter.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    const [a, b] = await Promise.all([
      catalog.getParameterCatalog(createMockContext({ signal: starter.signal })),
      catalog.getParameterCatalog(createMockContext()),
    ]);
    expect(a).toHaveLength(CATALOG_RECORD_COUNT);
    expect(b).toBe(a);
    expect(water.requests).toHaveLength(2);
  });

  it('retries a transient 503 within the call and returns the catalog', async () => {
    useFakeClock();
    water.route(
      { ...failingCatalogRoute(503, 'Service Unavailable'), once: true },
      ...catalogRoutes(),
    );
    const pending = catalog.getParameterCatalog(createMockContext());
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toHaveLength(CATALOG_RECORD_COUNT);
    expect(firstPageRequests()).toHaveLength(2);
  });

  it('raises ServiceUnavailable after four 5xx attempts and caches nothing', async () => {
    useFakeClock();
    water.route(
      ...Array.from({ length: 4 }, () => ({
        ...failingCatalogRoute(503, 'Service Unavailable'),
        once: true,
      })),
    );
    const error = await settle(catalog.getParameterCatalog(createMockContext()), 10_000);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toBe(
      'The USGS parameter-code catalog could not be read: USGS Water Data OGC API answered HTTP 503: Service Unavailable (failed after 4 attempts)',
    );
    expect(firstPageRequests()).toHaveLength(4);

    water.route(...catalogRoutes());
    const records = await catalog.getParameterCatalog(createMockContext());
    expect(records).toHaveLength(CATALOG_RECORD_COUNT);
    expect(water.requests).toHaveLength(6);
  });

  it('raises ServiceUnavailable when a later page keeps failing, discarding the pages already read', async () => {
    useFakeClock();
    const [page1, page2] = catalogRoutes();
    const badPage2 = {
      ...ogcRoute('parameter-codes', () => new Response('bad gateway', { status: 502 }), {
        query: { offset: String(PAGE_2_OFFSET) },
      }),
      once: true,
    };
    water.route(page1!, badPage2, badPage2, badPage2, badPage2);
    const error = await settle(catalog.getParameterCatalog(createMockContext()), 10_000);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toMatch(
      /^The USGS parameter-code catalog could not be read/,
    );
    expect(water.requests.filter((r) => r.url.searchParams.has('offset'))).toHaveLength(4);

    water.route(page2!);
    await expect(catalog.getParameterCatalog(createMockContext())).resolves.toHaveLength(
      CATALOG_RECORD_COUNT,
    );
  });

  it('ends a stalled read at its 45-second budget, still as "could not be read"', async () => {
    useFakeClock();
    water.route(ogcRoute('parameter-codes', stalled));
    const error = await settle(catalog.getParameterCatalog(createMockContext()), 60_000);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toBe(
      'The USGS parameter-code catalog could not be read: getParameterCatalog ran out of the 45000 ms budget for this call after 2 attempts.',
    );
    // A 30 s attempt, a backoff, and a second attempt cut short by the budget.
    expect(water.requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('raises ServiceUnavailable at once on a body that is not a catalog page', async () => {
    water.route(
      ogcRoute('parameter-codes', () => new Response('<html>maintenance</html>', { status: 200 })),
    );
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect((error as McpError).message).toMatch(
      /^The USGS parameter-code catalog could not be read/,
    );
    expect(water.requests).toHaveLength(1);
  });

  it('passes a rate limit through as RateLimited, keeping its wait', async () => {
    water.route(ogcRoute('parameter-codes', () => rateLimitResponse(1800)));
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 1800, rateLimitPerHour: 1000 },
    });
    expect((error as McpError).message).not.toMatch(/could not be read/);
    expect(water.requests).toHaveLength(1);
  });

  it('passes a rejected USGS_API_KEY through as ConfigurationError', async () => {
    vi.stubEnv('USGS_API_KEY', 'rejected-key');
    vi.resetModules();
    catalog = await import('@/services/waterdata/parameter-catalog.js');
    water.route(
      ogcRoute('parameter-codes', () =>
        jsonResponse(waterDataFixture('error-403-api-key-invalid.json'), { status: 403 }),
      ),
    );
    const error = await captureError(() => catalog.getParameterCatalog(createMockContext()));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      data: { reason: 'api_key_rejected', upstreamCode: 'API_KEY_INVALID' },
    });
    expect((error as McpError).message).not.toMatch(/could not be read/);
    expect(water.requests).toHaveLength(1);
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

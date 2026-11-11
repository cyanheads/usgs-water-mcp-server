/**
 * @fileoverview Site discovery on the USGS Water Data OGC collections, run at the fetch seam: the
 * Water Data fake serves live captures of `monitoring-locations` and the latest-value collections,
 * so filter translation, the series union behind `lastObservedAt`, the `observedWithin` filter,
 * and the tool's error wiring all execute. The regex-timing suites run caller-sized siteType and
 * observedWithin values through `SITE_TYPE_CODE` and `PeriodSchema`. Each test loads its modules
 * fresh, so the resolver cache and the host cooldown gate start empty.
 * @module tests/services/site-discovery.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type FetchMockResponder,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiscoveredSite } from '@/services/waterdata/site-discovery.js';
import type { WaterDataRequest } from '@/services/waterdata/water-data-client.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  rateLimitResponse,
  stalled,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type Discovery = typeof import('@/services/waterdata/site-discovery.js');
type FindSitesTool =
  typeof import('@/mcp-server/tools/definitions/water-find-sites.tool.js')['waterFindSites'];

interface Feature {
  geometry?: unknown;
  id: string;
  properties: Record<string, unknown>;
}
interface Page {
  features: Feature[];
  links: { href: string; rel: string }[];
}

const fixture = (name: string): Page => JSON.parse(waterDataFixture(name));
const EMPTY = ogcPage([]);

/** The #52 box: Lake Washington to the Cedar River, WA. */
const BBOX = '-122.5,47.4,-122.0,47.8';
const ST_FILTER = "(site_type_code='ST' OR site_type_code LIKE 'ST-%')";
const BASIC =
  'monitoring_location_number,monitoring_location_name,site_type_code,altitude,hydrologic_unit_code';
const EXPANDED = `${BASIC},state_code,county_code,drainage_area,contributing_drainage_area`;
const SERIES_COLLECTIONS = [
  'latest-continuous',
  'latest-daily',
  'latest-field-measurements',
  'peaks',
] as const;

let discovery: Discovery;
let startDeadline: typeof import('@/services/waterdata/request-deadline.js')['startDeadline'];
let tool: FindSitesTool;
let water: WaterDataFake;

async function loadModules() {
  vi.resetModules();
  discovery = await import('@/services/waterdata/site-discovery.js');
  ({ startDeadline } = await import('@/services/waterdata/request-deadline.js'));
  ({ waterFindSites: tool } = await import(
    '@/mcp-server/tools/definitions/water-find-sites.tool.js'
  ));
}

beforeEach(async () => {
  vi.stubEnv('USGS_API_KEY', undefined);
  await loadModules();
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

function request(): WaterDataRequest {
  return {
    ctx: createMockContext(),
    deadline: startDeadline(),
    operation: 'findSites',
    signal: undefined,
  };
}

const serve = (collection: string, body: unknown) => ogcRoute(collection, () => jsonResponse(body));

/** Query pairs of every request sent to one collection's items, in order. */
function sent(collection: string): Record<string, string>[] {
  return water.requests
    .filter((r) => r.url.pathname === `/ogcapi/v1/collections/${collection}/items`)
    .map((r) => Object.fromEntries(r.url.searchParams));
}

/** Collections other than monitoring-locations that the call read. */
function seriesRead(): string[] {
  return SERIES_COLLECTIONS.filter((c) => sent(c).length > 0);
}

const text = (content: readonly { type: string; text?: string }[]) =>
  content.map((block) => block.text ?? '').join('\n');

const byNumber = (sites: DiscoveredSite[], number: string) =>
  sites.find((s) => s.siteNumber === number);

async function rejection(promise: Promise<unknown>): Promise<McpError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('stateFipsCode', () => {
  it('agrees with every coded row of the live states collection, in any case', async () => {
    const { stateFipsCode } = await import('@/services/waterdata/state-fips-codes.js');
    const rows = fixture('states-us.json').features.map((f) => f.properties) as {
      state_fips_code: string;
      state_postal_code: string | null;
    }[];
    const coded = rows.filter((r) => r.state_postal_code !== null);
    expect(coded).toHaveLength(64);
    for (const row of coded) {
      const postal = row.state_postal_code as string;
      expect(stateFipsCode(postal)).toBe(row.state_fips_code);
      expect(stateFipsCode(postal.toLowerCase())).toBe(row.state_fips_code);
    }
  });

  it('adds the freely associated states, which monitoring-locations files sites under though the collection omits them', async () => {
    const { stateFipsCode } = await import('@/services/waterdata/state-fips-codes.js');
    expect(['FM', 'mh', 'Pw'].map(stateFipsCode)).toEqual(['64', '68', '70']);
  });

  it('knows no other code', async () => {
    const { stateFipsCode } = await import('@/services/waterdata/state-fips-codes.js');
    for (const code of ['ZZ', 'US', '24', 'FS']) expect(stateFipsCode(code)).toBeUndefined();
  });
});

describe('findSites: filter translation', () => {
  it('reads monitoring-locations and one latest-continuous query for iv + parameterCd, nothing per site', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve('latest-continuous', fixture('sites-bbox-st-latest-continuous-00060.json')),
    );
    const sites = await discovery.findSites(
      {
        bbox: BBOX,
        siteType: 'ST',
        parameterCd: '00060',
        hasDataTypeCd: 'iv',
        siteOutput: 'basic',
      },
      request(),
    );

    expect(sites).toHaveLength(17);
    expect(water.requests).toHaveLength(2);
    expect(sent('monitoring-locations')).toEqual([
      {
        bbox: BBOX,
        'filter-lang': 'cql2-text',
        filter: ST_FILTER,
        properties: BASIC,
        limit: '50000',
        f: 'json',
      },
    ]);
    expect(sent('latest-continuous')).toEqual([
      {
        bbox: BBOX,
        parameter_code: '00060',
        skipGeometry: 'true',
        'filter-lang': 'cql2-text',
        filter: ST_FILTER,
        properties: 'monitoring_location_id,time',
        limit: '50000',
        f: 'json',
      },
    ]);
    expect(byNumber(sites, '12122500')?.lastObservedAt).toBe('1996-10-01T06:00:00.000Z');
    expect(byNumber(sites, '12120000')?.lastObservedAt).toBe('2019-05-09T16:45:00.000Z');
    expect(byNumber(sites, '12119000')?.lastObservedAt).toBe('2026-11-11T09:15:00.000Z');
  });

  it('keeps a major site type’s subtypes, as WaterServices did', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', siteOutput: 'basic' },
      request(),
    );
    expect(sites.filter((s) => s.siteType === 'ST-TS').map((s) => s.siteNumber)).toEqual([
      '473256122202901',
    ]);
    expect(sites.filter((s) => s.siteType === 'ST-DCH').map((s) => s.siteNumber)).toEqual([
      '474358122084001',
    ]);
  });

  it.each([
    ['ST', "(site_type_code='ST' OR site_type_code LIKE 'ST-%')"],
    ['st-ca', "(site_type_code='ST-CA')"],
    [
      'ST,GW',
      "(site_type_code='ST' OR site_type_code LIKE 'ST-%' OR site_type_code='GW' OR site_type_code LIKE 'GW-%')",
    ],
    ['ST-TS, gw', "(site_type_code='ST-TS' OR site_type_code='GW' OR site_type_code LIKE 'GW-%')"],
  ])('sends siteType %s as %s on every collection', async (siteType, filter) => {
    water.route(
      serve('monitoring-locations', EMPTY),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    await discovery.findSites({ huc: '02070008', siteType, siteOutput: 'basic' }, request());
    expect(water.requests).toHaveLength(4);
    for (const r of water.requests) expect(r.url.searchParams.get('filter')).toBe(filter);
  });

  it.each(['S_', 'ST%', 'STREAM', 'S', 'ST-', 'ST,'])(
    'refuses siteType %j before any request',
    async (siteType) => {
      const error = await rejection(
        discovery.findSites({ huc: '02070008', siteType, siteOutput: 'basic' }, request()),
      );
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_request' },
      });
      expect(error.message).toContain('is not a site type code');
      expect(water.requests).toHaveLength(0);
    },
  );

  it.each([
    ['md', '24'],
    ['MD', '24'],
    ['pr', '72'],
    ['DC', '11'],
    ['FM', '64'],
    ['mh', '68'],
    ['PW', '70'],
  ])('sends stateCd %s as FIPS state_code %s on every collection', async (stateCd, fips) => {
    water.route(
      serve('monitoring-locations', EMPTY),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    await discovery.findSites({ stateCd, siteOutput: 'basic' }, request());
    expect(water.requests).toHaveLength(4);
    for (const r of water.requests) {
      expect(r.url.searchParams.get('state_code')).toBe(fips);
      expect(r.url.searchParams.has('filter')).toBe(false);
    }
  });

  it('refuses an unknown stateCd before any request', async () => {
    const error = await rejection(
      discovery.findSites({ stateCd: 'ZZ', siteOutput: 'basic' }, request()),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
      message: 'stateCd "ZZ" is not a US state or territory postal code.',
    });
    expect(water.requests).toHaveLength(0);
  });

  it('splits a countyCd list into state and county pairs and lists every location', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-county-51013-51510-locations.json')),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    const sites = await discovery.findSites(
      { countyCd: '51013,51510', siteOutput: 'basic' },
      request(),
    );
    for (const r of water.requests) {
      expect(r.url.searchParams.get('filter')).toBe(
        "((state_code='51' AND county_code='013') OR (state_code='51' AND county_code='510'))",
      );
      expect(r.url.searchParams.has('state_code')).toBe(false);
      expect(r.url.searchParams.has('county_code')).toBe(false);
    }
    // No series filter: every location is listed, and none has a matching series here.
    expect(sites).toHaveLength(61);
    expect(sites.every((s) => s.lastObservedAt === null)).toBe(true);
  });

  it('sends huc as a plain prefix value with no CQL filter', async () => {
    water.route(
      serve('monitoring-locations', EMPTY),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    await discovery.findSites({ huc: '02', siteOutput: 'basic' }, request());
    for (const r of water.requests) {
      expect(r.url.searchParams.get('hydrologic_unit_code')).toBe('02');
      expect(r.url.searchParams.has('filter-lang')).toBe(false);
    }
  });

  it('sends several parameter codes as one CQL IN term', async () => {
    water.route(serve('monitoring-locations', EMPTY), serve('latest-continuous', EMPTY));
    await discovery.findSites(
      {
        bbox: BBOX,
        siteType: 'ST',
        parameterCd: '00060,00065',
        hasDataTypeCd: 'iv',
        siteOutput: 'basic',
      },
      request(),
    );
    const [query] = sent('latest-continuous');
    expect(query?.filter).toBe(`${ST_FILTER} AND (parameter_code IN ('00060','00065'))`);
    expect(query).not.toHaveProperty('parameter_code');
    expect(sent('monitoring-locations')[0]?.filter).toBe(ST_FILTER);
  });
});

describe('findSites: hasDataTypeCd', () => {
  it.each([
    [undefined, ['latest-continuous', 'latest-daily', 'latest-field-measurements']],
    ['iv', ['latest-continuous']],
    ['uv', ['latest-continuous']],
    ['rt', ['latest-continuous']],
    ['IV', ['latest-continuous']],
    ['dv', ['latest-daily']],
    ['gw', ['latest-field-measurements']],
    ['pk', ['peaks']],
    ['iv,dv', ['latest-continuous', 'latest-daily']],
    ['iv, uv', ['latest-continuous']],
  ])('reads %s from %j', async (hasDataTypeCd, collections) => {
    water.route(
      serve('monitoring-locations', EMPTY),
      ...SERIES_COLLECTIONS.map((c) => serve(c, EMPTY)),
    );
    await discovery.findSites(
      { huc: '02070008', siteOutput: 'basic', ...(hasDataTypeCd ? { hasDataTypeCd } : {}) },
      request(),
    );
    expect(seriesRead()).toEqual(collections);
    for (const c of collections) expect(sent(c)).toHaveLength(1);
  });

  it.each(['qw', 'sv', 'ad', 'aw', 'id', 'all', 'xyz', 'iv,qw'])(
    'refuses %j, naming the accepted codes, before any request',
    async (hasDataTypeCd) => {
      const error = await rejection(
        discovery.findSites({ huc: '02070008', hasDataTypeCd, siteOutput: 'basic' }, request()),
      );
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_request' },
      });
      const bad = hasDataTypeCd.split(',').at(-1);
      expect(error.message).toBe(
        `hasDataTypeCd "${bad}" has no source in the USGS Water Data APIs. Accepted codes: "iv" (aliases "uv", "rt"), "dv", "gw", "pk".`,
      );
      expect(water.requests).toHaveLength(0);
    },
  );

  it('reads groundwater levels from field measurements, without discharge and gage-height visits', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-small-bbox-locations.json')),
      serve('latest-field-measurements', fixture('sites-small-bbox-gw-levels.json')),
    );
    const sites = await discovery.findSites(
      { bbox: '-122.35,47.5,-122.25,47.6', hasDataTypeCd: 'gw', siteOutput: 'basic' },
      request(),
    );
    expect(sent('latest-field-measurements')[0]?.filter).toBe(
      "(observing_procedure LIKE 'GW level%')",
    );
    // 117 locations in the box; the 102 with a groundwater-level measurement remain.
    expect(sites).toHaveLength(102);
    expect(sites.every((s) => s.siteType === 'GW')).toBe(true);
    // A field measurement carries a date only; it counts from 00:00 UTC on it.
    expect(byNumber(sites, '473103122192401')?.lastObservedAt).toBe('2026-03-30T00:00:00.000Z');
  });

  it('takes the newest of a site’s many peaks', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve('peaks', fixture('sites-bbox-st-peaks-trimmed.json')),
    );
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', hasDataTypeCd: 'pk', siteOutput: 'basic' },
      request(),
    );
    expect(sites.map((s) => [s.siteNumber, s.lastObservedAt])).toEqual([
      ['12119000', '2025-02-23T00:00:00.000Z'],
      ['12120000', '2018-10-28T00:00:00.000Z'],
      ['12122500', '1996-02-09T00:00:00.000Z'],
    ]);
  });
});

describe('findSites: lastObservedAt and observedWithin', () => {
  function serveUnion() {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve('latest-continuous', fixture('sites-bbox-st-latest-continuous.json')),
      serve('latest-daily', fixture('sites-bbox-st-latest-daily.json')),
      serve('latest-field-measurements', fixture('sites-bbox-st-latest-field-measurements.json')),
    );
  }

  it('takes the newest observation across continuous, daily, and field-measurement series', async () => {
    serveUnion();
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', siteOutput: 'basic' },
      request(),
    );
    // Unfiltered: every location in the box is listed, with or without a series.
    expect(sites).toHaveLength(167);
    expect(sites.filter((s) => s.lastObservedAt !== null)).toHaveLength(64);
    // Continuous (09:15Z today) is newer than the same site's daily value (yesterday).
    expect(byNumber(sites, '12119000')?.lastObservedAt).toBe('2026-11-11T09:15:00.000Z');
    // The continuous record ended in 1996; a 2001 field measurement is the site's newest.
    expect(byNumber(sites, '12122500')?.lastObservedAt).toBe('2001-09-19T00:00:00.000Z');
    expect(byNumber(sites, '12113385')?.lastObservedAt).toBe('1997-09-29T00:00:00.000Z');
    expect(byNumber(sites, '12113340')?.lastObservedAt).toBe('1994-09-19T00:00:00.000Z');
    expect(byNumber(sites, '12072629')?.lastObservedAt).toBeNull();
    expect(water.requests).toHaveLength(4);
  });

  it('narrows to sites with a matching series when only parameterCd is set', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve('latest-continuous', fixture('sites-bbox-st-latest-continuous-00060.json')),
      serve('latest-daily', fixture('sites-bbox-latest-daily-00060.json')),
      serve('latest-field-measurements', EMPTY),
    );
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', parameterCd: '00060', siteOutput: 'basic' },
      request(),
    );
    for (const c of ['latest-continuous', 'latest-daily', 'latest-field-measurements']) {
      expect(sent(c)[0]?.parameter_code).toBe('00060');
    }
    // 17 continuous ∪ 49 daily series sites, less the one daily site that is not a stream.
    expect(sites).toHaveLength(49);
    expect(byNumber(sites, '12119730')?.lastObservedAt).toBe('1982-01-31T00:00:00.000Z');
  });

  it('sends observedWithin as the time filter of every series query, never of monitoring-locations', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', observedWithin: 'P30D', siteOutput: 'basic' },
      request(),
    );
    for (const c of ['latest-continuous', 'latest-daily', 'latest-field-measurements']) {
      expect(sent(c)[0]?.time).toBe('P30D');
    }
    expect(sent('monitoring-locations')[0]).not.toHaveProperty('time');
    // No series observed inside the window, so no site remains.
    expect(sites).toEqual([]);
  });

  it('keeps a site whose matching series carries no time, reporting null', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve(
        'latest-continuous',
        ogcPage([
          {
            type: 'Feature',
            id: 'x1',
            geometry: null,
            properties: { monitoring_location_id: 'USGS-12119000', time: null },
          },
        ]),
      ),
    );
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', hasDataTypeCd: 'iv', siteOutput: 'basic' },
      request(),
    );
    expect(sites.map((s) => [s.siteNumber, s.lastObservedAt])).toEqual([['12119000', null]]);
  });

  it('fails a series row whose time is not a date or instant as an unreadable response', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve(
        'latest-continuous',
        ogcPage([
          {
            type: 'Feature',
            id: 'x1',
            geometry: null,
            properties: { monitoring_location_id: 'USGS-12119000', time: 'yesterday' },
          },
        ]),
      ),
    );
    const error = await rejection(
      discovery.findSites({ bbox: BBOX, hasDataTypeCd: 'iv', siteOutput: 'basic' }, request()),
    );
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', retryable: false },
    });
    expect(sent('latest-continuous')).toHaveLength(1);
  });
});

describe('findSites: one failure stops the call', () => {
  it('aborts the sibling page walks and sends no further page once one collection fails', async () => {
    const stalledReads: Request[] = [];
    const stallRead: FetchMockResponder = (req) => {
      stalledReads.push(req);
      return typeof stalled === 'function' ? stalled(req) : stalled;
    };
    let releasePageOne: () => void = () => undefined;
    const pageOneHeld = new Promise<void>((resolve) => {
      releasePageOne = resolve;
    });
    const pageTwo = `https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items?cursor=p2&f=json`;
    water.route(
      ogcRoute('monitoring-locations', () => jsonResponse(EMPTY), { query: { cursor: 'p2' } }),
      ogcRoute('monitoring-locations', async () => {
        await pageOneHeld;
        return jsonResponse(ogcPage(fixture('sites-bbox-st-locations.json').features, pageTwo));
      }),
      ogcRoute('latest-continuous', () =>
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
      ogcRoute('latest-daily', stallRead),
      ogcRoute('latest-field-measurements', stallRead),
    );

    const error = await rejection(
      discovery.findSites({ bbox: BBOX, siteOutput: 'basic' }, request()),
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
    });
    expect(stalledReads).toHaveLength(2);
    for (const req of stalledReads) expect(req.signal.aborted).toBe(true);
    // The locations walk gets its first page only after the failure; it must not ask for the next.
    releasePageOne();
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    expect(sent('monitoring-locations').map((q) => q.cursor ?? null)).toEqual([null]);
    expect(water.requests).toHaveLength(4);
  });
});

describe('findSites: site rows', () => {
  const detail = fixture('site-detail-01646500.json');

  it('maps expanded metadata in the WaterServices key order', async () => {
    water.route(
      serve('monitoring-locations', detail),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    const [site] = await discovery.findSites({ stateCd: 'MD', siteOutput: 'expanded' }, request());
    expect(sent('monitoring-locations')[0]?.properties).toBe(EXPANDED);
    expect(site).toEqual({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      siteType: 'ST',
      latitude: 38.949777777777776,
      longitude: -77.12763888888888,
      stateCd: '24',
      countyCd: '031',
      drainageArea: 11560,
      altitude: 37.04,
      hucCd: '020700081005',
      lastObservedAt: null,
    });
    expect(Object.keys(site ?? {})).toEqual([
      'siteNumber',
      'siteName',
      'siteType',
      'latitude',
      'longitude',
      'stateCd',
      'countyCd',
      'drainageArea',
      'altitude',
      'hucCd',
      'lastObservedAt',
    ]);
  });

  it('omits the expanded fields in basic mode even when the upstream sends them', async () => {
    water.route(
      serve('monitoring-locations', detail),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    const [site] = await discovery.findSites({ stateCd: 'MD', siteOutput: 'basic' }, request());
    expect(sent('monitoring-locations')[0]?.properties).toBe(BASIC);
    expect(site).not.toHaveProperty('stateCd');
    expect(site).not.toHaveProperty('countyCd');
    expect(site).not.toHaveProperty('drainageArea');
    expect(site).not.toHaveProperty('contributingArea');
    expect(site).toMatchObject({ altitude: 37.04, hucCd: '020700081005' });
  });

  it('omits hucCd and altitude when the location has none (regressions: #22, #16)', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-small-bbox-locations.json')),
      serve('latest-field-measurements', EMPTY),
      serve('latest-continuous', EMPTY),
      serve('latest-daily', EMPTY),
    );
    const sites = await discovery.findSites(
      { bbox: '-122.35,47.5,-122.25,47.6', siteOutput: 'basic' },
      request(),
    );
    const noHuc = byNumber(sites, '473103122192401');
    expect(noHuc).toBeDefined();
    expect(noHuc).not.toHaveProperty('hucCd');
    const noAltitude = byNumber(sites, '12113445');
    expect(noAltitude).toBeDefined();
    expect(noAltitude).not.toHaveProperty('altitude');
    expect(noAltitude?.hucCd).toMatch(/^\d{8,12}$/);
  });

  it('joins sites across monitoring-locations pages and lists them by site number', async () => {
    const all = fixture('sites-bbox-st-locations.json');
    const next =
      'https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items?cursor=page2&f=json';
    // Out of order across the pages, as a cursor walk may deliver them.
    const first = {
      ...all,
      features: all.features.slice(100).reverse(),
      links: [{ rel: 'next', href: next }],
    };
    const second = { ...all, features: all.features.slice(0, 100), links: [] };
    water.route(
      ogcRoute('monitoring-locations', () => jsonResponse(first), { query: { cursor: null } }),
      ogcRoute('monitoring-locations', () => jsonResponse(second), { query: { cursor: 'page2' } }),
      serve('latest-continuous', fixture('sites-bbox-st-latest-continuous-00060.json')),
    );
    const sites = await discovery.findSites(
      { bbox: BBOX, siteType: 'ST', hasDataTypeCd: 'iv', siteOutput: 'basic' },
      request(),
    );
    expect(sent('monitoring-locations')).toHaveLength(2);
    expect(sites).toHaveLength(17);
    const numbers = sites.map((s) => s.siteNumber);
    expect(numbers).toEqual([...numbers].sort());
    // 12128000 sits on the first page, 12103330 on the second.
    expect(numbers).toContain('12128000');
    expect(numbers).toContain('12103330');
  });

  it('lists a number held by two agencies twice, each with its own observation', async () => {
    const all = fixture('sites-bbox-st-locations.json');
    const usgs = all.features.find((f) => f.id === 'USGS-12119000') as Feature;
    const other = { ...usgs, id: 'WA001-12119000' };
    water.route(
      serve('monitoring-locations', { ...all, features: [other, usgs] }),
      serve('latest-continuous', fixture('sites-bbox-st-latest-continuous.json')),
      serve('latest-daily', EMPTY),
      serve('latest-field-measurements', EMPTY),
    );
    const sites = await discovery.findSites({ bbox: BBOX, siteOutput: 'basic' }, request());
    expect(sites.map((s) => [s.siteNumber, s.lastObservedAt])).toEqual([
      ['12119000', '2026-11-11T09:15:00.000Z'],
      ['12119000', null],
    ]);
  });
});

describe('getSite', () => {
  const resolverRoute = () =>
    ogcRoute(
      'monitoring-locations',
      () => jsonResponse(waterDataFixture('monitoring-locations-by-number.json')),
      {
        query: {
          properties:
            'monitoring_location_number,monitoring_location_name,agency_code,time_zone_abbreviation,uses_daylight_savings',
        },
      },
    );

  it('reads the expanded record of the location the resolver picks', async () => {
    water.route(
      resolverRoute(),
      ogcRoute(
        'monitoring-locations',
        () => jsonResponse(waterDataFixture('site-detail-01646500.json')),
        {
          query: { monitoring_location_number: '01646500', properties: EXPANDED },
        },
      ),
    );
    const site = await discovery.getSite('01646500', request());
    expect(site).toEqual({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      siteType: 'ST',
      latitude: 38.949777777777776,
      longitude: -77.12763888888888,
      stateCd: '24',
      countyCd: '031',
      drainageArea: 11560,
      altitude: 37.04,
      hucCd: '020700081005',
    });
    expect(water.requests).toHaveLength(2);
  });

  it('reads a site another agency holds', async () => {
    water.route(
      resolverRoute(),
      ogcRoute(
        'monitoring-locations',
        () => jsonResponse(waterDataFixture('site-detail-364643089212301.json')),
        {
          query: { monitoring_location_number: '364643089212301', properties: EXPANDED },
        },
      ),
    );
    expect(await discovery.getSite('364643089212301', request())).toMatchObject({
      siteNumber: '364643089212301',
      siteName: 'East Prairie',
      siteType: 'GW',
      stateCd: '29',
      countyCd: '133',
      latitude: 36.779472,
      longitude: -89.356028,
    });
  });

  it('returns null for a number no location has, without a detail request', async () => {
    water.route(ogcRoute('monitoring-locations', () => jsonResponse(EMPTY)));
    expect(await discovery.getSite('99999999', request())).toBeNull();
    expect(water.requests).toHaveLength(1);
  });
});

describe('water_find_sites on the OGC collections', () => {
  const ACCEPTANCE = {
    bbox: BBOX,
    siteType: 'ST',
    parameterCd: '00060',
    hasDataTypeCd: 'iv',
  };

  it('keeps 12119000 and drops 12122500 and 12120000 with observedWithin P7D (#52)', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      ogcRoute(
        'latest-continuous',
        () => jsonResponse(fixture('sites-bbox-st-latest-continuous-00060-p7d.json')),
        {
          query: { time: 'P7D' },
        },
      ),
    );
    const result = await runToolContract(tool, { ...ACCEPTANCE, observedWithin: 'P7D' });
    expect(result.isError, text(result.content)).toBeFalsy();
    const structured = result.structuredContent as { sites: DiscoveredSite[]; total: number };
    const numbers = structured.sites.map((s) => s.siteNumber);
    expect(numbers).toEqual([
      '12113344',
      '12113346',
      '12113349',
      '12113390',
      '12119000',
      '12120600',
      '12121600',
    ]);
    expect(numbers).not.toContain('12122500');
    expect(numbers).not.toContain('12120000');
    expect(structured.sites.find((s) => s.siteNumber === '12119000')?.lastObservedAt).toBe(
      '2026-11-11T09:15:00.000Z',
    );
    const rendered = text(result.content);
    expect(rendered).toContain('(12119000)');
    expect(rendered).toContain('**Last observed:** 2026-11-11T09:15:00.000Z');
    expect(rendered).not.toContain('12122500');
    expect(rendered).toContain('observedWithin=P7D');
    // One query per collection, never one per site.
    expect(water.requests).toHaveLength(2);
  });

  it('lists the dormant gages with their last observation when observedWithin is omitted', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      ogcRoute(
        'latest-continuous',
        () => jsonResponse(fixture('sites-bbox-st-latest-continuous-00060.json')),
        {
          query: { time: null },
        },
      ),
    );
    const result = await runToolContract(tool, ACCEPTANCE);
    const structured = result.structuredContent as { sites: DiscoveredSite[] };
    expect(structured.sites).toHaveLength(17);
    const last = Object.fromEntries(structured.sites.map((s) => [s.siteNumber, s.lastObservedAt]));
    expect(last['12122500']).toBe('1996-10-01T06:00:00.000Z');
    expect(last['12120000']).toBe('2019-05-09T16:45:00.000Z');
    const rendered = text(result.content);
    expect(rendered).toContain('**Last observed:** 1996-10-01T06:00:00.000Z');
    expect(rendered).toContain('**Last observed:** 2019-05-09T16:45:00.000Z');
  });

  it('refuses an unsupported hasDataTypeCd with the accepted codes on both surfaces', async () => {
    const result = await runToolContract(tool, { stateCd: 'MD', hasDataTypeCd: 'qw' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_request',
          recovery: {
            hint: expect.stringContaining('"iv" (aliases "uv", "rt"), "dv", "gw", "pk"'),
          },
        },
      },
    });
    const rendered = text(result.content);
    expect(rendered).toContain('hasDataTypeCd "qw" has no source');
    expect(rendered).toContain('"iv" (aliases "uv", "rt"), "dv", "gw", "pk"');
    expect(rendered).not.toContain('water_find_sites');
    expect(water.requests).toHaveLength(0);
  });

  it('answers no_sites_found for a freely associated state with no sites, asked by its FIPS code', async () => {
    water.route(
      serve('monitoring-locations', EMPTY),
      ...['latest-continuous', 'latest-daily', 'latest-field-measurements'].map((c) =>
        serve(c, EMPTY),
      ),
    );
    const result = await runToolContract(tool, { stateCd: 'MH' });
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_sites_found' } },
    });
    expect(text(result.content)).toContain('No USGS sites match the specified filters.');
    expect(sent('monitoring-locations').map((q) => q.state_code)).toEqual(['68']);
    expect(water.requests).toHaveLength(4);
  });

  it('reports the upstream’s own description for a refused query', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      ogcRoute('latest-continuous', () =>
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
    );
    const result = await runToolContract(tool, ACCEPTANCE);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        message:
          'USGS Water Data OGC API rejected the request: bbox should be either 4 values (minx,miny,maxx,maxy) or 6 values (minx,miny,minz,maxx,maxy,maxz)',
        data: { reason: 'invalid_request' },
      },
    });
    expect(text(result.content)).toContain('correct it, and retry');
    expect(sent('latest-continuous')).toHaveLength(1);
  });

  it('reports an unreadable response as upstream_error without re-sending it', async () => {
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      serve('latest-continuous', { features: 'truncated' }),
    );
    const result = await runToolContract(tool, ACCEPTANCE);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryable: false },
      },
    });
    // An unreadable body fails the same way again, so the recovery says so beside the mark.
    expect(text(result.content)).toContain('not retryable');
    expect(text(result.content)).toContain('the same request will fail again');
    expect(sent('latest-continuous')).toHaveLength(1);
  });

  it('passes a rate limit through with its wait instead of reclassifying it', async () => {
    water.route(
      ogcRoute('monitoring-locations', () => rateLimitResponse(924)),
      serve('latest-continuous', fixture('sites-bbox-st-latest-continuous-00060.json')),
    );
    const result = await runToolContract(tool, ACCEPTANCE);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 924 },
      },
    });
    expect(text(result.content)).toContain('Wait the retryAfter interval');
    expect(sent('monitoring-locations')).toHaveLength(1);
  });

  it('ends a stalled series read at the call’s one 45-second budget', async () => {
    vi.stubEnv('USGS_REQUEST_TIMEOUT_MS', '120000');
    await loadModules();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    water.route(
      serve('monitoring-locations', fixture('sites-bbox-st-locations.json')),
      ogcRoute('latest-continuous', stalled),
    );
    const pending = runToolContract(tool, ACCEPTANCE);
    await vi.advanceTimersByTimeAsync(45_001);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.Timeout,
        message: 'findSites ran out of the 45000 ms budget for this call after 1 attempt.',
        data: { reason: 'upstream_timeout', deadlineMs: 45_000, operation: 'findSites' },
      },
    });
    expect(text(result.content)).toContain('narrow the geographic filters');
    expect(water.requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps caller cancellation a cancellation', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    water.route(ogcRoute('monitoring-locations', stalled), ogcRoute('latest-continuous', stalled));
    const controller = new AbortController();
    const pending = runToolContract(tool, ACCEPTANCE, { context: { signal: controller.signal } });
    await vi.advanceTimersByTimeAsync(0);
    expect(water.requests).toHaveLength(2);
    controller.abort(new DOMException('Caller cancelled site search', 'AbortError'));
    const result = await pending;
    const message = 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.';
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message },
    });
    expect(text(result.content)).toContain(message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(water.requests).toHaveLength(2);
  });
});

/** This thread's CPU time per call, in microseconds, across `calls` back-to-back runs. */
function cpuMicrosPerCall(run: () => void, calls: number): number {
  const start = process.threadCpuUsage();
  for (let i = 0; i < calls; i++) run();
  const { user, system } = process.threadCpuUsage(start);
  return (user + system) / calls;
}

const BASE_CHARS = 5_000;
const MAX_CHARS = 320_000;
/** Calls per 5k measurement; a larger size runs as many as keep the characters per measurement equal. */
const BASE_CALLS = 64;
const PAIRS = 5;
/** CPU ceiling per call at any size; the slowest shape below takes about 5 ms at 320k characters. */
const MAX_CALL_MICROS = 50_000;

/**
 * Expect `run` to scale linearly over `shape`. The input doubles from 5k to 320k characters; at
 * each size the 5k baseline is timed again beside it, PAIRS times, and the least of those growth
 * ratios must stay under four times the size ratio (256 across the full 64×) before the next size
 * runs, so a quadratic fails within a few doublings instead of stalling on the largest input. CPU
 * time, never wall clock: a loaded machine descheduling the worker adds no CPU time.
 */
function expectLinear(shape: (chars: number) => string, run: (input: string) => void): void {
  const base = shape(BASE_CHARS);
  for (let chars = BASE_CHARS * 2; chars <= MAX_CHARS; chars *= 2) {
    const input = shape(chars);
    const calls = Math.max(1, Math.round((BASE_CALLS * BASE_CHARS) / chars));
    let growth = Number.POSITIVE_INFINITY;
    let cost = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < PAIRS; pair++) {
      const baseline = cpuMicrosPerCall(() => run(base), BASE_CALLS);
      const sized = cpuMicrosPerCall(() => run(input), calls);
      growth = Math.min(growth, sized / baseline);
      cost = Math.min(cost, sized);
    }
    expect(growth, `growth at ${chars} characters`).toBeLessThan((4 * chars) / BASE_CHARS);
    expect(cost, `CPU µs per call at ${chars} characters`).toBeLessThan(MAX_CALL_MICROS);
  }
}

describe('regex timing: caller-sized input on water_find_sites', () => {
  /** Both line-break shapes ride along with each pattern's own worst cases. */
  const lineBreakShapes: [string, (chars: number) => string][] = [
    ['one long line ending in a break', (n) => `${'§1 x'.repeat(n / 4)}\ny`],
    ['line breaks throughout', (n) => '  \r\n'.repeat(n / 4)],
  ];

  it.each([
    ['a digit run', (n: number) => '1'.repeat(n)],
    ['a subtype that never closes', (n: number) => `ST-${'A'.repeat(n)}1`],
    ['valid codes ending in a bad one', (n: number) => `${'ST-CA,'.repeat(Math.ceil(n / 6))}1`],
    ...lineBreakShapes,
  ])(
    'refuses siteType as %s through SITE_TYPE_CODE in linear time, before any request',
    async (_shape, shape) => {
      const req = request();
      const outcomes: Promise<unknown>[] = [];
      // findSites validates synchronously before its first await, so the timed call covers the whole
      // split, trim, uppercase, and SITE_TYPE_CODE pass; each rejection is collected and checked below.
      expectLinear(shape, (siteType) => {
        const pending = discovery.findSites(
          { huc: '02070008', siteType, siteOutput: 'basic' },
          req,
        );
        outcomes.push(
          pending.then(
            () => 'resolved',
            (error: unknown) => (error instanceof McpError ? error.data?.['reason'] : error),
          ),
        );
      });
      expect(new Set(await Promise.all(outcomes))).toEqual(new Set(['invalid_request']));
      expect(water.requests).toHaveLength(0);
    },
  );

  it.each([
    ['a digit run after P', (n: number) => `P${'1'.repeat(n)}`],
    ['a digit run after PT', (n: number) => `PT${'1'.repeat(n)}`],
    ['a fraction that never closes', (n: number) => `PT1.${'1'.repeat(n)}X`],
    ...lineBreakShapes,
  ])('refuses observedWithin as %s through PeriodSchema in linear time', (_shape, shape) => {
    let accepted = 0;
    expectLinear(shape, (observedWithin) => {
      if (tool.input.safeParse({ stateCd: 'VA', observedWithin }).success) accepted++;
    });
    expect(accepted).toBe(0);
  });
});

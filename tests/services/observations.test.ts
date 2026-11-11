/**
 * @fileoverview Readings and series from the Water Data OGC collections at the fetch seam: the fake
 * serves captured `monitoring-locations`, `continuous`, `daily`, `time-series-metadata`,
 * `parameter-codes`, and `statistic-codes` bodies, so site resolution, the request core (retries,
 * deadline, classification), paging, chunking, the shared catalog loads, and series assembly all
 * run. Output is compared with WaterServices' answer for the same request, captured at the same
 * time, where one exists. Each test loads the modules fresh, so every cache starts empty.
 * @module tests/services/observations.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type FetchMockResponder } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NwisTimeSeries, NwisValueRecord } from '@/services/waterdata/types.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  type QueryMatch,
  rateLimitResponse,
  type SentRequest,
  stalled,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type Observations = typeof import('@/services/waterdata/observations.js');
type Deadlines = typeof import('@/services/waterdata/request-deadline.js');

let water: WaterDataFake;
let obs: Observations;
let deadlines: Deadlines;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  await load();
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

async function load() {
  obs = await import('@/services/waterdata/observations.js');
  deadlines = await import('@/services/waterdata/request-deadline.js');
}

function request(operation: string, signal?: AbortSignal) {
  return { ctx: createMockContext(), deadline: deadlines.startDeadline(), operation, signal };
}

/** Fake the clocks the call deadline and the retry backoff read. */
function useFakeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
}

interface Feature {
  id: string;
  properties: Record<string, unknown>;
  type: 'Feature';
}

function features(fixture: string): Feature[] {
  return (JSON.parse(waterDataFixture(fixture)) as { features: Feature[] }).features;
}

/** A responder as the function form, which a test can call to delegate. */
type Responder = Exclude<FetchMockResponder, Response>;

function fixtureResponse(fixture: string): Responder {
  return () => jsonResponse(waterDataFixture(fixture));
}

/** The fake's never-answering responder, narrowed to the function it is. */
const stall: Responder = (req) => (typeof stalled === 'function' ? stalled(req) : stalled);

/** Requests sent to one collection, in order. */
function sent(collection: string): SentRequest[] {
  return water.requests.filter(
    (r) => r.url.pathname === `/ogcapi/v1/collections/${collection}/items`,
  );
}

/** Request count per collection. */
function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of water.requests) {
    const collection = r.url.pathname.split('/')[4] ?? r.url.pathname;
    out[collection] = (out[collection] ?? 0) + 1;
  }
  return out;
}

const FILTER_KEYS = ['monitoring_location_id', 'parameter_code', 'statistic_id'];

/**
 * A captured table served the way the collection answers a plain-parameter query: only the
 * features whose properties equal every one of {@link FILTER_KEYS} the request names.
 */
function filteredRoute(collection: string, fixture: string, query?: QueryMatch) {
  const all = features(fixture);
  return ogcRoute(
    collection,
    (req) => {
      const params = new URL(req.url).searchParams;
      return jsonResponse(
        ogcPage(
          all.filter((f) =>
            FILTER_KEYS.every((k) => !params.has(k) || f.properties[k] === params.get(k)),
          ),
        ),
      );
    },
    query ? { query } : {},
  );
}

const OBSERVATION_PROPERTIES =
  'time_series_id,monitoring_location_id,parameter_code,statistic_id,time,value,approval_status,qualifier';
const METADATA_PROPERTIES =
  'monitoring_location_id,parameter_code,statistic_id,begin,sublocation_identifier,web_description,unit_of_measure,parameter_name';

const resolverRoute = () =>
  ogcRoute('monitoring-locations', fixtureResponse('observations-resolver-readings.json'));
const catalogRoute = (
  respond: FetchMockResponder = fixtureResponse('observations-parameter-codes.json'),
) => ogcRoute('parameter-codes', respond);
const statisticCodesRoute = (
  respond: FetchMockResponder = fixtureResponse('observations-statistic-codes.json'),
) => ogcRoute('statistic-codes', respond);
const pointsMetadataRoute = () =>
  filteredRoute('time-series-metadata', 'observations-tsm-readings-points.json', {
    computation_period_identifier: 'Points',
  });

/** A held response: `release()` lets it answer with `respond`. */
function held(respond: Responder) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const responder: FetchMockResponder = async (req) => {
    await gate;
    return respond(req);
  };
  return { responder, release };
}

/** The `IN (…)` values of one clause of a cql2-text filter. */
function inValues(filter: string | null, property: string): string[] {
  const match = filter?.match(new RegExp(`${property} IN \\(([^)]*)\\)`));
  return match?.[1]?.split(',').map((v) => v.replace(/^'|'$/g, '')) ?? [];
}

function pick(series: readonly NwisTimeSeries[], siteNumber: string, parameterCd: string) {
  return series.filter((s) => s.siteNumber === siteNumber && s.parameterCd === parameterCd);
}

/** The WaterServices reader's output for the same request, one entry per method block. */
interface WaterServicesBlock {
  methodDescription: string | null;
  parameterCd: string;
  siteNumber: string;
  statCd: string;
  statName: string | null;
  unitCode: string;
  values: NwisValueRecord[];
}

function waterServices(fixture: string): WaterServicesBlock[] {
  return JSON.parse(waterDataFixture(fixture)) as WaterServicesBlock[];
}

describe('carriesValues', () => {
  const series = (values: string[]): NwisTimeSeries => ({
    siteNumber: '01646500',
    siteName: '',
    parameterCd: '00060',
    parameterName: '',
    unitCode: '',
    statCd: '00000',
    statName: null,
    methodId: null,
    methodDescription: null,
    values: values.map((value) => ({
      dateTime: '2026-11-11T02:50:00.000-05:00',
      value,
      qualifiers: [],
    })),
  });

  it('is true when one record carries a value', () => {
    expect(obs.carriesValues(series(['', '0.00']))).toBe(true);
  });

  it('is false for records reported as no data, for no records, and for no series', () => {
    expect(obs.carriesValues(series(['', '']))).toBe(false);
    expect(obs.carriesValues(series([]))).toBe(false);
    expect(obs.carriesValues(undefined)).toBe(false);
  });
});

describe('getReadings', () => {
  /** Eight sites across five clocks and two agencies, plus a number nothing is registered under. */
  const SITES = [
    '01646500',
    '364643089212301',
    '14233500',
    '09497830',
    '06819550',
    '08131400',
    '01115170',
    '11176400',
    '99999999',
  ];

  function readingsRoutes(
    continuous = fixtureResponse('observations-continuous-readings-PT2H.json'),
  ) {
    water.route(
      resolverRoute(),
      ogcRoute('time-series-metadata', fixtureResponse('observations-tsm-readings-points.json'), {
        query: { computation_period_identifier: 'Points' },
      }),
      ogcRoute('continuous', continuous),
      catalogRoute(),
    );
  }

  it('returns one series per time-series metadata entry, the empty ones included', async () => {
    readingsRoutes();
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));

    const listed = features('observations-tsm-readings-points.json').map((f) => f.id);
    expect(series).toHaveLength(53);
    expect(series.map((s) => s.methodId).sort()).toEqual([...listed].sort());
    for (const s of series) expect(s.methodId).toMatch(/^[0-9a-f]{32}$/);

    expect(
      pick(series, '01646500', '00010').map((s) => [s.methodDescription, s.values.length]),
    ).toEqual([
      ['4.1 ft from riverbed (middle), [Discontinued]', 0],
      ['7.1 ft from riverbed (top), [Discontinued]', 0],
      ['1.0 ft from riverbed (bottom), [Discontinued]', 0],
      ['From multiparameter sonde, [Discontinued]', 0],
      ['From multiparameter sonde', 21],
    ]);
    expect(
      pick(series, '14233500', '00060').map((s) => [
        s.methodId,
        s.methodDescription,
        s.values.length,
      ]),
    ).toEqual([
      ['dcc1a8a32dc84a149b49c29bc18bd45a', null, 0],
      ['98fb5314c4bf4399a452fc3cbebe374a', null, 6],
    ]);
  });

  it('labels, units, and names each series from its metadata and the parameter catalog', async () => {
    readingsRoutes();
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    const one = (site: string, parameter: string, index = 0) =>
      pick(series, site, parameter)[index];

    expect(one('06819550', '00065')).toMatchObject({
      methodDescription: '[Radar]',
      unitCode: 'ft',
    });
    expect(one('01115170', '00020')).toMatchObject({
      methodDescription: 'Met station',
      unitCode: 'deg C',
      parameterName: 'Temperature, air, degrees Celsius',
    });
    expect(one('01115170', '74207')).toMatchObject({
      methodDescription: 'Met station, [4 in below ground surface A]',
      unitCode: '%',
      values: [],
    });
    expect(one('01646500', '00060')).toMatchObject({
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      methodDescription: null,
      unitCode: 'ft3/s',
      parameterName: 'Discharge, cubic feet per second',
    });
    expect(one('01646500', '00095', 2)).toMatchObject({
      methodDescription: 'From multiparameter sonde',
      unitCode: 'uS/cm @25C',
    });
    expect(one('01646500', '63680', 1)).toMatchObject({
      methodDescription: 'From multiparameter sonde',
      unitCode: 'FNU',
    });
    expect(pick(series, '09497830', '00065').map((s) => s.methodDescription)).toEqual([
      '[From WQ-Probe (Backup)]',
      null,
    ]);
    for (const s of series) expect(s).toMatchObject({ statCd: '00000', statName: null });
  });

  it('resolves a site of another agency and leaves out a number with no site', async () => {
    readingsRoutes();
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    expect([...new Set(series.map((s) => s.siteNumber))]).toEqual([
      '01115170',
      '01646500',
      '06819550',
      '08131400',
      '09497830',
      '11176400',
      '14233500',
      '364643089212301',
    ]);
    expect(pick(series, '364643089212301', '72019')[0]).toMatchObject({
      siteName: 'East Prairie',
      values: [
        { dateTime: '2026-11-11T02:30:00.000-06:00', value: '10.52', qualifiers: ['P'] },
        { dateTime: '2026-11-11T03:00:00.000-06:00', value: '10.52', qualifiers: ['P'] },
      ],
    });
  });

  it('writes no-data records as "" with their qualifiers, and keeps words WaterServices dropped', async () => {
    readingsRoutes();
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    expect(pick(series, '11176400', '00060')[0]?.values[0]).toEqual({
      dateTime: '2026-11-11T00:15:00.000-08:00',
      value: '',
      qualifiers: ['P', 'ZFL'],
    });
    expect(pick(series, '09497830', '00010')[0]?.values[0]).toEqual({
      dateTime: '2026-11-11T01:15:00.000-07:00',
      value: '8.0',
      qualifiers: ['P', 'OTHERAGENCY'],
    });
    expect(pick(series, '06819550', '00300')[0]?.values[0]).toEqual({
      dateTime: '2026-11-11T02:15:00.000-06:00',
      value: '',
      qualifiers: ['P', 'Dis', 'Eqp'],
    });
  });

  it('matches WaterServices for the same sites and window, apart from the listed differences', async () => {
    readingsRoutes();
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    const blocks = waterServices('expected-waterservices-iv-readings-PT2H.json');

    /** Labels only WaterServices wrote, for the series that carry them. */
    const waterServicesLabel = new Map([
      ['6c904cf82efd42a6b7f94c982cea89f7', 'From multiparameter sonde, [(2)]'],
      ['98fb5314c4bf4399a452fc3cbebe374a', '[(2)]'],
    ]);
    const differences = new Set<string>();
    let compared = 0;
    for (const s of series) {
      const label = waterServicesLabel.get(s.methodId ?? '') ?? s.methodDescription;
      const twins = blocks.filter(
        (b) =>
          b.siteNumber === s.siteNumber &&
          b.parameterCd === s.parameterCd &&
          b.methodDescription === label,
      );
      expect(twins, `${s.siteNumber}/${s.parameterCd} ${label}`).toHaveLength(1);
      const twin = twins[0]!;
      expect(s.unitCode).toBe(twin.unitCode);
      const byTime = new Map(twin.values.map((v) => [v.dateTime, v]));
      for (const record of s.values) {
        const theirs = byTime.get(record.dateTime);
        if (!theirs) continue;
        compared++;
        const key = `${s.siteNumber}/${s.parameterCd}`;
        if (record.value !== theirs.value)
          differences.add(`${key} value "${record.value}" vs "${theirs.value}"`);
        const prefix = record.qualifiers.slice(0, theirs.qualifiers.length);
        expect(prefix, `${key} ${record.dateTime}`).toEqual(theirs.qualifiers);
        const extra = record.qualifiers.slice(theirs.qualifiers.length);
        if (extra.length > 0) differences.add(`${key} adds ${extra.join(',')}`);
      }
    }
    // Every OGC record has a WaterServices record at the same site-local timestamp.
    expect(compared).toBe(404);
    expect([...differences].sort()).toEqual([
      // WaterServices showed a value the Water Data API holds as missing.
      '01115170/72198 adds Ssn',
      '01115170/72198 value "" vs "0.010"',
      // WaterServices listed one qualifier per record and dropped OTHERAGENCY.
      '06819550/00300 adds Eqp',
      '09497830/00010 adds OTHERAGENCY',
      '09497830/00065 adds OTHERAGENCY',
      '09497830/00095 adds OTHERAGENCY',
      '09497830/00300 adds OTHERAGENCY',
      '09497830/00400 adds OTHERAGENCY',
      '09497830/63675 adds OTHERAGENCY',
      '09497830/70969 adds OTHERAGENCY',
    ]);
  });

  it('orders series by site number, parameter code, and first observation', async () => {
    readingsRoutes();
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    const keys = series.map((s) => `${s.siteNumber}/${s.parameterCd}`);
    expect(keys).toEqual([...keys].sort());
    expect(pick(series, '01646500', '00010').map((s) => s.methodId)).toEqual([
      '52b33353ad684b76a8afd49cf017a42c',
      'c8e767f6cdfc4ff484a99f77962dc46c',
      'f60be489a22b4dfd9fd0fb97f3acc285',
      '089a50eca92a4e268b8816a1bc22c000',
      'd1875d1d73e447d2a1203105ba654e7d',
    ]);
    for (const s of series) {
      const times = s.values.map((v) => Date.parse(v.dateTime));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
  });

  it('keeps a series whose metadata is not listed yet, unlabeled and after the listed ones', async () => {
    const unlisted = 'd1875d1d73e447d2a1203105ba654e7d';
    water.route(
      resolverRoute(),
      ogcRoute('time-series-metadata', () =>
        jsonResponse(
          ogcPage(
            features('observations-tsm-readings-points.json').filter((f) => f.id !== unlisted),
          ),
        ),
      ),
      ogcRoute('continuous', fixtureResponse('observations-continuous-readings-PT2H.json')),
      catalogRoute(),
    );
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    expect(series).toHaveLength(53);
    const temperature = pick(series, '01646500', '00010');
    expect(temperature.map((s) => s.methodId).at(-1)).toBe(unlisted);
    expect(temperature.at(-1)).toMatchObject({
      methodDescription: null,
      unitCode: 'deg C',
      parameterName: 'Temperature, water, degrees Celsius',
      statCd: '00000',
    });
    expect(temperature.at(-1)?.values).toHaveLength(21);
  });

  it('reads every site in one continuous and one metadata request, filtered by monitoring location', async () => {
    readingsRoutes();
    await obs.getReadings({ sites: SITES }, request('getReadings'));
    expect(counts()).toEqual({
      'monitoring-locations': 1,
      continuous: 1,
      'time-series-metadata': 1,
      'parameter-codes': 1,
    });
    const ids = features('observations-resolver-readings.json')
      .map((f) => f.id)
      .sort();
    const [continuous] = sent('continuous');
    const [metadata] = sent('time-series-metadata');
    for (const r of [continuous!, metadata!]) {
      expect(r.url.searchParams.get('filter-lang')).toBe('cql2-text');
      expect(r.url.searchParams.get('filter')).toMatch(/^monitoring_location_id IN \('[^)]*'\)$/);
      expect(inValues(r.url.searchParams.get('filter'), 'monitoring_location_id').sort()).toEqual(
        ids,
      );
      expect(r.url.searchParams.get('skipGeometry')).toBe('true');
    }
    expect(Object.fromEntries(continuous!.url.searchParams)).toMatchObject({
      time: 'PT2H',
      properties: OBSERVATION_PROPERTIES,
      limit: '50000',
      f: 'json',
    });
    expect(Object.fromEntries(metadata!.url.searchParams)).toMatchObject({
      computation_period_identifier: 'Points',
      properties: METADATA_PROPERTIES,
      limit: '10000',
      f: 'json',
    });
    expect(metadata!.url.searchParams.has('time')).toBe(false);
  });

  it('costs two requests once the sites and the catalog are cached', async () => {
    readingsRoutes();
    const resolvable = SITES.filter((site) => site !== '99999999');
    const cold = await obs.getReadings({ sites: resolvable }, request('getReadings'));
    expect(water.requests).toHaveLength(4);
    const warm = await obs.getReadings({ sites: resolvable }, request('getReadings'));
    expect(warm).toEqual(cold);
    expect(
      water.requests
        .slice(4)
        .map((r) => r.url.pathname.split('/')[4])
        .sort(),
    ).toEqual(['continuous', 'time-series-metadata']);
  });

  it('asks again for a number that resolved to nothing, since a miss is never cached', async () => {
    readingsRoutes();
    await obs.getReadings({ sites: SITES }, request('getReadings'));
    await obs.getReadings({ sites: SITES }, request('getReadings'));
    const warm = water.requests.slice(4);
    expect(warm.map((r) => r.url.pathname.split('/')[4]).sort()).toEqual([
      'continuous',
      'monitoring-locations',
      'time-series-metadata',
    ]);
    const resolver = warm.find((r) => r.url.pathname.includes('monitoring-locations'));
    expect(resolver?.url.searchParams.get('monitoring_location_number')).toBe('99999999');
  });

  it('narrows both reads to the requested parameter codes', async () => {
    water.route(
      resolverRoute(),
      ogcRoute('time-series-metadata', () =>
        jsonResponse(
          ogcPage(
            features('observations-tsm-readings-points.json').filter(
              (f) =>
                f.properties.monitoring_location_id === 'USGS-01646500' &&
                ['00060', '00065'].includes(f.properties.parameter_code as string),
            ),
          ),
        ),
      ),
      ogcRoute('continuous', fixtureResponse('observations-continuous-parameter-in.json')),
      catalogRoute(),
    );
    const series = await obs.getReadings(
      { sites: ['01646500'], parameterCds: ['00060', '00065'] },
      request('getReadings'),
    );
    const filter =
      "monitoring_location_id IN ('USGS-01646500') AND parameter_code IN ('00060','00065')";
    expect(sent('continuous')[0]?.url.searchParams.get('filter')).toBe(filter);
    expect(sent('time-series-metadata')[0]?.url.searchParams.get('filter')).toBe(filter);
    expect(series.map((s) => [s.parameterCd, s.methodId, s.values.length])).toEqual([
      ['00060', '66a4e3fb8abe42fcb0942b5c0fe98f68', 21],
      ['00065', '8a83eb3a3cbc4087b0c201cf07c0c76d', 21],
    ]);
  });

  it('asks for the period it is given', async () => {
    readingsRoutes(() => jsonResponse(ogcPage([])));
    await obs.getReadings({ sites: ['01646500'], period: 'P1D' }, request('getReadings'));
    expect(sent('continuous')[0]?.url.searchParams.get('time')).toBe('P1D');
  });

  it('returns every listed series empty when the window holds no rows', async () => {
    readingsRoutes(() => jsonResponse(ogcPage([])));
    const series = await obs.getReadings({ sites: SITES }, request('getReadings'));
    expect(series).toHaveLength(53);
    expect(series.some((s) => obs.carriesValues(s))).toBe(false);
  });

  it('normalizes a qualifier sent as one string', async () => {
    const row = features('observations-continuous-parameter-in.json')[0]!;
    water.route(
      resolverRoute(),
      ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([]))),
      ogcRoute('continuous', () =>
        jsonResponse(ogcPage([{ ...row, properties: { ...row.properties, qualifier: 'ICE' } }])),
      ),
      catalogRoute(),
    );
    const [series] = await obs.getReadings({ sites: ['01646500'] }, request('getReadings'));
    expect(series?.values[0]?.qualifiers).toEqual(['P', 'Ice']);
  });

  it('returns nothing and asks nothing more when no site resolves', async () => {
    water.route(ogcRoute('monitoring-locations', () => jsonResponse(ogcPage([]))));
    expect(
      await obs.getReadings({ sites: ['99999999', '99999998'] }, request('getReadings')),
    ).toEqual([]);
    expect(counts()).toEqual({ 'monitoring-locations': 1 });
  });

  it('reads the most sites a call takes, 100, in one request per collection', async () => {
    const numbers = Array.from({ length: 100 }, (_, i) => String(10_000_000 + i));
    water.route(
      ogcRoute('monitoring-locations', (req) =>
        jsonResponse(
          ogcPage(
            (new URL(req.url).searchParams.get('monitoring_location_number') ?? '')
              .split(',')
              .map((n) => ({
                type: 'Feature',
                id: `USGS-${n}`,
                geometry: null,
                properties: {
                  monitoring_location_number: n,
                  monitoring_location_name: `Site ${n}`,
                  agency_code: 'USGS',
                  time_zone_abbreviation: 'CST',
                  uses_daylight_savings: 'Y',
                },
              })),
          ),
        ),
      ),
      ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([]))),
      ogcRoute('continuous', () => jsonResponse(ogcPage([]))),
      catalogRoute(),
    );
    expect(await obs.getReadings({ sites: numbers }, request('getReadings'))).toEqual([]);
    expect(counts()).toEqual({
      'monitoring-locations': 1,
      continuous: 1,
      'time-series-metadata': 1,
      'parameter-codes': 1,
    });
    for (const r of [...sent('continuous'), ...sent('time-series-metadata')]) {
      expect(inValues(r.url.searchParams.get('filter'), 'monitoring_location_id').sort()).toEqual(
        numbers.map((n) => `USGS-${n}`),
      );
    }
  });
});

describe('getReadings failures', () => {
  function routes(overrides: {
    catalog?: FetchMockResponder;
    continuous?: FetchMockResponder;
    metadata?: FetchMockResponder;
  }) {
    water.route(
      resolverRoute(),
      ogcRoute(
        'time-series-metadata',
        overrides.metadata ?? fixtureResponse('observations-tsm-readings-points.json'),
      ),
      ogcRoute(
        'continuous',
        overrides.continuous ?? fixtureResponse('observations-continuous-readings-PT2H.json'),
      ),
      catalogRoute(overrides.catalog),
    );
  }
  const params = { sites: ['01646500', '14233500'] };

  it('fails an unreadable continuous body at once as upstream_error', async () => {
    routes({ continuous: () => new Response('<html>maintenance</html>', { status: 200 }) });
    const error = await obs.getReadings(params, request('getReadings')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'USGS Water Data OGC API sent a response that is not JSON (getReadings).',
      data: { reason: 'upstream_error', retryable: false },
    });
    expect(sent('continuous')).toHaveLength(1);
  });

  it.each([
    ['without a series ID', { time_series_id: undefined }, 'features.0.properties.time_series_id'],
    [
      'with an unreadable time',
      { time: 'yesterday' },
      'features.0.properties.time: expected an ISO 8601 instant',
    ],
    ['with a numeric value', { value: 1890 }, 'features.0.properties.value'],
  ])('fails a row %s at once as upstream_error', async (_label, patch, path) => {
    const row = features('observations-continuous-parameter-in.json')[0]!;
    routes({
      continuous: () =>
        jsonResponse(ogcPage([{ ...row, properties: { ...row.properties, ...patch } }])),
    });
    const error = await obs.getReadings(params, request('getReadings')).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining(`sent an unexpected response (getReadings): ${path}`),
      data: { reason: 'upstream_error', retryable: false },
    });
    expect(sent('continuous')).toHaveLength(1);
  });

  it('passes a rate limit through as RateLimited, keeping its wait', async () => {
    routes({ continuous: () => rateLimitResponse(1800) });
    const error = await obs.getReadings(params, request('getReadings')).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 1800, rateLimitPerHour: 1000 },
    });
    expect(sent('continuous')).toHaveLength(1);
  });

  it('fails the call with the catalog read’s typed error, never degrading', async () => {
    routes({
      catalog: () =>
        jsonResponse(waterDataFixture('error-403-api-key-invalid.json'), { status: 403 }),
    });
    const error = await obs.getReadings(params, request('getReadings')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).code).toBe(JsonRpcErrorCode.ConfigurationError);
  });

  it('aborts the call’s other requests when one fails', async () => {
    let stalledRequest: Request | undefined;
    routes({
      continuous: (req) => {
        stalledRequest = req;
        return stall(req);
      },
      metadata: () =>
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
    });
    const error = await obs.getReadings(params, request('getReadings')).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
    });
    expect(stalledRequest?.signal.aborted).toBe(true);
  });

  it('ends a wait on a stalled catalog at the call’s own budget', async () => {
    vi.stubEnv('USGS_REQUEST_TIMEOUT_MS', '120000');
    vi.resetModules();
    await load();
    useFakeClock();
    water.route(
      ogcRoute('monitoring-locations', async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return fixtureResponse('observations-resolver-readings.json')(req);
      }),
      ogcRoute('time-series-metadata', fixtureResponse('observations-tsm-readings-points.json')),
      ogcRoute('continuous', fixtureResponse('observations-continuous-readings-PT2H.json')),
      catalogRoute(stalled),
    );
    let error: unknown;
    const done = obs.getReadings(params, request('getReadings')).then(
      () => {
        throw new Error('Expected a timeout.');
      },
      (e: unknown) => {
        error = e;
      },
    );
    await vi.advanceTimersByTimeAsync(44_999);
    expect(error).toBeUndefined();
    expect(counts()).toEqual({
      'monitoring-locations': 1,
      continuous: 1,
      'time-series-metadata': 1,
      'parameter-codes': 1,
    });
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message:
        'getReadings ran out of the 45000 ms budget for this call waiting for the parameter-code catalog.',
      data: {
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
        elapsedMs: 45_000,
        operation: 'getReadings',
      },
    });
    expect(water.requests).toHaveLength(4);
  });

  it('rethrows the caller’s cancellation of a request without retrying it', async () => {
    useFakeClock();
    routes({ continuous: stalled });
    const controller = new AbortController();
    const outcome = obs
      .getReadings(params, request('getReadings', controller.signal))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(water.requests).toHaveLength(4);
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.',
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(water.requests).toHaveLength(4);
  });

  it('ends its wait on the shared catalog at the caller’s cancellation, with the caller’s reason', async () => {
    const catalog = held(fixtureResponse('observations-parameter-codes.json'));
    routes({ catalog: catalog.responder });
    const controller = new AbortController();
    const pending = obs.getReadings(params, request('getReadings', controller.signal));
    await vi.waitFor(() => expect(water.requests).toHaveLength(4));
    const reason = new DOMException('Caller cancelled the request', 'AbortError');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    catalog.release();
    await vi.waitFor(() => expect(sent('parameter-codes')).toHaveLength(1));
    expect(water.requests).toHaveLength(4);
  });

  it('sends nothing for a call cancelled before it starts, rethrowing the caller’s reason', async () => {
    routes({});
    const controller = new AbortController();
    const reason = new DOMException('Caller cancelled the request', 'AbortError');
    controller.abort(reason);
    await expect(obs.getReadings(params, request('getReadings', controller.signal))).rejects.toBe(
      reason,
    );
    expect(water.requests).toHaveLength(0);
  });

  it('keeps the shared catalog read going for a concurrent caller when one caller cancels', async () => {
    const catalog = held(fixtureResponse('observations-parameter-codes.json'));
    routes({ catalog: catalog.responder });
    const first = new AbortController();
    const cancelled = obs.getReadings(params, request('getReadings', first.signal));
    const waiting = obs.getReadings(params, request('getReadings', new AbortController().signal));
    await vi.waitFor(() => expect(sent('continuous')).toHaveLength(2));
    const reason = new DOMException('Caller cancelled the request', 'AbortError');
    first.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    catalog.release();
    const series = await waiting;
    // 19 series at 01646500 and 2 at 14233500, named and unit-coded from the catalog read.
    expect(series).toHaveLength(21);
    expect(pick(series, '01646500', '00060')[0]).toMatchObject({
      unitCode: 'ft3/s',
      parameterName: 'Discharge, cubic feet per second',
    });
    expect(sent('parameter-codes')).toHaveLength(1);
  });
});

describe('getSeries — daily', () => {
  function dailyRoutes(dailyFixture: string, metadataFixture: string) {
    water.route(
      resolverRoute(),
      filteredRoute('time-series-metadata', metadataFixture, {
        computation_period_identifier: 'Daily',
      }),
      filteredRoute('daily', dailyFixture),
      catalogRoute(),
      statisticCodesRoute(),
    );
  }
  const temperature = {
    site: '01646500',
    parameterCd: '00010',
    seriesType: 'daily' as const,
    startDate: '2019-09-01',
    endDate: '2019-09-05',
  };

  it('matches WaterServices for every statistic and sensor, the empty sensor included', async () => {
    dailyRoutes(
      'observations-daily-01646500-00010-20190901-05.json',
      'observations-tsm-daily-01646500-00010.json',
    );
    const series = await obs.getSeries(temperature, request('getSeries'));
    const blocks = waterServices('expected-waterservices-dv-01646500-00010-20190901-05.json');
    expect(series).toHaveLength(15);
    expect(blocks).toHaveLength(15);
    const matched = new Set<WaterServicesBlock>();
    for (const s of series) {
      const twin = blocks.find(
        (b) => b.statCd === s.statCd && b.methodDescription === s.methodDescription,
      );
      expect(twin, `${s.statCd} ${s.methodDescription}`).toBeDefined();
      matched.add(twin!);
      expect(s).toMatchObject({
        siteNumber: twin!.siteNumber,
        parameterCd: twin!.parameterCd,
        unitCode: twin!.unitCode,
        statName: twin!.statName,
        parameterName: 'Temperature, water, degrees Celsius',
      });
      expect(s.values).toEqual(twin!.values);
      expect(s.methodId).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(matched.size).toBe(15);
  });

  it('orders daily series by statistic code, then first observation', async () => {
    dailyRoutes(
      'observations-daily-01646500-00010-20190901-05.json',
      'observations-tsm-daily-01646500-00010.json',
    );
    const series = await obs.getSeries(temperature, request('getSeries'));
    const sensors = [
      '7.1 ft from riverbed (top), [Discontinued]',
      '4.1 ft from riverbed (middle), [Discontinued]',
      '1.0 ft from riverbed (bottom), [Discontinued]',
      'From multiparameter sonde, [Discontinued]',
      'From multiparameter sonde',
    ];
    expect(series.map((s) => [s.statCd, s.statName, s.methodDescription])).toEqual(
      [
        ['00001', 'Maximum'],
        ['00002', 'Minimum'],
        ['00003', 'Mean'],
      ].flatMap(([code, name]) => sensors.map((sensor) => [code, name, sensor])),
    );
  });

  it('reads the whole range in one daily query beside the daily metadata, five requests cold and two warm', async () => {
    dailyRoutes(
      'observations-daily-01646500-00010-20190901-05.json',
      'observations-tsm-daily-01646500-00010.json',
    );
    await obs.getSeries(temperature, request('getSeries'));
    expect(counts()).toEqual({
      'monitoring-locations': 1,
      daily: 1,
      'time-series-metadata': 1,
      'parameter-codes': 1,
      'statistic-codes': 1,
    });
    expect(Object.fromEntries(sent('daily')[0]!.url.searchParams)).toEqual({
      monitoring_location_id: 'USGS-01646500',
      parameter_code: '00010',
      time: '2019-09-01/2019-09-05',
      skipGeometry: 'true',
      properties: OBSERVATION_PROPERTIES,
      limit: '50000',
      f: 'json',
    });
    expect(Object.fromEntries(sent('time-series-metadata')[0]!.url.searchParams)).toEqual({
      monitoring_location_id: 'USGS-01646500',
      parameter_code: '00010',
      computation_period_identifier: 'Daily',
      skipGeometry: 'true',
      properties: METADATA_PROPERTIES,
      limit: '10000',
      f: 'json',
    });
    await obs.getSeries(temperature, request('getSeries'));
    expect(
      water.requests
        .slice(5)
        .map((r) => r.url.pathname.split('/')[4])
        .sort(),
    ).toEqual(['daily', 'time-series-metadata']);
  });

  it('keeps one statistic, asking both reads for it', async () => {
    dailyRoutes(
      'observations-daily-01646500-00010-20190901-05.json',
      'observations-tsm-daily-01646500-00010.json',
    );
    const series = await obs.getSeries({ ...temperature, statCd: '00003' }, request('getSeries'));
    expect(sent('daily')[0]?.url.searchParams.get('statistic_id')).toBe('00003');
    expect(sent('time-series-metadata')[0]?.url.searchParams.get('statistic_id')).toBe('00003');
    const means = waterServices('expected-waterservices-dv-01646500-00010-20190901-05.json').filter(
      (b) => b.statCd === '00003',
    );
    expect(series).toHaveLength(5);
    for (const s of series) {
      expect(s).toMatchObject({ statCd: '00003', statName: 'Mean' });
      expect(s.values).toEqual(
        means.find((b) => b.methodDescription === s.methodDescription)?.values,
      );
    }
  });

  it('matches WaterServices for daily discharge, oldest day first', async () => {
    dailyRoutes(
      'observations-daily-01646500-00060-20240101-10.json',
      'observations-tsm-daily-01646500-00060.json',
    );
    const series = await obs.getSeries(
      { ...temperature, parameterCd: '00060', startDate: '2024-01-01', endDate: '2024-01-10' },
      request('getSeries'),
    );
    const [twin] = waterServices('expected-waterservices-dv-01646500-00060-20240101-10.json');
    expect(series).toEqual([
      {
        siteNumber: '01646500',
        siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
        parameterCd: '00060',
        parameterName: 'Discharge, cubic feet per second',
        unitCode: twin!.unitCode,
        statCd: '00003',
        statName: 'Mean',
        methodId: '2cf409b0d9694c01828f5d4ff14586a5',
        methodDescription: twin!.methodDescription,
        values: twin!.values,
      },
    ]);
  });

  it('returns nothing and asks nothing more when the site does not resolve', async () => {
    water.route(ogcRoute('monitoring-locations', () => jsonResponse(ogcPage([]))));
    expect(await obs.getSeries({ ...temperature, site: '99999999' }, request('getSeries'))).toEqual(
      [],
    );
    expect(counts()).toEqual({ 'monitoring-locations': 1 });
  });

  it('fails the call with the statistic-name read’s typed error, never degrading', async () => {
    water.route(
      resolverRoute(),
      filteredRoute('time-series-metadata', 'observations-tsm-daily-01646500-00010.json'),
      filteredRoute('daily', 'observations-daily-01646500-00010-20190901-05.json'),
      catalogRoute(),
      statisticCodesRoute(() =>
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
    );
    const error = await obs.getSeries(temperature, request('getSeries')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
    });
  });

  it('ends a wait on stalled statistic names at the call’s own budget', async () => {
    vi.stubEnv('USGS_REQUEST_TIMEOUT_MS', '120000');
    vi.resetModules();
    await load();
    useFakeClock();
    water.route(
      ogcRoute('monitoring-locations', async (req) => {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return fixtureResponse('observations-resolver-readings.json')(req);
      }),
      filteredRoute('time-series-metadata', 'observations-tsm-daily-01646500-00010.json'),
      filteredRoute('daily', 'observations-daily-01646500-00010-20190901-05.json'),
      catalogRoute(),
      statisticCodesRoute(stalled),
    );
    const outcome = obs.getSeries(temperature, request('getSeries')).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message:
        'getSeries ran out of the 45000 ms budget for this call waiting for the statistic-code names.',
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 45_000, operation: 'getSeries' },
    });
    expect(sent('statistic-codes')).toHaveLength(1);
    expect(water.requests).toHaveLength(5);
  });

  it('keeps the shared statistic-name read going for a concurrent caller when one caller cancels', async () => {
    const names = held(fixtureResponse('observations-statistic-codes.json'));
    water.route(
      resolverRoute(),
      filteredRoute('time-series-metadata', 'observations-tsm-daily-01646500-00010.json'),
      filteredRoute('daily', 'observations-daily-01646500-00010-20190901-05.json'),
      catalogRoute(),
      statisticCodesRoute(names.responder),
    );
    const first = new AbortController();
    const cancelled = obs.getSeries(temperature, request('getSeries', first.signal));
    const waiting = obs.getSeries(temperature, request('getSeries', new AbortController().signal));
    await vi.waitFor(() => expect(sent('daily')).toHaveLength(2));
    const reason = new DOMException('Caller cancelled the request', 'AbortError');
    first.abort(reason);
    await expect(cancelled).rejects.toBe(reason);
    names.release();
    const series = await waiting;
    expect(series).toHaveLength(15);
    expect(new Set(series.map((s) => s.statName))).toEqual(new Set(['Maximum', 'Minimum', 'Mean']));
    expect(sent('statistic-codes')).toHaveLength(1);
  });
});

describe('getSeries — instantaneous', () => {
  const DISCHARGE_SERIES = '66a4e3fb8abe42fcb0942b5c0fe98f68';
  const discharge = {
    site: '01646500',
    parameterCd: '00060',
    seriesType: 'instantaneous' as const,
    startDate: '2026-11-01',
    endDate: '2026-11-01',
  };

  function routes(continuous: FetchMockResponder | ReturnType<typeof ogcRoute>[]) {
    water.route(resolverRoute(), pointsMetadataRoute(), catalogRoute());
    if (Array.isArray(continuous)) water.route(...continuous);
    else water.route(ogcRoute('continuous', continuous));
  }
  const empty: FetchMockResponder = () => jsonResponse(ogcPage([]));
  const times = () => sent('continuous').map((r) => r.url.searchParams.get('time'));

  /**
   * "Today" for the end clamp: a day after every range these tests ask for, so each is read as
   * asked. The clamp tests set their own.
   */
  beforeEach(() => {
    vi.setSystemTime(new Date('2027-06-01T12:00:00Z'));
  });

  /** A `continuous` row of the discharge series. */
  function row(time: string, value: string) {
    return {
      type: 'Feature',
      id: `row-${time}`,
      geometry: null,
      properties: {
        time_series_id: DISCHARGE_SERIES,
        monitoring_location_id: 'USGS-01646500',
        parameter_code: '00060',
        statistic_id: '00011',
        time,
        value,
        approval_status: 'Provisional',
        qualifier: null,
      },
    };
  }

  it.each([
    [
      'an EST site on its fall-back day',
      '01646500',
      '00060',
      '2026-11-01',
      '2026-11-01T04:00:00Z/2026-11-02T04:59:59Z',
    ],
    [
      'an EST site on its spring-forward day',
      '01646500',
      '00060',
      '2026-03-08',
      '2026-03-08T05:00:00Z/2026-03-09T03:59:59Z',
    ],
    [
      'a CST site of another agency',
      '364643089212301',
      '72019',
      '2026-11-01',
      '2026-11-01T05:00:00Z/2026-11-02T05:59:59Z',
    ],
    [
      'an MST site without daylight time',
      '09497830',
      '00010',
      '2026-11-01',
      '2026-11-01T07:00:00Z/2026-11-02T06:59:59Z',
    ],
  ])(
    'asks for the site-local day of %s as explicit UTC instants',
    async (_label, site, parameterCd, date, time) => {
      routes(empty);
      await obs.getSeries(
        { ...discharge, site, parameterCd, startDate: date, endDate: date },
        request('getSeries'),
      );
      expect(times()).toEqual([time]);
      expect(Object.fromEntries(sent('continuous')[0]!.url.searchParams)).toMatchObject({
        parameter_code: parameterCd,
        properties: OBSERVATION_PROPERTIES,
        limit: '50000',
        skipGeometry: 'true',
      });
    },
  );

  it.each([
    [
      'spring-forward',
      'observations-continuous-01646500-00060-dst-spring.json',
      '2026-03-08',
      '2026-03-08',
      'spring',
    ],
    [
      'fall-back',
      'observations-continuous-01646500-00060-dst-fall.json',
      '2026-10-31',
      '2026-11-01',
      'fall',
    ],
  ] as const)(
    'writes the %s rows with WaterServices’ timestamps',
    async (_label, fixture, startDate, endDate, key) => {
      routes(fixtureResponse(fixture));
      const series = await obs.getSeries(
        { ...discharge, startDate, endDate },
        request('getSeries'),
      );
      const expected = (
        JSON.parse(waterDataFixture('expected-waterservices-iv-01646500-00060-dst.json')) as Record<
          'fall' | 'spring',
          NwisValueRecord[]
        >
      )[key];
      expect(series).toHaveLength(1);
      expect(series[0]).toMatchObject({
        methodId: DISCHARGE_SERIES,
        methodDescription: null,
        statCd: '00000',
        statName: null,
        unitCode: 'ft3/s',
        parameterName: 'Discharge, cubic feet per second',
      });
      expect(series[0]?.values).toEqual(expected);
    },
  );

  it('reads a range over 366 days as consecutive site-local windows, the last one short', async () => {
    routes(empty);
    await obs.getSeries(
      { ...discharge, startDate: '2024-01-01', endDate: '2026-12-31' },
      request('getSeries'),
    );
    expect(times()).toEqual([
      '2024-01-01T05:00:00Z/2025-01-01T04:59:59Z',
      '2025-01-01T05:00:00Z/2026-01-02T04:59:59Z',
      '2026-01-02T05:00:00Z/2027-01-01T04:59:59Z',
    ]);
  });

  it('runs at most four windows at a time and reads every one', async () => {
    let inFlight = 0;
    let most = 0;
    const waiting: (() => void)[] = [];
    routes(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise<void>((resolve) => waiting.push(resolve));
      inFlight--;
      return jsonResponse(ogcPage([]));
    });
    const pending = obs.getSeries(
      { ...discharge, startDate: '2018-01-01', endDate: '2025-12-31' },
      request('getSeries'),
    );
    await vi.waitFor(() => expect(sent('continuous')).toHaveLength(4));
    for (let answered = 0; answered < 8; answered++) {
      await vi.waitFor(() => expect(waiting.length).toBeGreaterThan(0));
      waiting.shift()?.();
    }
    await pending;
    expect(most).toBe(4);
    expect(times()).toHaveLength(8);
    expect(new Set(times()).size).toBe(8);
    expect(times()[0]).toBe('2018-01-01T05:00:00Z/2019-01-02T04:59:59Z');
    expect(times().at(-1)).toBe('2025-01-06T05:00:00Z/2026-01-01T04:59:59Z');
  });

  it('counts a record read in two windows once, and follows a next link inside a window', async () => {
    const [first, second, third] = [
      '2024-01-01T05:00:00Z/2025-01-01T04:59:59Z',
      '2025-01-01T05:00:00Z/2026-01-02T04:59:59Z',
      '2026-01-02T05:00:00Z/2026-01-03T04:59:59Z',
    ];
    const next = `https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items?cursor=c2&time=${encodeURIComponent(second)}&f=json`;
    routes([
      ogcRoute(
        'continuous',
        () =>
          jsonResponse(
            ogcPage([row('2024-06-01T12:00:00+00:00', '1'), row('2025-01-01T04:55:00+00:00', '2')]),
          ),
        {
          query: { time: first },
        },
      ),
      ogcRoute(
        'continuous',
        () =>
          jsonResponse(
            ogcPage(
              [row('2025-01-01T04:55:00+00:00', 'seam'), row('2025-06-01T12:00:00+00:00', '3')],
              next,
            ),
          ),
        { query: { time: second, cursor: null } },
      ),
      ogcRoute('continuous', () => jsonResponse(ogcPage([row('2025-12-01T12:00:00+00:00', '4')])), {
        query: { cursor: 'c2' },
      }),
      ogcRoute('continuous', () => jsonResponse(ogcPage([row('2026-01-02T12:00:00+00:00', '5')])), {
        query: { time: third },
      }),
    ]);
    const [series] = await obs.getSeries(
      { ...discharge, startDate: '2024-01-01', endDate: '2026-01-02' },
      request('getSeries'),
    );
    expect(series?.values.map((v) => [v.dateTime, v.value])).toEqual([
      ['2024-06-01T08:00:00.000-04:00', '1'],
      ['2024-12-31T23:55:00.000-05:00', '2'],
      ['2025-06-01T08:00:00.000-04:00', '3'],
      ['2025-12-01T07:00:00.000-05:00', '4'],
      ['2026-01-02T07:00:00.000-05:00', '5'],
    ]);
    const read = sent('continuous').map(
      (r) => `${r.url.searchParams.get('time')} cursor=${r.url.searchParams.get('cursor')}`,
    );
    expect(read.sort()).toEqual(
      [
        `${first} cursor=null`,
        `${second} cursor=null`,
        `${second} cursor=c2`,
        `${third} cursor=null`,
      ].sort(),
    );
  });

  it('starts the range at the site’s first observation of the parameter, leaving the end as asked', async () => {
    routes(empty);
    const series = await obs.getSeries(
      {
        ...discharge,
        site: '09497830',
        parameterCd: '00065',
        startDate: '2026-01-01',
        endDate: '2026-11-10',
      },
      request('getSeries'),
    );
    // Both gage-height series begin 2026-07-13T00:00Z — July 12 on the site's MST clock.
    expect(times()).toEqual(['2026-07-12T07:00:00Z/2026-11-11T06:59:59Z']);
    expect(series.map((s) => [s.methodDescription, s.values.length])).toEqual([
      ['[From WQ-Probe (Backup)]', 0],
      [null, 0],
    ]);
  });

  it('starts at the earliest first observation when the site’s series began on different days', async () => {
    // The backup gage-height sensor moved back to 2026-03-01 (05:00 on the site's MST clock).
    const BACKUP_SENSOR = '948d8ed67c17408f9a91c30663ceae06';
    const listed = features('observations-tsm-readings-points.json').map((f) =>
      f.id === BACKUP_SENSOR
        ? { ...f, properties: { ...f.properties, begin: '2026-03-01T12:00:00+00:00' } }
        : f,
    );
    water.route(
      resolverRoute(),
      ogcRoute('time-series-metadata', (req) => {
        const params = new URL(req.url).searchParams;
        return jsonResponse(
          ogcPage(
            listed.filter((f) =>
              FILTER_KEYS.every((k) => !params.has(k) || f.properties[k] === params.get(k)),
            ),
          ),
        );
      }),
      catalogRoute(),
      ogcRoute('continuous', empty),
    );
    await obs.getSeries(
      {
        ...discharge,
        site: '09497830',
        parameterCd: '00065',
        startDate: '2026-01-01',
        endDate: '2026-11-10',
      },
      request('getSeries'),
    );
    // The other sensor still begins 2026-07-13; the range starts at the earlier, 2026-03-01.
    expect(times()).toEqual(['2026-03-01T07:00:00Z/2026-11-11T06:59:59Z']);
  });

  it('sends no continuous request when the site’s first observation follows the range', async () => {
    routes(empty);
    const series = await obs.getSeries(
      {
        ...discharge,
        site: '09497830',
        parameterCd: '00065',
        startDate: '2026-01-01',
        endDate: '2026-06-30',
      },
      request('getSeries'),
    );
    expect(counts()).toEqual({
      'monitoring-locations': 1,
      'time-series-metadata': 1,
      'parameter-codes': 1,
    });
    expect(series).toHaveLength(2);
    expect(series.every((s) => s.values.length === 0)).toBe(true);
  });

  it('reads the whole range when the metadata states no first observation', async () => {
    water.route(
      resolverRoute(),
      ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([]))),
      ogcRoute('continuous', () => jsonResponse(ogcPage([row('2026-11-01T12:00:00+00:00', '7')]))),
      catalogRoute(),
    );
    const series = await obs.getSeries(
      { ...discharge, startDate: '2026-10-31' },
      request('getSeries'),
    );
    expect(times()).toEqual(['2026-10-31T04:00:00Z/2026-11-02T04:59:59Z']);
    expect(series.map((s) => [s.methodId, s.methodDescription, s.values.length])).toEqual([
      [DISCHARGE_SERIES, null, 1],
    ]);
  });

  it('reads nothing for a range that ends before it starts', async () => {
    routes(empty);
    const series = await obs.getSeries(
      { ...discharge, startDate: '2026-11-02', endDate: '2026-11-01' },
      request('getSeries'),
    );
    expect(sent('continuous')).toHaveLength(0);
    expect(series.map((s) => s.values.length)).toEqual([0]);
  });

  it('asks for the metadata first, then each window; once cached, the sites and catalog cost nothing', async () => {
    routes(empty);
    const params = { ...discharge, startDate: '2024-01-01', endDate: '2026-12-31' };
    await obs.getSeries(params, request('getSeries'));
    expect(counts()).toEqual({
      'monitoring-locations': 1,
      'time-series-metadata': 1,
      continuous: 3,
      'parameter-codes': 1,
    });
    const order = water.requests.map((r) => r.url.pathname.split('/')[4]);
    expect(order.indexOf('time-series-metadata')).toBeLessThan(order.indexOf('continuous'));
    expect(Object.fromEntries(sent('time-series-metadata')[0]!.url.searchParams)).toMatchObject({
      monitoring_location_id: 'USGS-01646500',
      parameter_code: '00060',
      computation_period_identifier: 'Points',
    });
    await obs.getSeries(params, request('getSeries'));
    expect(water.requests.slice(6).map((r) => r.url.pathname.split('/')[4])).toEqual([
      'time-series-metadata',
      'continuous',
      'continuous',
      'continuous',
    ]);
  });

  it('rethrows the caller’s cancellation mid-range and starts no more windows', async () => {
    useFakeClock();
    routes(stalled);
    const controller = new AbortController();
    const outcome = obs
      .getSeries(
        { ...discharge, startDate: '2021-01-01', endDate: '2025-12-31' },
        request('getSeries', controller.signal),
      )
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent('continuous')).toHaveLength(4);
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.',
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sent('continuous')).toHaveLength(4);
  });

  it('runs every window on the call’s one deadline', async () => {
    vi.stubEnv('USGS_REQUEST_TIMEOUT_MS', '120000');
    vi.resetModules();
    await load();
    useFakeClock();
    // Answers after 25 s unless the request is aborted first, as a real fetch would be.
    routes(
      (req) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => resolve(jsonResponse(ogcPage([]))), 25_000);
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(req.signal.reason);
          });
        }),
    );
    const outcome = obs
      .getSeries(
        { ...discharge, startDate: '2018-01-01', endDate: '2025-12-31' },
        request('getSeries'),
      )
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(44_999);
    // The first four windows answered at 25 s; the other four started then, on what was left.
    expect(sent('continuous')).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'getSeries ran out of the 45000 ms budget for this call after 1 attempt.',
      data: { reason: 'retry_deadline_exceeded', deadlineMs: 45_000, retryAttempts: 1 },
    });
    expect(sent('continuous')).toHaveLength(8);
  });

  it('aborts the windows in flight and starts no more when one window fails', async () => {
    const stalledWindows: Request[] = [];
    let failures = 0;
    routes((req) => {
      if (stalledWindows.length + failures === 1) {
        failures++;
        return jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), {
          status: 400,
        });
      }
      stalledWindows.push(req);
      return stall(req);
    });
    const error = await obs
      .getSeries(
        { ...discharge, startDate: '2021-01-01', endDate: '2025-12-31' },
        request('getSeries'),
      )
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
    });
    expect(stalledWindows).toHaveLength(3);
    for (const req of stalledWindows) expect(req.signal.aborted).toBe(true);
    expect(sent('continuous')).toHaveLength(4);
  });

  describe('the end clamp and a series the metadata does not list', () => {
    /** 07:00 on 2026-11-11 at the EST site 01646500. */
    const MORNING = new Date('2026-11-11T12:00:00Z');

    it('ends the range at today on the site’s clock, sending no window past it', async () => {
      vi.setSystemTime(MORNING);
      routes(empty);
      await obs.getSeries(
        { ...discharge, startDate: '2026-11-01', endDate: '2099-12-31' },
        request('getSeries'),
      );
      expect(times()).toEqual(['2026-11-01T04:00:00Z/2026-11-12T04:59:59Z']);
    });

    it('takes today from the site’s clock, not from UTC', async () => {
      // 22:00 on 2026-11-10 in Washington, already 2026-11-11 in UTC.
      vi.setSystemTime(new Date('2026-11-11T03:00:00Z'));
      routes(empty);
      await obs.getSeries(
        { ...discharge, startDate: '2026-11-10', endDate: '2026-11-11' },
        request('getSeries'),
      );
      expect(times()).toEqual(['2026-11-10T05:00:00Z/2026-11-11T04:59:59Z']);
    });

    it('sends no continuous request for a range wholly after today', async () => {
      vi.setSystemTime(MORNING);
      routes(empty);
      const series = await obs.getSeries(
        { ...discharge, startDate: '2026-12-01', endDate: '2026-12-31' },
        request('getSeries'),
      );
      expect(counts()).toEqual({
        'monitoring-locations': 1,
        'time-series-metadata': 1,
        'parameter-codes': 1,
      });
      expect(series.map((s) => [s.methodId, s.values.length])).toEqual([[DISCHARGE_SERIES, 0]]);
    });

    it('chunks a range up to today whose listed series state no first observation', async () => {
      vi.setSystemTime(MORNING);
      const undated = features('observations-tsm-readings-points.json')
        .filter(
          (f) =>
            f.properties['monitoring_location_id'] === 'USGS-01646500' &&
            f.properties['parameter_code'] === '00060',
        )
        .map((f) => ({ ...f, properties: { ...f.properties, begin: null } }));
      water.route(
        resolverRoute(),
        ogcRoute('time-series-metadata', () => jsonResponse(ogcPage(undated))),
        catalogRoute(),
        ogcRoute('continuous', empty),
      );
      await obs.getSeries(
        { ...discharge, startDate: '2024-01-01', endDate: '2026-12-31' },
        request('getSeries'),
      );
      expect(times()).toEqual([
        '2024-01-01T05:00:00Z/2025-01-01T04:59:59Z',
        '2025-01-01T05:00:00Z/2026-01-02T04:59:59Z',
        '2026-01-02T05:00:00Z/2026-11-12T04:59:59Z',
      ]);
    });

    it.each([
      [
        'a century ending today',
        '1900-01-01',
        '2026-11-11',
        '2025-11-11T05:00:00Z/2026-11-12T04:59:59Z',
      ],
      ['a far-future end', '1900-01-01', '2099-12-31', '2025-11-11T05:00:00Z/2026-11-12T04:59:59Z'],
      ['a past range', '1990-01-01', '1995-06-30', '1994-06-30T04:00:00Z/1995-07-01T03:59:59Z'],
    ])(
      'reads only the last 366 days of %s when the metadata lists no series, in one request',
      async (_label, startDate, endDate, window) => {
        vi.setSystemTime(MORNING);
        water.route(
          resolverRoute(),
          ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([]))),
          ogcRoute('continuous', () =>
            jsonResponse(ogcPage([row('2026-11-10T12:00:00+00:00', '7')])),
          ),
          catalogRoute(),
        );
        await obs.getSeries({ ...discharge, startDate, endDate }, request('getSeries'));
        expect(times()).toEqual([window]);
        expect(counts()).toEqual({
          'monitoring-locations': 1,
          'time-series-metadata': 1,
          continuous: 1,
          'parameter-codes': 1,
        });
      },
    );

    it('keeps the rows a series missing from the metadata reported in its last day', async () => {
      vi.setSystemTime(MORNING);
      water.route(
        resolverRoute(),
        ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([]))),
        ogcRoute('continuous', () =>
          jsonResponse(ogcPage([row('2026-11-11T11:45:00+00:00', '1890')])),
        ),
        catalogRoute(),
      );
      const series = await obs.getSeries(
        { ...discharge, startDate: '1900-01-01', endDate: '2026-11-11' },
        request('getSeries'),
      );
      expect(series.map((s) => [s.methodId, s.methodDescription, s.values])).toEqual([
        [
          DISCHARGE_SERIES,
          null,
          [{ dateTime: '2026-11-11T06:45:00.000-05:00', value: '1890', qualifiers: ['P'] }],
        ],
      ]);
    });
  });
});

/**
 * @fileoverview water_get_readings end to end over captured USGS Water Data responses: the tool
 * handler, the observations service, the site resolver, the parameter catalog, and the request
 * core all run for real; only `fetch` is faked. One capture, taken 2026-11-11 for eight sites
 * (99999999 has no location), answers every read: each route returns the captured features the
 * request's own filter selects, as the upstream does. Results are asserted on the assembled tool
 * result — structuredContent and content[] both.
 * @module tests/tools/water-get-readings.upstream.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allText } from '../helpers/content-block.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  type QueryMatch,
  rateLimitResponse,
  stalled,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type ReadingsTool =
  typeof import('@/mcp-server/tools/definitions/water-get-readings.tool.js')['waterGetReadings'];

type Value = { dateTime: string; qualifiers: string[]; value: string };
type Reading = {
  methodDescription: string | null;
  methodId: string | null;
  parameterCd: string;
  parameterName: string;
  siteName: string;
  siteNumber: string;
  totalValues: number;
  unitCode: string;
  values: Value[];
};
type Readings = {
  missingSites: string[];
  readings: Reading[];
  total: number;
  totalSeries: number;
  truncated: boolean;
};

type Feature = { id: string; properties: Record<string, unknown> };
type Collection = { features: Feature[]; links: { href: string; rel: string }[] };

const capture = (name: string) => JSON.parse(waterDataFixture(name)) as Collection;

/** The eight sites' locations, their 53 Points series, and the last two hours of their rows. */
const LOCATIONS = capture('observations-resolver-readings.json');
const POINTS = capture('observations-tsm-readings-points.json');
const CONTINUOUS = capture('observations-continuous-readings-PT2H.json');

/** Series IDs (OGC time_series_id) the assertions name. */
const POTOMAC_Q = '66a4e3fb8abe42fcb0942b5c0fe98f68';
const COWLITZ_Q_OLD = 'dcc1a8a32dc84a149b49c29bc18bd45a';
const COWLITZ_Q = '98fb5314c4bf4399a452fc3cbebe374a';
const BUBBLER = '08df7daae80b4586bb4324550ebca65e';

/** The values each property of a cql2-text `filter` must take: `a IN ('x','y') AND b IN ('z')`. */
function cqlInClauses(filter: string | null): Map<string, Set<string>> {
  const clauses = new Map<string, Set<string>>();
  for (const [, property = '', list = ''] of (filter ?? '').matchAll(/(\w+) IN \(([^)]*)\)/g)) {
    clauses.set(property, new Set(list.split(',').map((value) => value.slice(1, -1))));
  }
  return clauses;
}

/** The features of `body` every `IN` clause of `filter` admits. */
function admitted(body: Collection, filter: string | null): Feature[] {
  const clauses = [...cqlInClauses(filter)];
  return body.features.filter((f) =>
    clauses.every(([property, values]) => values.has(String(f.properties[property]))),
  );
}

/** `monitoring-locations` for a number list: the captured locations it names. */
const locationsRoute = () =>
  ogcRoute('monitoring-locations', (request) => {
    const asked = new Set(
      new URL(request.url).searchParams.get('monitoring_location_number')?.split(','),
    );
    return jsonResponse(
      ogcPage(
        LOCATIONS.features.filter((f) =>
          asked.has(String(f.properties['monitoring_location_number'])),
        ),
      ),
    );
  });

/** A collection answered from `body` under the request's cql2-text filter. */
const filteredRoute = (collection: string, body: Collection, query: QueryMatch) =>
  ogcRoute(
    collection,
    (request) =>
      jsonResponse(ogcPage(admitted(body, new URL(request.url).searchParams.get('filter')))),
    { query: { 'filter-lang': 'cql2-text', ...query } },
  );

const pointsRoute = () =>
  filteredRoute('time-series-metadata', POINTS, { computation_period_identifier: 'Points' });
const continuousRoute = () => filteredRoute('continuous', CONTINUOUS, { time: 'PT2H' });
const catalogRoute = () =>
  ogcRoute('parameter-codes', () =>
    jsonResponse(waterDataFixture('observations-parameter-codes.json')),
  );

/** Every route a successful call reads, in the order the service needs them. */
const upstream = () => [locationsRoute(), pointsRoute(), continuousRoute(), catalogRoute()];

/** The routes of a call whose `continuous` read answers with `respond` instead. */
const continuousAnswering = (respond: Parameters<typeof ogcRoute>[1]) => [
  locationsRoute(),
  pointsRoute(),
  catalogRoute(),
  ogcRoute('continuous', respond),
];

let tool: ReadingsTool;
let water: WaterDataFake;

/** A fresh module graph per test: empty site and catalog caches, an open rate-limit gate. */
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  ({ waterGetReadings: tool } = await import(
    '@/mcp-server/tools/definitions/water-get-readings.tool.js'
  ));
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

async function readings(input: Record<string, unknown>, signal?: AbortSignal) {
  const result = await runToolContract(
    tool,
    input as never,
    signal ? { context: { signal } } : undefined,
  );
  return {
    result,
    structured: result.structuredContent as Readings,
    text: allText(result.content),
  };
}

/** The collection of each request from index `from` on, sorted — parallel reads have no order. */
const collectionsSent = (from = 0) =>
  water.requests
    .slice(from)
    .map((r) => r.url.pathname.split('/').at(-2) ?? '')
    .sort();

const sentTo = (collection: string) =>
  water.requests.filter((r) => r.url.pathname.endsWith(`/collections/${collection}/items`));

/** Turn the fake clock until `condition` holds, without moving time. */
async function untilSent(condition: () => boolean) {
  for (let turn = 0; turn < 50 && !condition(); turn++) await vi.advanceTimersByTimeAsync(0);
  expect(condition()).toBe(true);
}

describe('the fake answers as the upstream filters', () => {
  it('derives the rows the upstream returned for a parameter_code IN filter', () => {
    const real = capture('observations-continuous-parameter-in.json');
    const self = real.links.find((link) => link.rel === 'self')?.href ?? '';
    const filter = new URL(self).searchParams.get('filter');
    expect(filter).toBe(
      "monitoring_location_id IN ('USGS-01646500') AND parameter_code IN ('00060','00065')",
    );
    const ids = (features: Feature[]) => features.map((f) => f.id).sort();
    expect(ids(admitted(CONTINUOUS, filter))).toEqual(ids(real.features));
  });
});

describe('water_get_readings over captured Water Data responses', () => {
  it('returns the latest 10 records of a series and counts the rest (characterization)', async () => {
    water.route(...upstream());
    const { result, structured, text } = await readings({
      sites: ['01646500'],
      parameterCd: ['00060'],
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      total: 1,
      totalSeries: 1,
      truncated: true,
      missingSites: [],
    });
    const [potomac] = structured.readings;
    expect(potomac).toMatchObject({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      parameterCd: '00060',
      parameterName: 'Discharge, cubic feet per second',
      unitCode: 'ft3/s',
      methodId: POTOMAC_Q,
      methodDescription: null,
      totalValues: 21,
    });
    expect(potomac?.values.map((v) => v.value)).toEqual([
      '1940',
      '1890',
      '1940',
      '1890',
      '1940',
      '1890',
      '1890',
      '1890',
      '1940',
      '1940',
    ]);
    expect(potomac?.values[0]?.dateTime).toBe('2026-11-11T04:05:00.000-05:00');
    expect(potomac?.values.at(-1)).toEqual({
      dateTime: '2026-11-11T04:50:00.000-05:00',
      value: '1940',
      qualifiers: ['P'],
    });

    expect(text).toContain(
      '### POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA (01646500) — Discharge, cubic feet per second | code: 00060 | unit: ft3/s',
    );
    expect(text).toContain(`Method: (no description) | method ID: ${POTOMAC_Q}`);
    expect(text).toContain('- 2026-11-11T04:50:00.000-05:00: **1940** ft3/s [P]');
    expect(text).toContain('*(showing the latest 10 of 21 records in this period)*');

    // The tool's inputs reach the wire as the service's filter and window.
    const [continuous] = sentTo('continuous');
    expect(continuous?.url.searchParams.get('filter')).toBe(
      "monitoring_location_id IN ('USGS-01646500') AND parameter_code IN ('00060')",
    );
    expect(continuous?.url.searchParams.get('time')).toBe('PT2H');
  });

  it('costs four requests cold and two once the site and catalog caches are warm', async () => {
    water.route(...upstream());
    const input = { sites: ['01646500'], parameterCd: ['00060'] };

    expect((await readings(input)).result.isError).toBeFalsy();
    expect(collectionsSent()).toEqual([
      'continuous',
      'monitoring-locations',
      'parameter-codes',
      'time-series-metadata',
    ]);

    const before = water.requests.length;
    expect((await readings(input)).result.isError).toBeFalsy();
    expect(collectionsSent(before)).toEqual(['continuous', 'time-series-metadata']);
  });

  it('names a requested site with no location in missingSites', async () => {
    water.route(...upstream());
    const { structured, text } = await readings({
      sites: ['01646500', '14233500', '99999999'],
      parameterCd: ['00060'],
    });

    expect(structured.missingSites).toEqual(['99999999']);
    expect(structured.readings.map((r) => [r.siteNumber, r.methodId, r.totalValues])).toEqual([
      ['01646500', POTOMAC_Q, 21],
      ['14233500', COWLITZ_Q_OLD, 0],
      ['14233500', COWLITZ_Q, 6],
    ]);
    expect(text).toContain(
      '**No series returned for:** 99999999 — check each with water_get_site_data_catalog: not_found means no such site, an empty series list means it never measured the parameter.',
    );
  });

  describe('one series per sensor (#43)', () => {
    it('returns an empty sibling series beside the one carrying values, counted in totalSeries', async () => {
      // 14233500 lists two discharge series; only the newer one reported in the window.
      water.route(...upstream());
      const { structured, text } = await readings({
        sites: ['14233500'],
        parameterCd: ['00060'],
      });

      expect(structured).toMatchObject({ total: 2, totalSeries: 2, truncated: false });
      expect(structured.readings).toMatchObject([
        { methodId: COWLITZ_Q_OLD, methodDescription: null, values: [], totalValues: 0 },
        { methodId: COWLITZ_Q, methodDescription: null, totalValues: 6 },
      ]);
      expect(structured.readings[1]?.values.map((v) => v.value)).toEqual([
        '2000',
        '2010',
        '2020',
        '2010',
        '2020',
        '2000',
      ]);
      expect(structured.readings[1]?.values.at(-1)?.dateTime).toBe('2026-11-11T01:30:00.000-08:00');

      expect(text.split('\n')[0]).toBe('**2 time series**');
      expect(text).toContain(
        `Method: (no description) | method ID: ${COWLITZ_Q_OLD}\n  *(0 records in this period)*`,
      );
      expect(text).toContain('- 2026-11-11T01:30:00.000-08:00: **2000** ft3/s [P]');
      expect(text).toContain('*(6 records in this period)*');
    });

    it('returns every sensor of one parameter, oldest series first, named on both surfaces', async () => {
      // 01646500 lists five water-temperature series; only the current sonde reported.
      water.route(...upstream());
      const { structured, text } = await readings({
        sites: ['01646500'],
        parameterCd: ['00010'],
      });

      expect(structured).toMatchObject({ total: 5, totalSeries: 5, truncated: true });
      expect(
        structured.readings.map((r) => [r.methodId, r.methodDescription, r.totalValues]),
      ).toEqual([
        ['52b33353ad684b76a8afd49cf017a42c', '4.1 ft from riverbed (middle), [Discontinued]', 0],
        ['c8e767f6cdfc4ff484a99f77962dc46c', '7.1 ft from riverbed (top), [Discontinued]', 0],
        ['f60be489a22b4dfd9fd0fb97f3acc285', '1.0 ft from riverbed (bottom), [Discontinued]', 0],
        ['089a50eca92a4e268b8816a1bc22c000', 'From multiparameter sonde, [Discontinued]', 0],
        ['d1875d1d73e447d2a1203105ba654e7d', 'From multiparameter sonde', 21],
      ]);
      expect(structured.readings[0]).toMatchObject({
        parameterName: 'Temperature, water, degrees Celsius',
        unitCode: 'deg C',
      });

      expect(text.split('\n')[0]).toBe(
        '**5 time series** *(truncated — each series shows its latest 10 records; use water_get_series for full history)*',
      );
      expect(text).toContain(
        'Method: 1.0 ft from riverbed (bottom), [Discontinued] | method ID: f60be489a22b4dfd9fd0fb97f3acc285',
      );
      expect(text).toContain(
        'Method: From multiparameter sonde | method ID: d1875d1d73e447d2a1203105ba654e7d',
      );
      expect(text).toContain('- 2026-11-11T04:50:00.000-05:00: **13.4** deg C [P]');
    });

    it('returns two sensors that both reported, each with its own label', async () => {
      water.route(...upstream());
      const { structured, text } = await readings({
        sites: ['09497830'],
        parameterCd: ['00065'],
      });

      expect(
        structured.readings.map((r) => [r.methodId, r.methodDescription, r.totalValues]),
      ).toEqual([
        ['948d8ed67c17408f9a91c30663ceae06', '[From WQ-Probe (Backup)]', 7],
        ['95a4b586933b4e4eb769fa2df55bda42', null, 7],
      ]);
      expect(structured.missingSites).toEqual([]);
      expect(text).toContain(
        'Method: [From WQ-Probe (Backup)] | method ID: 948d8ed67c17408f9a91c30663ceae06',
      );
      // An Arizona site keeps standard time all year.
      expect(text).toContain('- 2026-11-11T02:45:00.000-07:00: **3.33** ft [P,OTHERAGENCY]');
      expect(text).toContain('- 2026-11-11T02:45:00.000-07:00: **2.23** ft [P,OTHERAGENCY]');
    });

    it('returns every series of an eight-site batch, ordered by site number', async () => {
      water.route(...upstream());
      const sites = [
        '01646500',
        '364643089212301',
        '14233500',
        '09497830',
        '06819550',
        '08131400',
        '01115170',
        '11176400',
      ];
      const { structured, text } = await readings({ sites });

      expect(structured).toMatchObject({ total: 53, totalSeries: 53, missingSites: [] });
      expect([...new Set(structured.readings.map((r) => r.siteNumber))]).toEqual([
        '01115170',
        '01646500',
        '06819550',
        '08131400',
        '09497830',
        '11176400',
        '14233500',
        '364643089212301',
      ]);
      expect(structured.readings.filter((r) => r.totalValues === 0)).toHaveLength(14);
      // A non-USGS agency's well (MO005), on Central time.
      const well = structured.readings.find((r) => r.parameterCd === '72019');
      expect(well).toMatchObject({
        siteNumber: '364643089212301',
        siteName: 'East Prairie',
        parameterName: 'Depth to water level, feet below land surface',
        unitCode: 'ft',
        values: [
          { dateTime: '2026-11-11T02:30:00.000-06:00', value: '10.52', qualifiers: ['P'] },
          { dateTime: '2026-11-11T03:00:00.000-06:00', value: '10.52', qualifiers: ['P'] },
        ],
      });
      expect(text).toContain('### East Prairie (364643089212301) — Depth to water level');
    });
  });

  describe('records the upstream reported as no data (#45)', () => {
    it('renders a seasonal record as missing with its qualifier codes, never as a magnitude', async () => {
      water.route(...upstream());
      const { result, structured, text } = await readings({
        sites: ['01115170', '01646500'],
        parameterCd: ['72198', '00060'],
      });

      expect(result.isError).toBeFalsy();
      const snow = structured.readings.find((r) => r.parameterCd === '72198');
      expect(snow).toMatchObject({ siteNumber: '01115170', totalValues: 8, unitCode: 'ft' });
      expect(snow?.values.every((v) => v.value === '')).toBe(true);
      expect(snow?.values.at(-1)).toEqual({
        dateTime: '2026-11-11T04:20:00.000-05:00',
        value: '',
        qualifiers: ['P', '<', 'Ssn'],
      });

      expect(text).toContain('- 2026-11-11T04:20:00.000-05:00: no data [P,<,Ssn]');
      expect(text).not.toContain('null');
      // The measured series in the same batch render as before.
      expect(text).toContain('- 2026-11-11T04:20:00.000-05:00: **8.10** ft3/s [P]');
      expect(text).toContain('- 2026-11-11T04:50:00.000-05:00: **1940** ft3/s [P]');
    });

    it('lists every code of a multi-word qualifier, and a word with no code as written', async () => {
      water.route(...upstream());
      const { structured, text } = await readings({
        sites: ['06819550', '09497830'],
        parameterCd: ['00300', '00400'],
      });

      const last = (site: string, parameterCd: string) =>
        structured.readings
          .find((r) => r.siteNumber === site && r.parameterCd === parameterCd)
          ?.values.at(-1);
      expect(last('06819550', '00300')).toEqual({
        dateTime: '2026-11-11T03:15:00.000-06:00',
        value: '',
        qualifiers: ['P', 'Dis', 'Eqp'],
      });
      expect(last('09497830', '00300')).toEqual({
        dateTime: '2026-11-11T02:45:00.000-07:00',
        value: '9.8',
        qualifiers: ['P', 'OTHERAGENCY'],
      });
      expect(last('09497830', '00400')?.qualifiers).toEqual(['P', 'Eqp', 'OTHERAGENCY']);
      expect(text).toContain('- 2026-11-11T03:15:00.000-06:00: no data [P,Dis,Eqp]');
      expect(text).toContain('- 2026-11-11T02:45:00.000-07:00: **9.8** mg/l [P,OTHERAGENCY]');
    });
  });

  describe('dormant and nonexistent sites (#52)', () => {
    it('returns an all-dormant batch as a zero-value series, the nonexistent site in missingSites', async () => {
      // 09497830 lists a bubbler purge-pressure series that reported nothing in the window.
      water.route(...upstream());
      const { result, structured, text } = await readings({
        sites: ['09497830', '99999999'],
        parameterCd: ['72203'],
      });

      expect(result.isError).toBeFalsy();
      expect(structured).toEqual({
        readings: [
          {
            siteNumber: '09497830',
            siteName: 'CANYON CREEK ABOVE COW CREEK NEAR YOUNG, AZ',
            parameterCd: '72203',
            parameterName:
              'Absolute pressure from unvented pressure transducer, pounds per square inch',
            unitCode: 'psi',
            methodId: BUBBLER,
            methodDescription: '[Bubbler Purge Pressure]',
            values: [],
            totalValues: 0,
          },
        ],
        total: 1,
        totalSeries: 1,
        truncated: false,
        missingSites: ['99999999'],
        query: { sites: ['09497830', '99999999'], parameterCd: ['72203'], period: 'PT2H' },
      });

      expect(text.split('\n')[0]).toBe('**1 time series**');
      expect(text).toContain('**No series returned for:** 99999999');
      expect(text).toContain(
        '### CANYON CREEK ABOVE COW CREEK NEAR YOUNG, AZ (09497830) — Absolute pressure from unvented pressure transducer, pounds per square inch | code: 72203 | unit: psi',
      );
      expect(text).toContain(`Method: [Bubbler Purge Pressure] | method ID: ${BUBBLER}`);
      expect(text).toContain('*(0 records in this period)*');
    });

    it('fails no_data_for_parameter after one request when no requested site has a location', async () => {
      water.route(locationsRoute());
      const { result, text } = await readings({ sites: ['99999999'], parameterCd: ['00060'] });

      const recovery = declaredRecovery(tool.errors, 'no_data_for_parameter');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message:
            'No requested site returned an instantaneous series for parameterCd 00060 — each site either does not exist or has no such series.',
          data: { reason: 'no_data_for_parameter', recovery },
        },
      });
      expect(text).toContain(recovery.hint);
      expect(collectionsSent()).toEqual(['monitoring-locations']);
    });

    it('fails no_data_for_parameter when a real site never measured the parameter', async () => {
      water.route(...upstream());
      const { result } = await readings({ sites: ['01646500'], parameterCd: ['72203'] });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_data_for_parameter' } },
      });
      expect(water.requests).toHaveLength(4);
    });

    it('rejects a malformed site number before any request', async () => {
      const { result } = await readings({ sites: ['1646500'] });
      expect(result.isError).toBe(true);
      expect(water.requests).toHaveLength(0);
    });
  });

  describe('upstream failures', () => {
    it('surfaces a 429 as rate_limited with the upstream retryAfter, sending the read once', async () => {
      water.route(...continuousAnswering(() => rateLimitResponse(1800)));
      const { result, text } = await readings({ sites: ['01646500'], parameterCd: ['00060'] });

      const message =
        'USGS Water Data OGC API rate limit reached (OVER_RATE_LIMIT). The limit is 1000 requests per hour per IP address without an API key. Retry after 1800 s.';
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.RateLimited,
          message,
          data: { reason: 'rate_limited', retryAfter: 1800, rateLimitPerHour: 1000 },
        },
      });
      expect(text).toContain(message);
      expect(text).toContain('Wait the retryAfter interval before calling again.');
      expect(sentTo('continuous')).toHaveLength(1);
    });

    it('fails an unreadable 200 body at once as upstream_error with its recovery hint', async () => {
      const cut = waterDataFixture('observations-continuous-readings-PT2H.json').slice(0, 1_000);
      water.route(...continuousAnswering(() => jsonResponse(cut)));
      const { result, text } = await readings({ sites: ['01646500'], parameterCd: ['00060'] });

      const recovery = declaredRecovery(tool.errors, 'upstream_error');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'USGS Water Data OGC API sent a response that is not JSON (water_get_readings).',
          data: { reason: 'upstream_error', recovery },
        },
      });
      expect(text).toContain(recovery.hint);
      // A complete body that does not parse is never re-sent.
      expect(sentTo('continuous')).toHaveLength(1);
    });

    it('marks a deterministic upstream_error not retryable on both surfaces, over the contract default', async () => {
      const cut = waterDataFixture('observations-continuous-readings-PT2H.json').slice(0, 1_000);
      water.route(...continuousAnswering(() => jsonResponse(cut)));
      const { result, text } = await readings({ sites: ['01646500'], parameterCd: ['00060'] });

      const { data } = (result.structuredContent as { error: { data: { retryable?: boolean } } })
        .error;
      expect(data.retryable).toBe(false);
      expect(text).toContain('(reason upstream_error · not retryable)');
    });

    it('reports a period past 1,100 days as invalid_request with the upstream’s own description', async () => {
      // The `continuous` 400 body for a time envelope over its cap, as captured 2026-11-11.
      const envelopeTooLarge = {
        code: 'InvalidQuery',
        type: 'InvalidQuery',
        description:
          'The requested time envelope is too large, the query must be limited to 1100 day(s) or less for this collection.',
      };
      water.route(...continuousAnswering(() => jsonResponse(envelopeTooLarge, { status: 400 })));
      const { result, text } = await readings({
        sites: ['01646500'],
        parameterCd: ['00060'],
        period: 'P4Y',
      });

      const message =
        'USGS Water Data OGC API rejected the request: The requested time envelope is too large, the query must be limited to 1100 day(s) or less for this collection.';
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message,
          data: {
            reason: 'invalid_request',
            recovery: declaredRecovery(tool.errors, 'invalid_request'),
          },
        },
      });
      expect(text).toContain(message);
      expect(sentTo('continuous').map((r) => r.url.searchParams.get('time'))).toEqual(['P4Y']);
    });

    it('recovers when a retry after a 503 returns the body', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(
        ogcRoute('continuous', () => new Response('Unavailable', { status: 503 }), {
          once: true,
        }),
        ...upstream(),
      );
      const pending = readings({ sites: ['01646500'], parameterCd: ['00060'] });
      await vi.advanceTimersByTimeAsync(10_000);
      const { result, structured, text } = await pending;

      expect(result.isError).toBeFalsy();
      expect(structured.readings[0]).toMatchObject({ methodId: POTOMAC_Q, totalValues: 21 });
      expect(text).toContain('- 2026-11-11T04:50:00.000-05:00: **1940** ft3/s [P]');
      expect(sentTo('continuous')).toHaveLength(2);
    });

    it('fails as upstream_error after four attempts when every one is a 503', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(...continuousAnswering(() => new Response('Unavailable', { status: 503 })));
      const pending = readings({ sites: ['01646500'], parameterCd: ['00060'] });
      await vi.advanceTimersByTimeAsync(30_000);
      const { result, text } = await pending;

      const recovery = declaredRecovery(tool.errors, 'upstream_error');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_error', recovery, retryable: true },
        },
      });
      expect(text).toContain('USGS Water Data OGC API answered HTTP 503: Unavailable');
      expect(text).toContain(recovery.hint);
      expect(text).toContain('(reason upstream_error · retryable)');
      expect(sentTo('continuous')).toHaveLength(4);
    });

    it('stops at a caller cancellation during a retry backoff, reporting the caller’s reason', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(...continuousAnswering(() => new Response('Unavailable', { status: 503 })));
      const controller = new AbortController();
      const pending = readings({ sites: ['01646500'], parameterCd: ['00060'] }, controller.signal);
      await untilSent(() => water.requests.length === 4);
      controller.abort(new DOMException('Request cancelled by caller', 'AbortError'));
      const { result, text } = await pending;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Request cancelled by caller' },
      });
      expect(text).toContain('Request cancelled by caller');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sentTo('continuous')).toHaveLength(1);
    });

    it('stops at a caller cancellation while a read is in flight', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(...continuousAnswering(stalled));
      const controller = new AbortController();
      const pending = readings({ sites: ['01646500'], parameterCd: ['00060'] }, controller.signal);
      await untilSent(() => water.requests.length === 4);
      controller.abort(new DOMException('Request cancelled by caller', 'AbortError'));
      const { result, text } = await pending;

      const message = 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.';
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled, message },
      });
      expect(text).toContain(message);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(water.requests).toHaveLength(4);
    });
  });
});

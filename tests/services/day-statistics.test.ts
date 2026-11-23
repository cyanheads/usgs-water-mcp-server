/**
 * @fileoverview The day-statistics reader against captured USGS Water Data responses, run at the
 * fetch seam: the Water Data fake serves the site resolver, `time-series-metadata`, and the
 * Statistics API's `observationNormals` and monthly `observationIntervals`, answering each batched
 * read the way the live APIs do (by the locations and series it names), so resolution, request
 * shapes, chunking, response validation, attribution, series pairing, and the period-of-record
 * derivation all execute. Expected thresholds and periods of record are the values the
 * WaterServices stat service published for the same site-days (recorded in the port's validation
 * evidence), not this code's output. Monthly-interval fixtures are live captures trimmed to the
 * months the tests rank.
 * @module tests/services/day-statistics.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DayStatisticsQuery, SiteDailyMeans } from '@/services/waterdata/day-statistics.js';
import { startDeadline } from '@/services/waterdata/request-deadline.js';
import type { WaterDataRequest } from '@/services/waterdata/water-data-client.js';
import {
  cqlInValues,
  createWaterDataFake,
  dailyMeanCapture,
  jsonResponse,
  locationFilteredResponder,
  type OgcFeature,
  ogcRoute,
  rateLimitResponse,
  type StatisticsBody,
  stalled,
  statisticsBatchResponder,
  statisticsRoute,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type Reader = typeof import('@/services/waterdata/day-statistics.js');

/** Daily-mean series IDs and the instantaneous series each is computed from, from the fixtures. */
const SERIES = {
  potomacDischarge: {
    daily: '2cf409b0d9694c01828f5d4ff14586a5',
    source: '66a4e3fb8abe42fcb0942b5c0fe98f68',
  },
  potomacSonde: {
    daily: '40bfcf380ef240e18699ee4875350640',
    source: 'd1875d1d73e447d2a1203105ba654e7d',
  },
  pendOreilleBase: {
    daily: 'f3f93cac0e144cd8b3b7ee826f0fc2b7',
    source: 'dea67e89fcc54472ae9db8e097a637fb',
  },
  pendOreilleAux: {
    daily: '81f6f58adb784d90bca74a02877600b8',
    source: '1c9d1f64a6cd4093913ab88ec7c41991',
  },
  cowlitz: { daily: '06f3af03b3e24af6982de1c3ac16f299' },
  santiam: {
    daily: '008d4cefc8044e909c192446c13967bb',
    source: '87b0ff1705964369a86835896849c757',
  },
  howellWell: {
    daily: 'ef4df5f138444f23bc58729959c31f0b',
    source: '0081e4cc7cac4c79b12d49ead50aece2',
  },
} as const;

/** WaterServices' published values for the site-days the batch tests rank. */
const RANKED = {
  potomac1111: {
    status: 'available',
    matched: true,
    series: {
      id: SERIES.potomacDischarge.daily,
      description: null,
      percentiles: { p05: 1015.6, p10: 1599, p25: 2257.5, p50: 3600, p75: 7545, p95: 36210 },
      periodOfRecord: { firstWaterYear: 1931, lastWaterYear: 2026 },
    },
  },
  santiam1110: {
    status: 'available',
    matched: true,
    series: {
      id: SERIES.santiam.daily,
      description: null,
      percentiles: { p05: null, p10: null, p25: null, p50: 106, p75: null, p95: null },
      periodOfRecord: { firstWaterYear: 2026, lastWaterYear: 2026 },
    },
  },
  cowlitz1110: {
    status: 'available',
    matched: false,
    series: {
      id: SERIES.cowlitz.daily,
      description: null,
      percentiles: { p05: 681.2, p10: 1318, p25: 1750, p50: 3230, p75: 4647.5, p95: 13475 },
      periodOfRecord: { firstWaterYear: 1948, lastWaterYear: 2025 },
    },
  },
} as const;

const EMPTY_STATISTICS: StatisticsBody = { features: [] };
const STATISTICS_PATH = '/statistics/v0/';
const URL_LIMIT = 2_048;

let reader: Reader;
let water: WaterDataFake;

beforeEach(async () => {
  vi.resetModules(); // the resolver cache and the per-host cooldown gate start empty
  vi.stubEnv('USGS_API_KEY', undefined);
  reader = await import('@/services/waterdata/day-statistics.js');
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

function request(signal?: AbortSignal): WaterDataRequest {
  const ctx = createMockContext(signal ? { signal } : {});
  return { ctx, deadline: startDeadline(), operation: 'test', signal: ctx.signal };
}

/** A settled entry's value, or its failure thrown — how a one-site read reports it. */
function unwrap<T>(result: PromiseSettledResult<T> | undefined): T {
  if (!result) throw new Error('No result for the query.');
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** The resolver, answering for every site these tests use. */
const locationsRoute = () =>
  ogcRoute('monitoring-locations', () =>
    jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
  );

/**
 * Batched daily-mean metadata for `sites`, from their per-site captures of `parameterCd`,
 * answering only a read whose filter names that parameter.
 */
const dailyMeansRoute = (parameterCd: string, sites: readonly string[]) => {
  const respond = locationFilteredResponder(
    sites.flatMap((site) => dailyMeanCapture(site, parameterCd)),
  );
  return {
    ...ogcRoute('time-series-metadata', respond, {
      query: { computation_period_identifier: 'Daily', statistic_id: '00003' },
    }),
    match: (req: Request) => {
      const url = new URL(req.url);
      const filter = cqlInValues(url.searchParams.get('filter'));
      return (
        url.pathname === '/ogcapi/v1/collections/time-series-metadata/items' &&
        url.searchParams.get('computation_period_identifier') === 'Daily' &&
        filter.get('parameter_code')?.join() === parameterCd
      );
    },
  };
};

const normalsCapture = (site: string, parameterCd: string, monthDay: string) =>
  `statistics-normals-${site}-${parameterCd}-${monthDay.replace('-', '')}.json`;

const intervalsCapture = (site: string, parameterCd: string, seriesId: string) =>
  `statistics-intervals-${site}-${parameterCd}-${seriesId.slice(0, 8)}.json`;

/**
 * One calendar day's normals, answered for the locations each request names. A request naming no
 * location — an empty chunk, which the live API would answer as a parameter-wide read — matches no
 * route, so the fake fails the test.
 */
const normalsRoute = (monthDay: string, captures: readonly (string | StatisticsBody)[]) =>
  statisticsRoute('observationNormals', statisticsBatchResponder(captures), {
    query: { start_date: monthDay, end_date: monthDay, monitoring_location_id: true },
  });

/** Monthly intervals, answered for the series each request names; a request naming none fails. */
const intervalsRoute = (captures: readonly (string | StatisticsBody)[]) =>
  statisticsRoute('observationIntervals', statisticsBatchResponder(captures), {
    query: { parent_time_series_id: true },
  });

/** The site's daily-mean series, read as a one-site batch. */
async function dailyMeansOf(site: string, parameterCd: string, req: WaterDataRequest) {
  return unwrap((await reader.getDailyMeanSeries([site], parameterCd, req)).get(site));
}

/** Route a site-day's captures and read its statistics, alone, for a reading from `source`. */
async function statisticsFor(
  site: string,
  parameterCd: string,
  monthDay: string,
  source: string | null,
  intervals: readonly (string | StatisticsBody)[] = [],
) {
  water.route(
    locationsRoute(),
    dailyMeansRoute(parameterCd, [site]),
    normalsRoute(monthDay, [normalsCapture(site, parameterCd, monthDay)]),
    ...(intervals.length > 0 ? [intervalsRoute(intervals)] : []),
  );
  const req = request();
  const dailyMeans = await dailyMeansOf(site, parameterCd, req);
  const [result] = await reader.getDayStatistics(
    [{ site: dailyMeans, monthDay, sourceSeriesId: source }],
    req,
  );
  return unwrap(result);
}

const statisticsRequests = () =>
  water.requests.filter((r) => r.url.pathname.startsWith(STATISTICS_PATH));

const sentTo = (endpoint: 'observationIntervals' | 'observationNormals') =>
  water.requests.filter((r) => r.url.pathname === `${STATISTICS_PATH}${endpoint}`);

/** The values one request repeats under `key`. */
const repeated = (r: { url: URL }, key: string) => r.url.searchParams.getAll(key);

describe('getDailyMeanSeries', () => {
  it('lists the daily-mean series with the instantaneous series each is computed from', async () => {
    water.route(locationsRoute(), dailyMeansRoute('00065', ['12396500']));
    const site = await dailyMeansOf('12396500', '00065', request());

    expect(site).toEqual({
      monitoringLocationId: 'USGS-12396500',
      parameterCd: '00065',
      series: [
        {
          id: SERIES.pendOreilleAux.daily,
          sourceSeriesId: SERIES.pendOreilleAux.source,
          description: 'AUXILIARY GAGE, [AUXILIARY GAGE]',
        },
        {
          id: SERIES.pendOreilleBase.daily,
          sourceSeriesId: SERIES.pendOreilleBase.source,
          description: '[BASE GAGE]',
        },
      ],
    });
    const metadata = water.requests.find((r) =>
      r.url.pathname.endsWith('/time-series-metadata/items'),
    );
    expect(Object.fromEntries(metadata?.url.searchParams ?? [])).toEqual({
      'filter-lang': 'cql2-text',
      filter: "monitoring_location_id IN ('USGS-12396500') AND parameter_code IN ('00065')",
      computation_period_identifier: 'Daily',
      statistic_id: '00003',
      skipGeometry: 'true',
      properties:
        'monitoring_location_id,parent_time_series_id,sublocation_identifier,web_description',
      limit: '1000',
      f: 'json',
    });
  });

  it('composes descriptions as WaterServices wrote them, null when both parts are blank', async () => {
    water.route(locationsRoute(), dailyMeansRoute('00010', ['01646500']));
    const { series } = await dailyMeansOf('01646500', '00010', request());
    expect(series.map((s) => s.description)).toEqual([
      '7.1 ft from riverbed (top), [Discontinued]',
      'From multiparameter sonde',
      '4.1 ft from riverbed (middle), [Discontinued]',
      'From multiparameter sonde, [Discontinued]',
      '1.0 ft from riverbed (bottom), [Discontinued]',
    ]);

    water.route(dailyMeansRoute('00060', ['01646500']));
    const discharge = await dailyMeansOf('01646500', '00060', request());
    expect(discharge.series).toEqual([
      {
        id: SERIES.potomacDischarge.daily,
        sourceSeriesId: SERIES.potomacDischarge.source,
        description: null,
      },
    ]);
  });

  it("queries another agency's site under its own monitoring-location ID", async () => {
    water.route(
      ogcRoute('monitoring-locations', () =>
        jsonResponse(waterDataFixture('monitoring-locations-by-number.json')),
      ),
      ogcRoute('time-series-metadata', locationFilteredResponder([])),
    );
    const site = await dailyMeansOf('364643089212301', '72019', request());
    expect(site).toEqual({
      monitoringLocationId: 'MO005-364643089212301',
      parameterCd: '72019',
      series: [],
    });
    const [metadata] = water.requests.filter((r) =>
      r.url.pathname.endsWith('/time-series-metadata/items'),
    );
    expect(cqlInValues(metadata?.url.searchParams.get('filter') ?? null)).toEqual(
      new Map([
        ['monitoring_location_id', ['MO005-364643089212301']],
        ['parameter_code', ['72019']],
      ]),
    );
  });

  it('answers not_found for a number no location has, before any metadata request', async () => {
    water.route(locationsRoute());
    const sites = await reader.getDailyMeanSeries(['99999999'], '00060', request());
    const error = (() => {
      try {
        return unwrap(sites.get('99999999'));
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'not_found', siteNumber: '99999999' },
      message: 'No USGS monitoring location has site number 99999999.',
    });
    expect(water.requests.map((r) => r.url.pathname)).toEqual([
      '/ogcapi/v1/collections/monitoring-locations/items',
    ]);
  });

  it('reads every site in one resolver and one metadata request, attributing each row to its site', async () => {
    water.route(locationsRoute(), dailyMeansRoute('00060', ['01646500', '14174450', '14233500']));
    const sites = await reader.getDailyMeanSeries(
      ['14233500', '99999999', '01646500', '14233500', '14174450'],
      '00060',
      request(),
    );

    expect([...sites.keys()]).toEqual(['14233500', '99999999', '01646500', '14174450']);
    expect(unwrap(sites.get('01646500')).series.map((s) => s.id)).toEqual([
      SERIES.potomacDischarge.daily,
    ]);
    expect(unwrap(sites.get('14174450'))).toEqual({
      monitoringLocationId: 'USGS-14174450',
      parameterCd: '00060',
      series: [
        { id: SERIES.santiam.daily, sourceSeriesId: SERIES.santiam.source, description: null },
      ],
    });
    expect(unwrap(sites.get('14233500')).series.map((s) => s.id)).toEqual([SERIES.cowlitz.daily]);
    expect(sites.get('99999999')).toMatchObject({
      status: 'rejected',
      reason: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });

    expect(water.requests.map((r) => r.url.pathname)).toEqual([
      '/ogcapi/v1/collections/monitoring-locations/items',
      '/ogcapi/v1/collections/time-series-metadata/items',
    ]);
    const [, metadata] = water.requests;
    expect(
      cqlInValues(metadata?.url.searchParams.get('filter') ?? null).get('monitoring_location_id'),
    ).toEqual(['USGS-14233500', 'USGS-01646500', 'USGS-14174450']);
  });

  it('gives a found site with no daily-mean rows an empty series list', async () => {
    water.route(locationsRoute(), dailyMeansRoute('00060', ['01646500']));
    const sites = await reader.getDailyMeanSeries(['01646500', '14174450'], '00060', request());
    expect(unwrap(sites.get('14174450'))).toEqual({
      monitoringLocationId: 'USGS-14174450',
      parameterCd: '00060',
      series: [],
    });
  });

  it.each([
    [
      'a rejected request',
      () =>
        jsonResponse({ code: 'InvalidParameterValue', description: 'bad filter' }, { status: 400 }),
      { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_request' } },
    ],
    [
      'a rate limit',
      () => rateLimitResponse(3600),
      { code: JsonRpcErrorCode.RateLimited, data: { reason: 'rate_limited', retryAfter: 3600 } },
    ],
  ] as const)(
    'marks every found site with %s on the metadata read, keeping not_found',
    async (_case, respond, failure) => {
      water.route(locationsRoute(), ogcRoute('time-series-metadata', respond));
      const sites = await reader.getDailyMeanSeries(
        ['01646500', '99999999', '14174450'],
        '00060',
        request(),
      );
      expect(sites.get('01646500')).toMatchObject({ status: 'rejected', reason: failure });
      expect(sites.get('14174450')).toMatchObject({ status: 'rejected', reason: failure });
      expect(sites.get('99999999')).toMatchObject({
        status: 'rejected',
        reason: { data: { reason: 'not_found' } },
      });
      expect(water.requests).toHaveLength(2);
    },
  );

  it('marks every site with a failed resolution, sending no metadata request', async () => {
    water.route(
      ogcRoute('monitoring-locations', () =>
        jsonResponse({ code: 'InvalidParameterValue', description: 'bad number' }, { status: 400 }),
      ),
    );
    const sites = await reader.getDailyMeanSeries(['01646500', '14174450'], '00060', request());
    for (const site of ['01646500', '14174450']) {
      expect(sites.get(site)).toMatchObject({
        status: 'rejected',
        reason: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_request' } },
      });
    }
    expect(water.requests).toHaveLength(1);
  });

  it('rethrows the caller’s cancellation instead of settling it per site', async () => {
    water.route(locationsRoute(), ogcRoute('time-series-metadata', stalled));
    const controller = new AbortController();
    const pending = reader.getDailyMeanSeries(['01646500'], '00060', request(controller.signal));
    await vi.waitFor(() => expect(water.requests).toHaveLength(2));
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it('sends nothing for no sites', async () => {
    await expect(reader.getDailyMeanSeries([], '00060', request())).resolves.toEqual(new Map());
    expect(water.requests).toHaveLength(0);
  });
});

describe('getDayStatistics', () => {
  it("ranks a reading against its own sensor's daily mean, with WaterServices' period of record", async () => {
    const result = await statisticsFor(
      '01646500',
      '00060',
      '11-11',
      SERIES.potomacDischarge.source,
      [intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)],
    );

    // WaterServices ts 68478 for 11-11: 1020 1600 2260 3600 7540 36200 (3 significant figures), 1931–2026.
    expect(result).toEqual({
      status: 'available',
      matched: true,
      series: {
        id: SERIES.potomacDischarge.daily,
        description: null,
        percentiles: { p05: 1015.6, p10: 1599, p25: 2257.5, p50: 3600, p75: 7545, p95: 36210 },
        periodOfRecord: { firstWaterYear: 1931, lastWaterYear: 2026 },
      },
    });
    // One reading costs what it did alone: one normals and one intervals request.
    const [normals, intervals, ...rest] = statisticsRequests();
    expect(rest).toEqual([]);
    expect(Object.fromEntries(normals?.url.searchParams ?? [])).toEqual({
      parameter_code: '00060',
      normal_type: 'DOY',
      computation_type: 'percentile',
      start_date: '11-11',
      end_date: '11-11',
      monitoring_location_id: 'USGS-01646500',
    });
    expect(Object.fromEntries(intervals?.url.searchParams ?? [])).toEqual({
      parameter_code: '00060',
      interval_type: 'M',
      computation_type: 'arithmetic_mean',
      parent_time_series_id: SERIES.potomacDischarge.daily,
    });
  });

  it('counts February 29 only in leap years', async () => {
    const result = await statisticsFor(
      '01646500',
      '00060',
      '02-29',
      SERIES.potomacDischarge.source,
      [intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)],
    );
    // WaterServices: 1932–2024, n=24.
    expect(result).toMatchObject({
      status: 'available',
      series: { periodOfRecord: { firstWaterYear: 1932, lastWaterYear: 2024 } },
    });
  });

  it('keeps a gap year out of a short record (monthly, not water-year, intervals)', async () => {
    // The record began 2023-08 with November 2023 and 2024 unapproved; water-year intervals would
    // read 2024–2026. WaterServices: 2026–2026, only p50 published.
    const result = await statisticsFor('14174450', '00060', '11-10', SERIES.santiam.source, [
      intervalsCapture('14174450', '00060', SERIES.santiam.daily),
    ]);
    expect(result).toEqual({
      status: 'available',
      matched: true,
      series: {
        id: SERIES.santiam.daily,
        description: null,
        percentiles: { p05: null, p10: null, p25: null, p50: 106, p75: null, p95: null },
        periodOfRecord: { firstWaterYear: 2026, lastWaterYear: 2026 },
      },
    });
  });

  it("picks the reporting sensor's daily mean among fifteen daily series at one site", async () => {
    // Five sensors × daily max, min, and mean; the live sonde's daily maximum (7a3d8fd9) publishes
    // p25 11.225 for the day, its daily mean 10.05.
    const result = await statisticsFor('01646500', '00010', '11-11', SERIES.potomacSonde.source, [
      intervalsCapture('01646500', '00010', SERIES.potomacSonde.daily),
    ]);
    expect(result).toEqual({
      status: 'available',
      matched: true,
      series: {
        id: SERIES.potomacSonde.daily,
        description: 'From multiparameter sonde',
        percentiles: { p05: null, p10: null, p25: 10.05, p50: 12.15, p75: 14.925, p95: null },
        periodOfRecord: { firstWaterYear: 2020, lastWaterYear: 2026 },
      },
    });
  });

  it('keeps the water-level order of depth percentiles, from the daily mean only', async () => {
    // WaterServices (depth ascending): p05 127.04 … p95 144.43, 1989–2026. The API publishes the
    // mirror; its daily maximum (144.54) and minimum (144.384) series are not read.
    const result = await statisticsFor(
      '401105074120201',
      '72019',
      '11-10',
      SERIES.howellWell.source,
      [intervalsCapture('401105074120201', '72019', SERIES.howellWell.daily)],
    );
    expect(result).toMatchObject({
      status: 'available',
      series: {
        id: SERIES.howellWell.daily,
        percentiles: {
          p05: 144.428,
          p10: 141.877,
          p25: 138.285,
          p50: 135.295,
          p75: 132.132,
          p95: 127.045,
        },
        periodOfRecord: { firstWaterYear: 1989, lastWaterYear: 2026 },
      },
    });
  });

  it.each([
    ['base', SERIES.pendOreilleBase, '[BASE GAGE]', 1984],
    ['auxiliary', SERIES.pendOreilleAux, 'AUXILIARY GAGE, [AUXILIARY GAGE]', 1988],
  ] as const)(
    'pairs the %s gage with its own series by ID',
    async (_gage, ids, description, first) => {
      const result = await statisticsFor('12396500', '00065', '11-10', ids.source, [
        intervalsCapture('12396500', '00065', ids.daily),
      ]);
      expect(result).toMatchObject({
        status: 'available',
        matched: true,
        series: {
          id: ids.daily,
          description,
          periodOfRecord: { firstWaterYear: first, lastWaterYear: 2026 },
        },
      });
    },
  );

  it('names every candidate and ranks none when several series exist and none is the reading’s', async () => {
    const result = await statisticsFor(
      '12396500',
      '00065',
      '11-10',
      'ffffffffffffffffffffffffffffffff',
    );
    expect(result).toEqual({
      status: 'no_matching_method',
      candidates: [
        { id: SERIES.pendOreilleAux.daily, description: 'AUXILIARY GAGE, [AUXILIARY GAGE]' },
        { id: SERIES.pendOreilleBase.daily, description: '[BASE GAGE]' },
      ],
    });
    expect(statisticsRequests()).toHaveLength(1);
  });

  it("ranks unmatched against the site's only series, reading that series' record", async () => {
    // WaterServices: 1948–2025 for ts 150441, the only stat series at the site.
    const result = await statisticsFor('14233500', '00060', '11-10', null, [
      intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
    ]);
    expect(result).toEqual({
      status: 'available',
      matched: false,
      series: {
        id: SERIES.cowlitz.daily,
        description: null,
        percentiles: { p05: 681.2, p10: 1318, p25: 1750, p50: 3230, p75: 4647.5, p95: 13475 },
        periodOfRecord: { firstWaterYear: 1948, lastWaterYear: 2025 },
      },
    });
    expect(statisticsRequests().map((r) => r.url.pathname)).toEqual([
      '/statistics/v0/observationNormals',
      '/statistics/v0/observationIntervals',
    ]);
  });

  it('reports no_record when the only normals are of daily maxima, sending no intervals request', async () => {
    const result = await statisticsFor('261620081464402', '62610', '11-10', 'a'.repeat(32));
    expect(result).toEqual({ status: 'no_record' });
    expect(statisticsRequests()).toHaveLength(1);
  });

  it("reports no_matching_day when the reading's series has a record but no percentiles that day", async () => {
    water.route(
      locationsRoute(),
      dailyMeansRoute('00060', ['01646500']),
      normalsRoute('06-28', [EMPTY_STATISTICS]),
      intervalsRoute([intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)]),
    );
    const req = request();
    const site = await dailyMeansOf('01646500', '00060', req);
    const [result] = await reader.getDayStatistics(
      [{ site, monthDay: '06-28', sourceSeriesId: SERIES.potomacDischarge.source }],
      req,
    );
    expect(unwrap(result)).toEqual({ status: 'no_matching_day' });
  });

  it('reports no_record when neither the day nor the reading’s series has statistics', async () => {
    water.route(
      locationsRoute(),
      dailyMeansRoute('00060', ['01646500']),
      normalsRoute('06-28', [EMPTY_STATISTICS]),
      intervalsRoute([EMPTY_STATISTICS]),
    );
    const req = request();
    const site = await dailyMeansOf('01646500', '00060', req);
    const [result] = await reader.getDayStatistics(
      [{ site, monthDay: '06-28', sourceSeriesId: SERIES.potomacDischarge.source }],
      req,
    );
    expect(unwrap(result)).toEqual({ status: 'no_record' });
  });

  it('fails as upstream_error when percentiles name a day no approved month holds', async () => {
    const febOnly = JSON.parse(
      waterDataFixture('statistics-intervals-01646500-00060-2cf409b0.json'),
    ) as { features: { properties: { data: { values: { start_date: string }[] }[] } }[] };
    for (const series of febOnly.features[0]?.properties.data ?? []) {
      series.values = series.values.filter((v) => v.start_date.slice(5, 7) === '02');
    }
    const error = await statisticsFor(
      '01646500',
      '00060',
      '11-11',
      SERIES.potomacDischarge.source,
      [febOnly as unknown as StatisticsBody],
    ).catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', retryable: false },
      message: expect.stringContaining('no approved month that holds 11-11'),
    });
  });

  describe('a normals body it cannot read fails once, as upstream_error', () => {
    const normals = (values: string[]): StatisticsBody => {
      const body = {
        type: 'FeatureCollection',
        next: null,
        features: [
          {
            type: 'Feature',
            properties: {
              monitoring_location_id: 'USGS-01646500',
              data: [
                {
                  parent_time_series_id: SERIES.potomacDischarge.daily,
                  parent_statistic_id: '00003',
                  values: [
                    {
                      time_of_year: '11-11',
                      computation: 'percentile',
                      sample_count: 96,
                      percentiles: ['5', '10', '25', '50', '75', '90', '95'],
                      values,
                    },
                  ],
                },
              ],
            },
          },
        ],
      };
      return body;
    };

    it.each([
      ['one value short', ['1', '2', '3', '4', '5', '6']],
      ['a value that is not a number', ['1', '2', 'abc', '4', '5', '6', '7']],
      ['an empty value, never read as 0', ['', '2', '3', '4', '5', '6', '7']],
    ])('%s', async (_case, values) => {
      water.route(
        locationsRoute(),
        dailyMeansRoute('00060', ['01646500']),
        normalsRoute('11-11', [normals(values)]),
        intervalsRoute([intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)]),
      );
      const req = request();
      const site = await dailyMeansOf('01646500', '00060', req);
      const [result] = await reader.getDayStatistics(
        [{ site, monthDay: '11-11', sourceSeriesId: SERIES.potomacDischarge.source }],
        req,
      );
      const error = (() => {
        try {
          return unwrap(result);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryable: false },
        message: expect.stringContaining(
          'USGS Water Data Statistics API sent an unexpected response',
        ),
      });
      expect(sentTo('observationNormals')).toHaveLength(1);
    });

    it('reads "nan" as an unpublished threshold and a negative value as written', async () => {
      water.route(
        locationsRoute(),
        dailyMeansRoute('00060', ['01646500']),
        normalsRoute('11-11', [normals(['nan', '-0.002', '3', '4', '5', '6', 'nan'])]),
        intervalsRoute([intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)]),
      );
      const req = request();
      const site = await dailyMeansOf('01646500', '00060', req);
      const [result] = await reader.getDayStatistics(
        [{ site, monthDay: '11-11', sourceSeriesId: SERIES.potomacDischarge.source }],
        req,
      );
      expect(unwrap(result)).toMatchObject({
        series: { percentiles: { p05: null, p10: -0.002, p25: 3, p50: 4, p75: 5, p95: null } },
      });
    });
  });
});

/** A site and the daily-mean series its capture lists, without resolving it. */
function dailyMeansFrom(site: string, parameterCd: string): SiteDailyMeans {
  return {
    monitoringLocationId: `USGS-${site}`,
    parameterCd,
    series: dailyMeanCapture(site, parameterCd).map(({ id, properties: p }) => ({
      id: String(id),
      sourceSeriesId: (p.parent_time_series_id as string | null) ?? null,
      description: null,
    })),
  };
}

const POTOMAC_1111: DayStatisticsQuery = {
  site: dailyMeansFrom('01646500', '00060'),
  monthDay: '11-11',
  sourceSeriesId: SERIES.potomacDischarge.source,
};
const SANTIAM_1110: DayStatisticsQuery = {
  site: dailyMeansFrom('14174450', '00060'),
  monthDay: '11-10',
  sourceSeriesId: SERIES.santiam.source,
};
const COWLITZ_1110: DayStatisticsQuery = {
  site: dailyMeansFrom('14233500', '00060'),
  monthDay: '11-10',
  sourceSeriesId: null,
};

/** The three sites' normals for their days and their series' monthly intervals. */
function threeSiteRoutes(overrides: { intervals?: Parameters<typeof statisticsRoute>[1] } = {}) {
  water.route(
    normalsRoute('11-11', [normalsCapture('01646500', '00060', '11-11')]),
    normalsRoute('11-10', [
      normalsCapture('14174450', '00060', '11-10'),
      normalsCapture('14233500', '00060', '11-10'),
    ]),
    statisticsRoute(
      'observationIntervals',
      overrides.intervals ??
        statisticsBatchResponder([
          intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily),
          intervalsCapture('14174450', '00060', SERIES.santiam.daily),
          intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
        ]),
      { query: { parent_time_series_id: true } },
    ),
  );
}

/** Answers with `respond` once `ms` of (faked) time has passed. */
const heldFor = (ms: number, respond: (req: Request) => Response) => (req: Request) =>
  new Promise<Response>((resolve) => setTimeout(() => resolve(respond(req)), ms));

/** The Statistics API's answer to a URL over its length limit, as captured (CRLF line ends). */
const forbidden = () =>
  new Response(
    '<html>\r\n<head><title>403 Forbidden</title></head>\r\n<body>\r\n<center><h1>403 Forbidden</h1></center>\r\n</body>\r\n</html>\r\n',
    { status: 403, headers: { 'content-type': 'text/html' } },
  );

const UPSTREAM_403 = {
  code: JsonRpcErrorCode.ServiceUnavailable,
  message: 'USGS Water Data Statistics API answered HTTP 403.',
  data: { reason: 'upstream_error', retryable: false, upstreamStatus: 403 },
};

describe('getDayStatistics across many readings', () => {
  it('ranks readings on two calendar days against their own day, one normals read per day', async () => {
    threeSiteRoutes();
    const results = await reader.getDayStatistics(
      [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
      request(),
    );

    expect(results.map(unwrap)).toEqual([
      RANKED.potomac1111,
      RANKED.santiam1110,
      RANKED.cowlitz1110,
    ]);
    const normals = sentTo('observationNormals');
    expect(
      normals.map((r) => [
        r.url.searchParams.get('start_date'),
        repeated(r, 'monitoring_location_id'),
      ]),
    ).toEqual([
      ['11-11', ['USGS-01646500']],
      ['11-10', ['USGS-14174450', 'USGS-14233500']],
    ]);
    // Own series in one request; the unmatched site's only series after the normals named it.
    expect(sentTo('observationIntervals').map((r) => repeated(r, 'parent_time_series_id'))).toEqual(
      [[SERIES.potomacDischarge.daily, SERIES.santiam.daily], [SERIES.cowlitz.daily]],
    );
    expect(statisticsRequests()).toHaveLength(4);
  });

  it('ranks one site’s readings on two days against each day, reading its record once', async () => {
    water.route(
      normalsRoute('11-11', [normalsCapture('01646500', '00060', '11-11')]),
      normalsRoute('02-29', [normalsCapture('01646500', '00060', '02-29')]),
      intervalsRoute([intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)]),
    );
    const results = await reader.getDayStatistics(
      [POTOMAC_1111, { ...POTOMAC_1111, monthDay: '02-29' }],
      request(),
    );
    expect(results.map(unwrap)).toEqual([
      RANKED.potomac1111,
      {
        ...RANKED.potomac1111,
        series: {
          ...RANKED.potomac1111.series,
          // The 02-29 normals as captured; WaterServices: 1932–2024.
          percentiles: { p05: 3967.5, p10: 6145, p25: 9655, p50: 14000, p75: 29500, p95: 102750 },
          periodOfRecord: { firstWaterYear: 1932, lastWaterYear: 2024 },
        },
      },
    ]);
    expect(sentTo('observationNormals')).toHaveLength(2);
    expect(sentTo('observationIntervals').map((r) => repeated(r, 'parent_time_series_id'))).toEqual(
      [[SERIES.potomacDischarge.daily]],
    );
  });

  it('reads a repeated reading once and answers each copy', async () => {
    threeSiteRoutes();
    const results = await reader.getDayStatistics([POTOMAC_1111, POTOMAC_1111], request());
    expect(results.map(unwrap)).toEqual([RANKED.potomac1111, RANKED.potomac1111]);
    expect(
      statisticsRequests().map((r) => r.url.search.match(/USGS-|parent_time_series_id/g)),
    ).toEqual([['USGS-'], ['parent_time_series_id']]);
  });

  it('sends nothing for no readings', async () => {
    await expect(reader.getDayStatistics([], request())).resolves.toEqual([]);
    expect(water.requests).toHaveLength(0);
  });

  it('attributes normals across pages of one batched read', async () => {
    const [santiam, cowlitz] = ['14174450', '14233500'].map(
      (site) =>
        JSON.parse(waterDataFixture(normalsCapture(site, '00060', '11-10'))) as StatisticsBody,
    );
    water.route(
      statisticsRoute(
        'observationNormals',
        () =>
          jsonResponse({ type: 'FeatureCollection', features: santiam?.features, next: 'page-2' }),
        { query: { next_token: null } },
      ),
      statisticsRoute(
        'observationNormals',
        () => jsonResponse({ type: 'FeatureCollection', features: cowlitz?.features, next: null }),
        { query: { next_token: 'page-2' } },
      ),
      intervalsRoute([
        intervalsCapture('14174450', '00060', SERIES.santiam.daily),
        intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
      ]),
    );
    const results = await reader.getDayStatistics([SANTIAM_1110, COWLITZ_1110], request());
    expect(results.map(unwrap)).toEqual([RANKED.santiam1110, RANKED.cowlitz1110]);
    const [first, second] = sentTo('observationNormals');
    expect(repeated(first!, 'monitoring_location_id')).toEqual(
      repeated(second!, 'monitoring_location_id'),
    );
    expect(second?.url.searchParams.get('next_token')).toBe('page-2');
  });

  it('joins one series’ months split across intervals pages into one period of record', async () => {
    const body = JSON.parse(
      waterDataFixture(intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)),
    ) as {
      features: [{ properties: { data: [{ values: { start_date: string }[] }] } }];
    };
    const [feature] = body.features;
    const [series] = feature.properties.data;
    const page = (keep: (startDate: string) => boolean, next: string | null) => ({
      type: 'FeatureCollection',
      next,
      features: [
        {
          ...feature,
          properties: {
            ...feature.properties,
            data: [{ ...series, values: series.values.filter((v) => keep(v.start_date)) }],
          },
        },
      ],
    });
    water.route(
      normalsRoute('11-11', [normalsCapture('01646500', '00060', '11-11')]),
      statisticsRoute(
        'observationIntervals',
        () => jsonResponse(page((date) => date < '1980', 'page-2')),
        { query: { parent_time_series_id: SERIES.potomacDischarge.daily, next_token: null } },
      ),
      statisticsRoute(
        'observationIntervals',
        () => jsonResponse(page((date) => date >= '1980', null)),
        { query: { parent_time_series_id: SERIES.potomacDischarge.daily, next_token: 'page-2' } },
      ),
    );
    const [result] = await reader.getDayStatistics([POTOMAC_1111], request());
    // 1931 comes from the first page's Novembers, 2026 from the second's.
    expect(unwrap(result)).toEqual(RANKED.potomac1111);
    expect(sentTo('observationIntervals').map((r) => r.url.searchParams.get('next_token'))).toEqual(
      [null, 'page-2'],
    );
  });

  it('keeps every series of one location whose normals arrive across pages', async () => {
    const body = JSON.parse(waterDataFixture(normalsCapture('12396500', '00065', '11-10'))) as {
      features: [{ properties: { data: { parent_time_series_id: string }[] } }];
    };
    const [feature] = body.features;
    // The auxiliary gage's series on the first page, the base gage's on the second, one location.
    const page = (id: string, next: string | null) => ({
      type: 'FeatureCollection',
      next,
      features: [
        {
          ...feature,
          properties: {
            ...feature.properties,
            data: feature.properties.data.filter((s) => s.parent_time_series_id === id),
          },
        },
      ],
    });
    const query = { start_date: '11-10', monitoring_location_id: 'USGS-12396500' };
    water.route(
      statisticsRoute(
        'observationNormals',
        () => jsonResponse(page(SERIES.pendOreilleAux.daily, 'page-2')),
        { query: { ...query, next_token: null } },
      ),
      statisticsRoute(
        'observationNormals',
        () => jsonResponse(page(SERIES.pendOreilleBase.daily, null)),
        { query: { ...query, next_token: 'page-2' } },
      ),
      intervalsRoute([
        intervalsCapture('12396500', '00065', SERIES.pendOreilleAux.daily),
        intervalsCapture('12396500', '00065', SERIES.pendOreilleBase.daily),
      ]),
    );
    const site = dailyMeansFrom('12396500', '00065');
    const results = await reader.getDayStatistics(
      [SERIES.pendOreilleAux, SERIES.pendOreilleBase].map(({ source }) => ({
        site,
        monthDay: '11-10',
        sourceSeriesId: source,
      })),
      request(),
    );
    expect(results.map(unwrap)).toMatchObject([
      {
        status: 'available',
        matched: true,
        series: {
          id: SERIES.pendOreilleAux.daily,
          periodOfRecord: { firstWaterYear: 1988, lastWaterYear: 2026 },
        },
      },
      {
        status: 'available',
        matched: true,
        series: {
          id: SERIES.pendOreilleBase.daily,
          periodOfRecord: { firstWaterYear: 1984, lastWaterYear: 2026 },
        },
      },
    ]);
    expect(sentTo('observationNormals')).toHaveLength(2);
  });

  describe('request size', () => {
    /** 100 fifteen-digit well numbers, the longest site numbers USGS issues. */
    const WELLS = Array.from({ length: 100 }, (_, i) => String(100_000_000_000_000 + i * 7919));
    const series = (i: number) => i.toString(16).padStart(32, 'a');
    const wells = (withOwnSeries: boolean): DayStatisticsQuery[] =>
      WELLS.map((number, i) => ({
        site: {
          monitoringLocationId: `USGS-${number}`,
          parameterCd: '72019',
          series: withOwnSeries
            ? [{ id: series(i), sourceSeriesId: `s${i}`, description: null }]
            : [],
        },
        monthDay: '11-23',
        sourceSeriesId: withOwnSeries ? `s${i}` : null,
      }));

    it('keeps every normals URL under 2,048 characters for 100 fifteen-digit well numbers', async () => {
      water.route(normalsRoute('11-23', [EMPTY_STATISTICS]));
      const results = await reader.getDayStatistics(wells(false), request());

      expect(results.map(unwrap)).toEqual(WELLS.map(() => ({ status: 'no_record' })));
      const normals = sentTo('observationNormals');
      for (const r of normals) expect(r.url.href.length).toBeLessThan(URL_LIMIT);
      // Two requests cannot hold 100 such IDs under the limit (50 × 44 characters alone exceed it).
      expect(normals).toHaveLength(3);
      // Balanced by count, the extra key going to the first request — not 34, 34, 32.
      expect(normals.map((r) => repeated(r, 'monitoring_location_id').length)).toEqual([
        34, 33, 33,
      ]);
      expect(normals.flatMap((r) => repeated(r, 'monitoring_location_id'))).toEqual(
        WELLS.map((number) => `USGS-${number}`),
      );
    });

    it('splits a normals read into two once one request would reach into the next page’s token room', async () => {
      /**
       * 39 fifteen-digit wells and 4 eight-digit gages: one request naming all 43 would be 2,024
       * characters — under 2,048, but inside the 64 characters kept for a later page's next_token.
       */
      const numbers = [...WELLS.slice(0, 39), '01638500', '01644000', '01645000', '01646500'];
      const queries = numbers.map((number) => ({
        site: { monitoringLocationId: `USGS-${number}`, parameterCd: '72019', series: [] },
        monthDay: '11-23',
        sourceSeriesId: null,
      }));
      // Each request's first page names a next page, as a long live read does.
      const token = '0123456789abcdefghijkl'; // observed tokens run 22 characters
      water.route(
        statisticsRoute(
          'observationNormals',
          (req) => {
            const params = new URL(req.url).searchParams;
            if (params.has('next_token'))
              return jsonResponse({ type: 'FeatureCollection', features: [], next: null });
            const [first] = params.getAll('monitoring_location_id');
            const feature = { properties: { monitoring_location_id: first, data: [] } };
            return jsonResponse({ type: 'FeatureCollection', features: [feature], next: token });
          },
          { query: { monitoring_location_id: true } },
        ),
      );
      const results = await reader.getDayStatistics(queries, request());

      expect(results.map(unwrap)).toEqual(numbers.map(() => ({ status: 'no_record' })));
      const pages = sentTo('observationNormals');
      const firsts = pages.filter((r) => !r.url.searchParams.has('next_token'));
      const seconds = pages.filter((r) => r.url.searchParams.has('next_token'));
      const one = new URL(firsts[0]!.url);
      one.searchParams.delete('monitoring_location_id');
      for (const number of numbers)
        one.searchParams.append('monitoring_location_id', `USGS-${number}`);
      expect(one.href.length).toBe(2_024);

      for (const r of seconds) expect(r.url.href.length).toBeLessThan(URL_LIMIT);
      for (const r of firsts) expect(r.url.href.length).toBeLessThanOrEqual(URL_LIMIT - 1 - 64);
      expect(seconds.map((r) => r.url.searchParams.get('next_token'))).toEqual([token, token]);
      expect(firsts.map((r) => repeated(r, 'monitoring_location_id').length)).toEqual([22, 21]);
      expect(firsts.flatMap((r) => repeated(r, 'monitoring_location_id'))).toEqual(
        numbers.map((number) => `USGS-${number}`),
      );
    });

    it('keeps at most 4 Statistics requests of one stage in flight, sending the next as one answers', async () => {
      let open = false;
      const waiting: (() => void)[] = [];
      water.route(
        statisticsRoute(
          'observationNormals',
          () => {
            if (open) return jsonResponse(EMPTY_STATISTICS);
            const { promise, resolve } = Promise.withResolvers<Response>();
            waiting.push(() => resolve(jsonResponse(EMPTY_STATISTICS)));
            return promise;
          },
          { query: { monitoring_location_id: true } },
        ),
      );
      // Six calendar days: six normals requests in one stage, none waiting on another's answer.
      const days = ['11-18', '11-19', '11-20', '11-21', '11-22', '11-23'];
      const pending = reader.getDayStatistics(
        days.map((monthDay) => ({ ...COWLITZ_1110, monthDay })),
        request(),
      );

      await vi.waitFor(() => expect(sentTo('observationNormals').length).toBeGreaterThan(3));
      expect(sentTo('observationNormals')).toHaveLength(4);
      waiting.shift()?.();
      await vi.waitFor(() => expect(sentTo('observationNormals')).toHaveLength(5));
      expect(waiting).toHaveLength(4);

      open = true;
      for (const release of waiting.splice(0)) release();
      expect((await pending).map(unwrap)).toEqual(days.map(() => ({ status: 'no_record' })));
      expect(sentTo('observationNormals').map((r) => r.url.searchParams.get('start_date'))).toEqual(
        days,
      );
    });

    it('names at most 25 series per intervals request, every URL under 2,048 characters', async () => {
      water.route(normalsRoute('11-23', [EMPTY_STATISTICS]), intervalsRoute([EMPTY_STATISTICS]));
      const results = await reader.getDayStatistics(wells(true), request());

      expect(results.map(unwrap)).toEqual(WELLS.map(() => ({ status: 'no_record' })));
      const intervals = sentTo('observationIntervals');
      expect(intervals.map((r) => repeated(r, 'parent_time_series_id').length)).toEqual([
        25, 25, 25, 25,
      ]);
      for (const r of intervals) expect(r.url.href.length).toBeLessThan(URL_LIMIT);
      expect(intervals.flatMap((r) => repeated(r, 'parent_time_series_id'))).toEqual(
        WELLS.map((_, i) => series(i)),
      );
      // The intervals read names the series alone; the location adds nothing to its answer.
      for (const r of intervals)
        expect(r.url.searchParams.has('monitoring_location_id')).toBe(false);
    });

    it('splits 26 series into two even requests, not 25 and 1', async () => {
      water.route(normalsRoute('11-23', [EMPTY_STATISTICS]), intervalsRoute([EMPTY_STATISTICS]));
      await reader.getDayStatistics(wells(true).slice(0, 26), request());
      expect(
        sentTo('observationIntervals').map((r) => repeated(r, 'parent_time_series_id').length),
      ).toEqual([13, 13]);
    });

    it.each([
      [27, [14, 13]],
      // Balanced by count, never 20, 20, 20, 17.
      [77, [20, 19, 19, 19]],
    ])('splits %i series into requests of %j, the larger first', async (count, sizes) => {
      water.route(normalsRoute('11-23', [EMPTY_STATISTICS]), intervalsRoute([EMPTY_STATISTICS]));
      await reader.getDayStatistics(wells(true).slice(0, count), request());
      const intervals = sentTo('observationIntervals');
      expect(intervals.map((r) => repeated(r, 'parent_time_series_id').length)).toEqual(sizes);
      expect(intervals.flatMap((r) => repeated(r, 'parent_time_series_id'))).toEqual(
        WELLS.slice(0, count).map((_, i) => series(i)),
      );
    });
  });

  describe('a failed read leaves only the readings it covered without statistics', () => {
    it('a failed normals read fails its day’s readings, not the other day’s', async () => {
      water.route(
        normalsRoute('11-11', [normalsCapture('01646500', '00060', '11-11')]),
        statisticsRoute('observationNormals', forbidden, { query: { start_date: '11-10' } }),
        intervalsRoute([
          intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily),
          intervalsCapture('14174450', '00060', SERIES.santiam.daily),
        ]),
      );
      const [potomac, santiam, cowlitz] = await reader.getDayStatistics(
        [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
        request(),
      );
      expect(unwrap(potomac)).toEqual(RANKED.potomac1111);
      expect(santiam).toMatchObject({ status: 'rejected', reason: UPSTREAM_403 });
      expect(cowlitz).toMatchObject({ status: 'rejected', reason: UPSTREAM_403 });
      // The unmatched reading never learned its only series, so no fallback read is sent.
      expect(sentTo('observationIntervals')).toHaveLength(1);
    });

    it('a failed own-series intervals read fails the readings it named, not the fallback reading', async () => {
      const served = statisticsBatchResponder([
        intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
      ]);
      threeSiteRoutes({
        intervals: (req) =>
          new URL(req.url).searchParams
            .getAll('parent_time_series_id')
            .includes(SERIES.cowlitz.daily)
            ? served(req)
            : forbidden(),
      });
      const [potomac, santiam, cowlitz] = await reader.getDayStatistics(
        [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
        request(),
      );
      expect(potomac).toMatchObject({ status: 'rejected', reason: UPSTREAM_403 });
      expect(santiam).toMatchObject({ status: 'rejected', reason: UPSTREAM_403 });
      expect(unwrap(cowlitz)).toEqual(RANKED.cowlitz1110);
    });

    it('a failed fallback read fails only the unmatched reading', async () => {
      const served = statisticsBatchResponder([
        intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily),
        intervalsCapture('14174450', '00060', SERIES.santiam.daily),
      ]);
      threeSiteRoutes({
        intervals: (req) =>
          new URL(req.url).searchParams
            .getAll('parent_time_series_id')
            .includes(SERIES.cowlitz.daily)
            ? forbidden()
            : served(req),
      });
      const [potomac, santiam, cowlitz] = await reader.getDayStatistics(
        [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
        request(),
      );
      expect(unwrap(potomac)).toEqual(RANKED.potomac1111);
      expect(unwrap(santiam)).toEqual(RANKED.santiam1110);
      expect(cowlitz).toMatchObject({ status: 'rejected', reason: UPSTREAM_403 });
    });

    it('a record that contradicts its percentiles fails that reading, not its chunk’s others', async () => {
      const potomac = JSON.parse(
        waterDataFixture(intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily)),
      ) as { features: { properties: { data: { values: { start_date: string }[] }[] } }[] };
      for (const s of potomac.features[0]?.properties.data ?? []) {
        s.values = s.values.filter((v) => v.start_date.slice(5, 7) === '02');
      }
      threeSiteRoutes({
        intervals: statisticsBatchResponder([
          potomac as unknown as StatisticsBody,
          intervalsCapture('14174450', '00060', SERIES.santiam.daily),
          intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
        ]),
      });
      const [first, santiam, cowlitz] = await reader.getDayStatistics(
        [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
        request(),
      );
      expect(first).toMatchObject({
        status: 'rejected',
        reason: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'upstream_error', retryable: false },
          message: `USGS Water Data Statistics API published 11-11 percentiles for series ${SERIES.potomacDischarge.daily} but no approved month that holds 11-11 (test).`,
        },
      });
      expect(unwrap(santiam)).toEqual(RANKED.santiam1110);
      expect(unwrap(cowlitz)).toEqual(RANKED.cowlitz1110);
    });

    it('a rate limit fails the readings of that read and of every read after it', async () => {
      water.route(
        statisticsRoute('observationNormals', () => rateLimitResponse(3600), {
          query: { start_date: '11-11' },
        }),
        normalsRoute('11-10', [
          normalsCapture('14174450', '00060', '11-10'),
          normalsCapture('14233500', '00060', '11-10'),
        ]),
        intervalsRoute([
          intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily),
          intervalsCapture('14174450', '00060', SERIES.santiam.daily),
          intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
        ]),
      );
      const [potomac, santiam, cowlitz] = await reader.getDayStatistics(
        [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
        request(),
      );
      const rateLimited = {
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 3600 },
      };
      expect(potomac).toMatchObject({ status: 'rejected', reason: rateLimited });
      // Sent beside the limited read, before the host paused.
      expect(unwrap(santiam)).toEqual(RANKED.santiam1110);
      // The fallback read waits on the host's cooldown, which outlasts the call's budget.
      expect(cowlitz).toMatchObject({
        status: 'rejected',
        reason: {
          ...rateLimited,
          message:
            'USGS Water Data Statistics API rate limit reached: requests are paused for 3600 s after an HTTP 429.',
        },
      });
      expect(sentTo('observationIntervals')).toHaveLength(1);
    });
  });

  it('sends an unmatched reading’s fallback read once the normals are in, not after the own-series reads', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const served = statisticsBatchResponder([
      intervalsCapture('01646500', '00060', SERIES.potomacDischarge.daily),
      intervalsCapture('14174450', '00060', SERIES.santiam.daily),
      intervalsCapture('14233500', '00060', SERIES.cowlitz.daily),
    ]);
    threeSiteRoutes({
      intervals: (req) =>
        repeated({ url: new URL(req.url) }, 'parent_time_series_id').includes(SERIES.cowlitz.daily)
          ? served(req)
          : heldFor(20_000, served)(req),
    });
    const pending = reader.getDayStatistics([POTOMAC_1111, SANTIAM_1110, COWLITZ_1110], request());
    await vi.waitFor(() => expect(sentTo('observationIntervals')).toHaveLength(2));
    expect(sentTo('observationIntervals').map((r) => repeated(r, 'parent_time_series_id'))).toEqual(
      [[SERIES.potomacDischarge.daily, SERIES.santiam.daily], [SERIES.cowlitz.daily]],
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await pending).map(unwrap)).toEqual([
      RANKED.potomac1111,
      RANKED.santiam1110,
      RANKED.cowlitz1110,
    ]);
  });

  it('rethrows the caller’s cancellation instead of settling it per reading', async () => {
    threeSiteRoutes({ intervals: stalled });
    const controller = new AbortController();
    const pending = reader.getDayStatistics(
      [POTOMAC_1111, SANTIAM_1110, COWLITZ_1110],
      request(controller.signal),
    );
    // The own-series read and the fallback read are both in flight.
    await vi.waitFor(() => expect(sentTo('observationIntervals')).toHaveLength(2));
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it('gives every read only what is left of the caller’s one deadline, the fallback read included', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    water.route(
      normalsRoute('11-11', [normalsCapture('01646500', '00060', '11-11')]),
      statisticsRoute(
        'observationNormals',
        heldFor(40_000, statisticsBatchResponder([normalsCapture('14233500', '00060', '11-10')])),
        { query: { start_date: '11-10' } },
      ),
      statisticsRoute('observationIntervals', stalled),
    );
    let settled = false;
    const pending = reader.getDayStatistics([POTOMAC_1111, COWLITZ_1110], request()).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(44_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const [potomac, cowlitz] = await pending;

    const timedOut = (attempts: string) => ({
      status: 'rejected',
      reason: {
        code: JsonRpcErrorCode.Timeout,
        message: `test ran out of the 45000 ms budget for this call after ${attempts}.`,
        data: { reason: 'retry_deadline_exceeded', deadlineMs: 45_000, elapsedMs: 45_000 },
      },
    });
    expect(potomac).toMatchObject(timedOut('2 attempts'));
    // Sent at 40 s, the fallback read gets the 5 s left, not a fresh 30 s request timeout.
    expect(cowlitz).toMatchObject(timedOut('1 attempt'));
    expect(sentTo('observationIntervals').map((r) => repeated(r, 'parent_time_series_id'))).toEqual(
      [[SERIES.potomacDischarge.daily], [SERIES.potomacDischarge.daily], [SERIES.cowlitz.daily]],
    );
  });
});

/**
 * The 26 discharge gages of HUC 02070008 that reported on 2026-11-23, captured from one batched
 * run: their locations, daily-mean metadata, 11-23 normals, and monthly intervals trimmed to the
 * first and last November that holds the 23rd (the two that bound the period of record). Each
 * entry: daily-mean series ID, published p50, period of record — read from the captures with jq,
 * not from this code.
 */
const HUC_02070008: readonly [string, string, number, number, number][] = [
  ['01636690', '1ad5265634a44539a391f85a17638b35', 4.16, 2002, 2026],
  ['01637500', 'ed82965ab98e461f8ad32fb28c638aec', 24, 1948, 2026],
  ['01638350', '2a467b3c8f8343d599c2eff9c7d54fe1', 9.99, 2002, 2026],
  ['01638420', '30f23a0badcc4e9789910caabab6fe2d', 7.1, 2002, 2026],
  ['01638480', 'aa32ee3ed8fb4d5884dbe9ea18626b69', 29.45, 1972, 2025],
  ['01638500', '6fce477b4108481d950866411cdc1c00', 3400, 1896, 2026],
  ['01643590', '497eec245db548318dc221d3ff442346', 2.54, 2002, 2026],
  ['01643700', 'c91e8f4e9ae94178a283a53796e64ff7', 36.3, 1966, 2026],
  ['01643805', '9a0421092b79480abd874664e416ec93', 11.9, 2002, 2026],
  ['01643880', 'f90c6d2184314e5cafd528dc1b7e3d4f', 10.9, 2002, 2026],
  ['01644000', '571019312377456caaee3aa492a77eb9', 96, 1910, 2025],
  ['01644280', 'ec029680267f40c6b1484894b9d3a040', 38.4, 2002, 2026],
  ['01644371', '5a2c54c04a9b437bbf2c159be85eb4d3', 0.355, 2005, 2026],
  ['01644372', 'f4cfaad74405437ca0474e59f62ef027', 0.23, 2005, 2026],
  ['01644375', '89d9ca5b175d4b53a8ab9cea741e6978', 1.08, 2005, 2026],
  ['01644380', '0963b475bf594cf194a1d16165b79fe3', 0.56, 2005, 2026],
  ['01644388', '60792f059a9743e0ba29176e17579d0f', 0.69, 2014, 2026],
  ['01644390', '5c34aa60dddf40009d429983c93eebe7', 1.37, 2011, 2026],
  ['01645000', '890f87c5498e4114b24dc0a53b1adcd8', 59, 1931, 2026],
  ['01645704', 'f39321f56e59431f97f4db95ac30c818', 2.88, 2008, 2026],
  ['01645762', '2ee0a864bfcd4d598ea51c537c092e87', 1.39, 2008, 2026],
  ['0164578734', '52365084ef7748c1bb9829a995e70de0', 0.44, 2022, 2026],
  ['0164579522', '97712eda5d0a40699459f09ec04b6cd0', 0.16, 2022, 2026],
  ['01646000', '804f49a549b74389acf8550c9d303cc5', 30, 1936, 2026],
  ['01646305', '329df1b21e7b4a87b6b1a9dc90174207', 0.63, 2009, 2026],
  ['01646500', '2cf409b0d9694c01828f5d4ff14586a5', 4240, 1931, 2026],
];

describe('the 26 gages of HUC 02070008', () => {
  const sites = HUC_02070008.map(([site]) => site);

  function hucRoutes(intervals?: (req: Request) => Response) {
    const metadata = JSON.parse(
      waterDataFixture('time-series-metadata-daily-mean-huc-02070008-00060.json'),
    ) as { features: OgcFeature[] };
    water.route(
      ogcRoute('monitoring-locations', () =>
        jsonResponse(waterDataFixture('monitoring-locations-huc-02070008.json')),
      ),
      ogcRoute('time-series-metadata', locationFilteredResponder(metadata.features), {
        query: { computation_period_identifier: 'Daily' },
      }),
      normalsRoute('11-23', ['statistics-normals-huc-02070008-00060-1123.json']),
      statisticsRoute(
        'observationIntervals',
        intervals ??
          statisticsBatchResponder(['statistics-intervals-huc-02070008-00060-1123.json']),
        { query: { parent_time_series_id: true } },
      ),
    );
  }

  /** Every gage's series, then its 11-23 statistics for a reading from the series' own sensor. */
  async function rankAll() {
    const req = request();
    const dailyMeans = await reader.getDailyMeanSeries(sites, '00060', req);
    const queries = sites.map((number) => {
      const site = unwrap(dailyMeans.get(number));
      // Every gage's live reading came from the sensor its daily mean is computed from.
      return { site, monthDay: '11-23', sourceSeriesId: site.series[0]?.sourceSeriesId ?? null };
    });
    return reader.getDayStatistics(queries, req);
  }

  it('ranks every gage against its own series in one metadata, one normals, and two intervals requests', async () => {
    hucRoutes();
    const results = await rankAll();

    expect(results.map(unwrap)).toEqual(
      HUC_02070008.map(([, id, p50, firstWaterYear, lastWaterYear]) => ({
        status: 'available',
        matched: true,
        series: {
          id,
          description: null,
          percentiles: expect.objectContaining({ p50 }),
          periodOfRecord: { firstWaterYear, lastWaterYear },
        },
      })),
    );
    expect(unwrap(results.at(-1))).toMatchObject({
      series: {
        percentiles: { p05: 1153.5, p10: 1799, p25: 2302.5, p50: 4240, p75: 9670, p95: 31385 },
      },
    });
    // With the readings' Points metadata, continuous rows, and the parameter catalog: 8 in all.
    expect(water.requests.map((r) => r.url.pathname)).toEqual([
      '/ogcapi/v1/collections/monitoring-locations/items',
      '/ogcapi/v1/collections/time-series-metadata/items',
      '/statistics/v0/observationNormals',
      '/statistics/v0/observationIntervals',
      '/statistics/v0/observationIntervals',
    ]);
    expect(repeated(sentTo('observationNormals')[0]!, 'monitoring_location_id')).toHaveLength(26);
    expect(
      sentTo('observationIntervals').map((r) => repeated(r, 'parent_time_series_id').length),
    ).toEqual([13, 13]);
    for (const r of statisticsRequests()) expect(r.url.href.length).toBeLessThan(URL_LIMIT);
  });

  it('leaves only the 13 gages of a failed intervals chunk without statistics', async () => {
    const served = statisticsBatchResponder(['statistics-intervals-huc-02070008-00060-1123.json']);
    const [[, firstSeries]] = HUC_02070008 as [[string, string, number, number, number]];
    hucRoutes((req) =>
      repeated({ url: new URL(req.url) }, 'parent_time_series_id').includes(firstSeries)
        ? forbidden()
        : served(req),
    );
    const results = await rankAll();

    expect(results.slice(0, 13)).toEqual(
      Array.from({ length: 13 }, () => expect.objectContaining({ status: 'rejected' })),
    );
    for (const failed of results.slice(0, 13))
      expect(failed).toMatchObject({ reason: UPSTREAM_403 });
    expect(results.slice(13).map(unwrap)).toEqual(
      HUC_02070008.slice(13).map(([, id]) =>
        expect.objectContaining({ status: 'available', series: expect.objectContaining({ id }) }),
      ),
    );
  });
});

/**
 * @fileoverview The day-statistics reader against captured USGS Water Data responses, run at the
 * fetch seam: the Water Data fake serves the site resolver, `time-series-metadata`, and the
 * Statistics API's `observationNormals` and monthly `observationIntervals`, so resolution, request
 * shapes, response validation, series pairing, and the period-of-record derivation all execute.
 * Expected thresholds and periods of record are the values the WaterServices stat service
 * published for the same site-days (recorded in the port's validation evidence), not this code's
 * output. Monthly-interval fixtures are live captures trimmed to the months the tests rank.
 * @module tests/services/day-statistics.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startDeadline } from '@/services/waterdata/request-deadline.js';
import type { WaterDataRequest } from '@/services/waterdata/water-data-client.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
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

const EMPTY_STATISTICS = { type: 'FeatureCollection', features: [], next: null };
const STATISTICS_PATH = '/statistics/v0/';

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
  vi.unstubAllEnvs();
  water.restore();
});

function request(): WaterDataRequest {
  const ctx = createMockContext();
  return { ctx, deadline: startDeadline(), operation: 'test', signal: ctx.signal };
}

/** The resolver answer for every site these tests use, and that site's daily-mean metadata. */
function siteRoutes(site: string, parameterCd: string) {
  return [
    ogcRoute('monitoring-locations', () =>
      jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
    ),
    ogcRoute(
      'time-series-metadata',
      () =>
        jsonResponse(
          waterDataFixture(`time-series-metadata-daily-mean-${site}-${parameterCd}.json`),
        ),
      { query: { monitoring_location_id: `USGS-${site}`, parameter_code: parameterCd } },
    ),
  ];
}

function normalsRoute(site: string, parameterCd: string, monthDay: string, body?: unknown) {
  return statisticsRoute(
    'observationNormals',
    () =>
      jsonResponse(
        body ??
          waterDataFixture(
            `statistics-normals-${site}-${parameterCd}-${monthDay.replace('-', '')}.json`,
          ),
      ),
    { query: { monitoring_location_id: `USGS-${site}`, start_date: monthDay } },
  );
}

function intervalsRoute(site: string, parameterCd: string, seriesId: string, body?: unknown) {
  return statisticsRoute(
    'observationIntervals',
    () =>
      jsonResponse(
        body ??
          waterDataFixture(
            `statistics-intervals-${site}-${parameterCd}-${seriesId.slice(0, 8)}.json`,
          ),
      ),
    { query: { monitoring_location_id: `USGS-${site}`, parent_time_series_id: seriesId } },
  );
}

/** Route a site-day's captures and read its statistics for a reading from `source`. */
async function statisticsFor(
  site: string,
  parameterCd: string,
  monthDay: string,
  source: string | null,
  extra: Parameters<WaterDataFake['route']> = [],
) {
  water.route(
    ...siteRoutes(site, parameterCd),
    normalsRoute(site, parameterCd, monthDay),
    ...extra,
  );
  const req = request();
  const dailyMeans = await reader.getDailyMeanSeries(site, parameterCd, req);
  return reader.getDayStatistics(dailyMeans, monthDay, source, req);
}

const statisticsRequests = () =>
  water.requests.filter((r) => r.url.pathname.startsWith(STATISTICS_PATH));

describe('getDailyMeanSeries', () => {
  it('lists the daily-mean series with the instantaneous series each is computed from', async () => {
    water.route(...siteRoutes('12396500', '00065'));
    const site = await reader.getDailyMeanSeries('12396500', '00065', request());

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
      monitoring_location_id: 'USGS-12396500',
      parameter_code: '00065',
      computation_period_identifier: 'Daily',
      statistic_id: '00003',
      skipGeometry: 'true',
      properties: 'parent_time_series_id,sublocation_identifier,web_description',
      limit: '1000',
      f: 'json',
    });
  });

  it('composes descriptions as WaterServices wrote them, null when both parts are blank', async () => {
    water.route(...siteRoutes('01646500', '00010'));
    const { series } = await reader.getDailyMeanSeries('01646500', '00010', request());
    expect(series.map((s) => s.description)).toEqual([
      '7.1 ft from riverbed (top), [Discontinued]',
      'From multiparameter sonde',
      '4.1 ft from riverbed (middle), [Discontinued]',
      'From multiparameter sonde, [Discontinued]',
      '1.0 ft from riverbed (bottom), [Discontinued]',
    ]);

    water.route(...siteRoutes('01646500', '00060'));
    const discharge = await reader.getDailyMeanSeries('01646500', '00060', request());
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
      ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([])), {
        query: { monitoring_location_id: 'MO005-364643089212301' },
      }),
    );
    const site = await reader.getDailyMeanSeries('364643089212301', '72019', request());
    expect(site).toEqual({
      monitoringLocationId: 'MO005-364643089212301',
      parameterCd: '72019',
      series: [],
    });
  });

  it('throws not_found for a number no location has, before any metadata request', async () => {
    water.route(
      ogcRoute('monitoring-locations', () =>
        jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
      ),
    );
    const error = await reader.getDailyMeanSeries('99999999', '00060', request()).catch((e) => e);
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
});

describe('getDayStatistics', () => {
  it("ranks a reading against its own sensor's daily mean, with WaterServices' period of record", async () => {
    const result = await statisticsFor(
      '01646500',
      '00060',
      '11-11',
      SERIES.potomacDischarge.source,
      [intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily)],
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
    const [normals, intervals, ...rest] = statisticsRequests();
    expect(rest).toEqual([]);
    expect(Object.fromEntries(normals?.url.searchParams ?? [])).toEqual({
      monitoring_location_id: 'USGS-01646500',
      parameter_code: '00060',
      normal_type: 'DOY',
      computation_type: 'percentile',
      start_date: '11-11',
      end_date: '11-11',
    });
    expect(Object.fromEntries(intervals?.url.searchParams ?? [])).toEqual({
      monitoring_location_id: 'USGS-01646500',
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
      [intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily)],
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
      intervalsRoute('14174450', '00060', SERIES.santiam.daily),
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
      intervalsRoute('01646500', '00010', SERIES.potomacSonde.daily),
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
      [intervalsRoute('401105074120201', '72019', SERIES.howellWell.daily)],
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
        intervalsRoute('12396500', '00065', ids.daily),
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
      intervalsRoute('14233500', '00060', SERIES.cowlitz.daily),
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
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '06-28', EMPTY_STATISTICS),
      intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily),
    );
    const req = request();
    const site = await reader.getDailyMeanSeries('01646500', '00060', req);
    await expect(
      reader.getDayStatistics(site, '06-28', SERIES.potomacDischarge.source, req),
    ).resolves.toEqual({ status: 'no_matching_day' });
  });

  it('reports no_record when neither the day nor the reading’s series has statistics', async () => {
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '06-28', EMPTY_STATISTICS),
      intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily, EMPTY_STATISTICS),
    );
    const req = request();
    const site = await reader.getDailyMeanSeries('01646500', '00060', req);
    await expect(
      reader.getDayStatistics(site, '06-28', SERIES.potomacDischarge.source, req),
    ).resolves.toEqual({ status: 'no_record' });
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
      [intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily, febOnly)],
    ).catch((e) => e);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_error', retryable: false },
      message: expect.stringContaining('no approved month that holds 11-11'),
    });
  });

  describe('a normals body it cannot read fails once, as upstream_error', () => {
    const normals = (values: string[]) => ({
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
    });

    it.each([
      ['one value short', ['1', '2', '3', '4', '5', '6']],
      ['a value that is not a number', ['1', '2', 'abc', '4', '5', '6', '7']],
      ['an empty value, never read as 0', ['', '2', '3', '4', '5', '6', '7']],
    ])('%s', async (_case, values) => {
      water.route(
        ...siteRoutes('01646500', '00060'),
        normalsRoute('01646500', '00060', '11-11', normals(values)),
        intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily),
      );
      const req = request();
      const site = await reader.getDailyMeanSeries('01646500', '00060', req);
      const error = await reader
        .getDayStatistics(site, '11-11', SERIES.potomacDischarge.source, req)
        .catch((e) => e);
      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryable: false },
        message: expect.stringContaining(
          'USGS Water Data Statistics API sent an unexpected response',
        ),
      });
      expect(
        water.requests.filter((r) => r.url.pathname === '/statistics/v0/observationNormals'),
      ).toHaveLength(1);
    });

    it('reads "nan" as an unpublished threshold and a negative value as written', async () => {
      water.route(
        ...siteRoutes('01646500', '00060'),
        normalsRoute(
          '01646500',
          '00060',
          '11-11',
          normals(['nan', '-0.002', '3', '4', '5', '6', 'nan']),
        ),
        intervalsRoute('01646500', '00060', SERIES.potomacDischarge.daily),
      );
      const req = request();
      const site = await reader.getDailyMeanSeries('01646500', '00060', req);
      await expect(
        reader.getDayStatistics(site, '11-11', SERIES.potomacDischarge.source, req),
      ).resolves.toMatchObject({
        series: { percentiles: { p05: null, p10: -0.002, p25: 3, p50: 4, p75: 5, p95: null } },
      });
    });
  });
});

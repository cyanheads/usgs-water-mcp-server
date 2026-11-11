/**
 * @fileoverview water_get_conditions end to end over captured USGS Water Data responses. The tool
 * handler, the readings reader (`getReadings`), the day-statistics reader, and the Water Data
 * client all run; the Water Data fake answers each request at the fetch seam with a captured body:
 * `monitoring-locations`, `parameter-codes`, `time-series-metadata` (the reading's Points series
 * and the site's Daily daily-mean series), `continuous`, and the Statistics API's
 * `observationNormals` and monthly `observationIntervals`. Every route matches on the query the
 * readers must send, so a request built wrong falls through to the fake's rejection.
 *
 * Expected values are read from the captures, never from this code's output: readings and their
 * instants from the `continuous` rows, thresholds from the normals, periods of record from the
 * approved months in the intervals. The Potomac (01646500) rows are the shared readings fixtures,
 * served as the rows the query's site and parameter filter selects. Each
 * `conditions-upstream-continuous-*` body is a one-day `continuous` read of one site, trimmed to
 * the two hours a `time=PT2H` read returned at the instant in its file name; the 404931073382101
 * body is that one-day read untrimmed, empty because the well last reported on 2026-11-05.
 * @module tests/tools/water-get-conditions.upstream.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allText } from '../helpers/content-block.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcRoute,
  rateLimitResponse,
  type SentRequest,
  statisticsRoute,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type ConditionsTool =
  typeof import('@/mcp-server/tools/definitions/water-get-conditions.tool.js')['waterGetConditions'];

let tool: ConditionsTool;
let water: WaterDataFake;

beforeEach(async () => {
  vi.resetModules(); // the resolver and catalog caches and the per-host cooldown gates start empty
  vi.stubEnv('USGS_API_KEY', undefined);
  ({ waterGetConditions: tool } = await import(
    '@/mcp-server/tools/definitions/water-get-conditions.tool.js'
  ));
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.unstubAllEnvs();
  water.restore();
});

type Conditions = {
  currentDateTime: string;
  currentValue: string;
  historicalContext: {
    comparisonBasis: string;
    methodMatched: boolean;
    p05: number | null;
    p10: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p95: number | null;
    percentileClass: string;
    percentileLabel: string;
    periodOfRecord: string;
    statSeriesDescription: string | null;
    statSeriesId: string | null;
  } | null;
  historicalContextStatus: string;
  methodDescription: string | null;
  methodId: string | null;
  note?: string;
  parameterCd: string;
  parameterName: string;
  qualifiers: string[];
  siteName: string;
  siteNumber: string;
  unitCode: string;
};

const COMPARISON_BASIS =
  "The current value is an instantaneous reading, but these percentiles are computed from approved daily-mean values for this calendar day, so an instantaneous peak can rank above the same day's daily mean. Treat percentileClass as an approximate ranking, not a like-for-like comparison.";
const DEPTH_BASIS =
  'This value is a depth below the surface, ranked as a water level: a shallower depth is a higher water level, so p95 is the shallowest of these depths and p05 the deepest. currentValue is the depth as measured.';
const DEPTH_LABEL = ' — depth ranked as a water level (shallower ranks higher)';
const LOW = '< 5th percentile (percentile-of-record extreme, not a verified all-time record)';
const MATCHED = "matched to the reported method — the daily mean of the sensor's own series";
const UNMATCHED =
  'not matched to the reported method — the percentiles may come from a different sensor (see note)';

/** Captured time-series IDs: a reporting sensor's series and the daily mean computed from it. */
const POTOMAC_DISCHARGE = {
  sensor: '66a4e3fb8abe42fcb0942b5c0fe98f68',
  daily: '2cf409b0d9694c01828f5d4ff14586a5',
};
const POTOMAC_SONDE = {
  sensor: 'd1875d1d73e447d2a1203105ba654e7d',
  daily: '40bfcf380ef240e18699ee4875350640',
};
const BASE_GAGE = {
  sensor: 'dea67e89fcc54472ae9db8e097a637fb',
  daily: 'f3f93cac0e144cd8b3b7ee826f0fc2b7',
};
const AUXILIARY_GAGE = {
  sensor: '1c9d1f64a6cd4093913ab88ec7c41991',
  daily: '81f6f58adb784d90bca74a02877600b8',
};
const BLM_WELL = {
  sensor: '9ae2ce5bd34540c8ad6b394855489479',
  daily: '0d91e794e4a24e99abb3b363a75599ad',
};

type Feature = { id?: string; properties: Record<string, unknown> };
type FeatureBody = { features: Feature[]; numberReturned?: number };

const parse = (name: string) => JSON.parse(waterDataFixture(name)) as FeatureBody;

/** `body` holding `features` instead, its count kept in step. */
function withFeatures(body: FeatureBody, features: Feature[]): FeatureBody {
  return { ...body, features, numberReturned: features.length };
}

/** `body` with `parent_time_series_id` absent from every feature, as a sparse series list sends it. */
function withoutParentLinks(body: FeatureBody): FeatureBody {
  return withFeatures(
    body,
    body.features.map(({ properties: { parent_time_series_id: _, ...rest }, ...feature }) => ({
      ...feature,
      properties: rest,
    })),
  );
}

/** The captured features of a multi-site body that a site and parameter filter selects. */
function selected(name: string, site: string, parameterCd: string): FeatureBody {
  const body = parse(name);
  return withFeatures(
    body,
    body.features.filter(
      ({ properties: p }) =>
        p.monitoring_location_id === `USGS-${site}` && p.parameter_code === parameterCd,
    ),
  );
}

/** The instant each trimmed `continuous` capture stands for (see the file header). */
const WINDOWS: Readonly<Record<string, string>> = {
  '322323106314701-72019': '20261111T0705Z',
  '12396500-00065': '20261111T0205Z',
  '261620081464402-62610': '20261110T1505Z',
  '404931073382101-62610': 'P1D',
};

/** One site and parameter's captured reading: its Points series list and its two-hour rows. */
interface Reading {
  points: FeatureBody;
  rows: FeatureBody | (() => Response);
}

function capturedReading(site: string, parameterCd: string): Reading & { rows: FeatureBody } {
  if (site === '01646500') {
    return {
      points: selected('observations-tsm-readings-points.json', site, parameterCd),
      rows: selected('observations-continuous-readings-PT2H.json', site, parameterCd),
    };
  }
  return {
    points: parse(`conditions-upstream-points-${site}-${parameterCd}.json`),
    rows: parse(
      `conditions-upstream-continuous-${site}-${parameterCd}-${WINDOWS[`${site}-${parameterCd}`]}.json`,
    ),
  };
}

/** A route responder: a function as given, anything else served as a JSON body. */
const respondWith = (body: unknown) =>
  typeof body === 'function' ? (body as () => Response) : () => jsonResponse(body);

/** Routes for the reading: the site, the parameter catalog, the Points series, the two-hour rows. */
function readingRoutes(
  site: string,
  parameterCd: string,
  reading: Reading = capturedReading(site, parameterCd),
) {
  const filter = {
    'filter-lang': 'cql2-text',
    filter: `monitoring_location_id IN ('USGS-${site}') AND parameter_code IN ('${parameterCd}')`,
  };
  return [
    ogcRoute(
      'monitoring-locations',
      () => jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
      { query: { monitoring_location_number: site } },
    ),
    ogcRoute(
      'parameter-codes',
      () => jsonResponse(waterDataFixture('observations-parameter-codes.json')),
      { query: { limit: '50000' } },
    ),
    ogcRoute('time-series-metadata', respondWith(reading.points), {
      query: { ...filter, computation_period_identifier: 'Points' },
    }),
    ogcRoute('continuous', respondWith(reading.rows), { query: { ...filter, time: 'PT2H' } }),
  ];
}

/** The site's daily-mean series list — the captured one unless `body` replaces it. */
function dailyMeansRoute(site: string, parameterCd: string, body?: unknown) {
  return ogcRoute(
    'time-series-metadata',
    respondWith(
      body ?? waterDataFixture(`time-series-metadata-daily-mean-${site}-${parameterCd}.json`),
    ),
    {
      query: {
        monitoring_location_id: `USGS-${site}`,
        parameter_code: parameterCd,
        computation_period_identifier: 'Daily',
        statistic_id: '00003',
      },
    },
  );
}

/** The day's percentile normals, asked for `monthDay` alone — the captured ones unless replaced. */
function normalsRoute(site: string, parameterCd: string, monthDay: string, body?: unknown) {
  return statisticsRoute(
    'observationNormals',
    respondWith(
      body ??
        waterDataFixture(
          `statistics-normals-${site}-${parameterCd}-${monthDay.replace('-', '')}.json`,
        ),
    ),
    {
      query: {
        monitoring_location_id: `USGS-${site}`,
        parameter_code: parameterCd,
        normal_type: 'DOY',
        computation_type: 'percentile',
        start_date: monthDay,
        end_date: monthDay,
      },
    },
  );
}

/** One daily-mean series' approved monthly intervals, captured. */
function intervalsRoute(site: string, parameterCd: string, seriesId: string) {
  return statisticsRoute(
    'observationIntervals',
    () =>
      jsonResponse(
        waterDataFixture(
          `statistics-intervals-${site}-${parameterCd}-${seriesId.slice(0, 8)}.json`,
        ),
      ),
    {
      query: {
        monitoring_location_id: `USGS-${site}`,
        parameter_code: parameterCd,
        interval_type: 'M',
        computation_type: 'arithmetic_mean',
        parent_time_series_id: seriesId,
      },
    },
  );
}

async function conditions(site: string, parameterCd: string) {
  const result = await runToolContract(tool, { site, parameterCd });
  return {
    result,
    structured: result.structuredContent as Conditions,
    text: allText(result.content),
  };
}

/** A request in a word: its collection or Statistics endpoint, and a metadata read's period. */
function label({ url }: SentRequest): string {
  const parts = url.pathname.split('/');
  const name = (parts.at(-1) === 'items' ? parts.at(-2) : parts.at(-1)) ?? url.pathname;
  const period = url.searchParams.get('computation_period_identifier');
  return period ? `${name} ${period}` : name;
}

const sent = () => water.requests.map(label);
const statisticsSent = () => sent().filter((name) => name.startsWith('observation'));
const normalsDays = () =>
  water.requests
    .filter((r) => r.url.pathname.endsWith('/observationNormals'))
    .map((r) => `${r.url.searchParams.get('start_date')}/${r.url.searchParams.get('end_date')}`);

describe('water_get_conditions over captured Water Data responses', () => {
  it('ranks the Potomac discharge reading against its own daily mean (characterization)', async () => {
    water.route(
      ...readingRoutes('01646500', '00060'),
      dailyMeansRoute('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC_DISCHARGE.daily),
    );
    const { result, structured, text } = await conditions('01646500', '00060');

    expect(result.isError).toBeFalsy();
    // The latest row reads 1940 ft3/s at 09:50Z; the 11-11 thresholds place it between p10 and p25.
    expect(structured).toEqual({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      parameterCd: '00060',
      parameterName: 'Discharge, cubic feet per second',
      unitCode: 'ft3/s',
      methodId: POTOMAC_DISCHARGE.sensor,
      methodDescription: null,
      currentValue: '1940',
      currentDateTime: '2026-11-11T04:50:00.000-05:00',
      qualifiers: ['P'],
      historicalContext: {
        percentileClass: 'below-normal',
        percentileLabel: '10th–25th percentile',
        p05: 1015.6,
        p10: 1599,
        p25: 2257.5,
        p50: 3600,
        p75: 7545,
        p95: 36210,
        periodOfRecord: '1931–2026',
        comparisonBasis: COMPARISON_BASIS,
        statSeriesId: POTOMAC_DISCHARGE.daily,
        statSeriesDescription: null,
        methodMatched: true,
      },
      historicalContextStatus: 'available',
    });
    expect(text).toBe(
      [
        '### POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA (01646500)',
        '**Parameter:** Discharge, cubic feet per second (00060) | **Unit:** ft3/s',
        `**Method:** (no description) | **Method ID:** ${POTOMAC_DISCHARGE.sensor}`,
        '**Current value:** 1940 ft3/s [P]',
        '**Observed:** 2026-11-11T04:50:00.000-05:00',
        '',
        '**Condition:** below-normal — 10th–25th percentile | **Period of record:** 1931–2026',
        "**Percentiles for today's calendar day:**",
        '  p05=1015.6 | p10=1599 | p25=2257.5 | p50=3600 | p75=7545 | p95=36210',
        `*${COMPARISON_BASIS}*`,
        `**Percentile series:** (no description) | **Stat series ID:** ${POTOMAC_DISCHARGE.daily} | ${MATCHED}`,
        '**Historical context status:** available',
      ].join('\n'),
    );
    expect(normalsDays()).toEqual(['11-11/11-11']);
  });

  it('costs seven requests on a cold call and five once the site and catalog are cached', async () => {
    water.route(
      ...readingRoutes('01646500', '00060'),
      dailyMeansRoute('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC_DISCHARGE.daily),
    );
    await conditions('01646500', '00060');
    const cold = sent();
    // Both readers resolve the site; they share one monitoring-locations request.
    expect([...cold].sort()).toEqual([
      'continuous',
      'monitoring-locations',
      'observationIntervals',
      'observationNormals',
      'parameter-codes',
      'time-series-metadata Daily',
      'time-series-metadata Points',
    ]);
    // The day comes from the reading, so the statistics go out last.
    expect(cold.slice(-2).sort()).toEqual(['observationIntervals', 'observationNormals']);

    const { structured } = await conditions('01646500', '00060');
    expect(structured.historicalContext?.percentileClass).toBe('below-normal');
    expect(sent().slice(cold.length).sort()).toEqual([
      'continuous',
      'observationIntervals',
      'observationNormals',
      'time-series-metadata Daily',
      'time-series-metadata Points',
    ]);
  });
});

describe('#53: a depth below the surface ranks by water level', () => {
  it('ranks the 75.27 ft depth at 322323106314701 record-low on the observation’s own day (#9)', async () => {
    water.route(
      ...readingRoutes('322323106314701', '72019'),
      dailyMeansRoute('322323106314701', '72019'),
      normalsRoute('322323106314701', '72019', '11-11'),
      intervalsRoute('322323106314701', '72019', BLM_WELL.daily),
    );
    const { structured, text } = await conditions('322323106314701', '72019');

    // Read at 07:00Z: midnight on 11-11 at the well (MST), still 11-10 on a US Pacific clock.
    expect(normalsDays()).toEqual(['11-11/11-11']);
    // The published 11-11 depths descend: p05 is the deepest, so 75.27 ft lies past it.
    const basis = `${COMPARISON_BASIS} ${DEPTH_BASIS}`;
    expect(structured).toMatchObject({
      siteName: '22S.04E.15.331 BLM CRN WELL',
      parameterName: 'Depth to water level, feet below land surface',
      unitCode: 'ft',
      methodId: BLM_WELL.sensor,
      methodDescription: null,
      currentValue: '75.27',
      currentDateTime: '2026-11-11T00:00:00.000-07:00',
      qualifiers: ['P'],
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'record-low',
        percentileLabel: `${LOW}${DEPTH_LABEL}`,
        p05: 74.813,
        p10: 73.626,
        p25: 71.137,
        p50: 69.435,
        p75: 67.602,
        p95: 58.543,
        periodOfRecord: '2000–2026',
        comparisonBasis: basis,
        statSeriesId: BLM_WELL.daily,
        statSeriesDescription: null,
        methodMatched: true,
      },
    });
    expect(structured.note).toBeUndefined();
    expect(text).toContain(
      `**Condition:** record-low — ${LOW}${DEPTH_LABEL} | **Period of record:** 2000–2026`,
    );
    expect(text).toContain(
      'p05=74.813 | p10=73.626 | p25=71.137 | p50=69.435 | p75=67.602 | p95=58.543',
    );
    expect(text).toContain(`*${basis}*`);
  });
});

describe('#43: several sensors for one parameter', () => {
  it('ranks the live sonde at 01646500/00010 against its own daily mean beside four retired sensors', async () => {
    const reading = capturedReading('01646500', '00010');
    // The Points list names five temperature sensors; only the sonde has rows in the window.
    expect(reading.points.features).toHaveLength(5);
    water.route(
      ...readingRoutes('01646500', '00010', reading),
      dailyMeansRoute('01646500', '00010'),
      normalsRoute('01646500', '00010', '11-11'),
      intervalsRoute('01646500', '00010', POTOMAC_SONDE.daily),
    );
    const { structured, text } = await conditions('01646500', '00010');

    // Five daily-mean series publish 11-11 percentiles; the sonde's own is the one ranked.
    expect(structured).toMatchObject({
      parameterName: 'Temperature, water, degrees Celsius',
      unitCode: 'deg C',
      methodId: POTOMAC_SONDE.sensor,
      methodDescription: 'From multiparameter sonde',
      currentValue: '13.4',
      currentDateTime: '2026-11-11T04:50:00.000-05:00',
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'normal',
        percentileLabel: '25th–75th percentile',
        p05: null,
        p10: null,
        p25: 10.05,
        p50: 12.15,
        p75: 14.925,
        p95: null,
        periodOfRecord: '2020–2026',
        comparisonBasis: COMPARISON_BASIS,
        statSeriesId: POTOMAC_SONDE.daily,
        statSeriesDescription: 'From multiparameter sonde',
        methodMatched: true,
      },
    });
    expect(structured.note).toBeUndefined();
    expect(text).toContain(
      `**Method:** From multiparameter sonde | **Method ID:** ${POTOMAC_SONDE.sensor}`,
    );
    expect(text).toContain(
      `**Percentile series:** From multiparameter sonde | **Stat series ID:** ${POTOMAC_SONDE.daily} | ${MATCHED}`,
    );
  });

  it('reports the base gage at 12396500 when both gages read at the same instant (#9)', async () => {
    water.route(
      ...readingRoutes('12396500', '00065'),
      dailyMeansRoute('12396500', '00065'),
      normalsRoute('12396500', '00065', '11-10'),
      intervalsRoute('12396500', '00065', BASE_GAGE.daily),
    );
    const { structured, text } = await conditions('12396500', '00065');

    // Both gages last read at 02:00Z on 11-11 — 18:00 on 11-10 at the river (PST).
    expect(normalsDays()).toEqual(['11-10/11-10']);
    expect(structured).toMatchObject({
      siteName: 'PEND OREILLE RIVER BELOW BOX CANYON NEAR IONE, WA',
      parameterName: 'Gage height, feet',
      unitCode: 'ft',
      methodId: BASE_GAGE.sensor,
      methodDescription: null,
      currentValue: '89.12',
      currentDateTime: '2026-11-10T18:00:00.000-08:00',
      qualifiers: ['P'],
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'above-normal',
        percentileLabel: '75th–95th percentile',
        p05: 19.33,
        p25: 21.63,
        p75: 88.9,
        p95: 91.94,
        periodOfRecord: '1984–2026',
        comparisonBasis: COMPARISON_BASIS,
        statSeriesId: BASE_GAGE.daily,
        statSeriesDescription: '[BASE GAGE]',
        methodMatched: true,
      },
    });
    expect(structured.note).toBeUndefined();
    expect(text).toContain(`**Method:** (no description) | **Method ID:** ${BASE_GAGE.sensor}`);
    expect(text).toContain(
      `**Percentile series:** [BASE GAGE] | **Stat series ID:** ${BASE_GAGE.daily} | ${MATCHED}`,
    );
  });

  it('prefers the gage the series list pairs with a daily mean over a newer one it does not', async () => {
    const reading = capturedReading('12396500', '00065');
    // The auxiliary gage's 02:00Z row is dropped, so the base gage reads 15 minutes later; the
    // series list keeps only the auxiliary gage's daily mean.
    reading.rows = withFeatures(
      reading.rows,
      reading.rows.features.filter(
        ({ properties: p }) =>
          !(p.time_series_id === AUXILIARY_GAGE.sensor && p.time === '2026-11-11T02:00:00+00:00'),
      ),
    );
    const dailyMeans = parse('time-series-metadata-daily-mean-12396500-00065.json');
    water.route(
      ...readingRoutes('12396500', '00065', reading),
      dailyMeansRoute(
        '12396500',
        '00065',
        withFeatures(
          dailyMeans,
          dailyMeans.features.filter((f) => f.id === AUXILIARY_GAGE.daily),
        ),
      ),
      normalsRoute('12396500', '00065', '11-10'),
      intervalsRoute('12396500', '00065', AUXILIARY_GAGE.daily),
    );
    const { structured, text } = await conditions('12396500', '00065');

    expect(structured).toMatchObject({
      methodId: AUXILIARY_GAGE.sensor,
      methodDescription: 'AUXILIARY GAGE',
      currentValue: '87.94',
      currentDateTime: '2026-11-10T17:45:00.000-08:00',
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'normal',
        p25: 84.28,
        p75: 87.99,
        periodOfRecord: '1988–2026',
        statSeriesId: AUXILIARY_GAGE.daily,
        statSeriesDescription: 'AUXILIARY GAGE, [AUXILIARY GAGE]',
        methodMatched: true,
      },
    });
    expect(text).toContain(`**Method:** AUXILIARY GAGE | **Method ID:** ${AUXILIARY_GAGE.sensor}`);
  });

  it('declines to rank when the series list links neither daily mean to a gage', async () => {
    water.route(
      ...readingRoutes('12396500', '00065'),
      dailyMeansRoute(
        '12396500',
        '00065',
        withoutParentLinks(parse('time-series-metadata-daily-mean-12396500-00065.json')),
      ),
      normalsRoute('12396500', '00065', '11-10'),
    );
    const { result, structured, text } = await conditions('12396500', '00065');

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      methodId: BASE_GAGE.sensor,
      currentValue: '89.12',
      historicalContext: null,
      historicalContextStatus: 'no_matching_method',
    });
    expect(structured.note).toBe(
      `The statistics cover 2 daily-mean series at this site — AUXILIARY GAGE, [AUXILIARY GAGE] [series ${AUXILIARY_GAGE.daily}]; [BASE GAGE] [series ${BASE_GAGE.daily}] — and none is computed from the reported sensor's series (${BASE_GAGE.sensor}), so no ranking is made rather than attributing another sensor's percentiles to this reading.`,
    );
    expect(text).toContain('**Condition:** No historical context available.');
    expect(text).toContain('**Historical context status:** no_matching_method');
    expect(text).toContain(`*${structured.note}*`);
    expect(statisticsSent()).toEqual(['observationNormals']);
  });

  it("ranks unmatched against the site's only daily mean when the series list does not link it, and says so", async () => {
    water.route(
      ...readingRoutes('01646500', '00060'),
      dailyMeansRoute(
        '01646500',
        '00060',
        withoutParentLinks(parse('time-series-metadata-daily-mean-01646500-00060.json')),
      ),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC_DISCHARGE.daily),
    );
    const { structured, text } = await conditions('01646500', '00060');

    expect(structured).toMatchObject({
      methodId: POTOMAC_DISCHARGE.sensor,
      currentValue: '1940',
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'below-normal',
        periodOfRecord: '1931–2026',
        comparisonBasis: COMPARISON_BASIS,
        statSeriesId: POTOMAC_DISCHARGE.daily,
        statSeriesDescription: null,
        methodMatched: false,
      },
    });
    expect(structured.note).toBe(
      `Percentiles come from the only daily-mean series with percentiles for this day, (no description) [series ${POTOMAC_DISCHARGE.daily}], which is not computed from the reported sensor's series (${POTOMAC_DISCHARGE.sensor}) — they may come from a different sensor or location than the reading.`,
    );
    expect(text).toContain(
      `**Percentile series:** (no description) | **Stat series ID:** ${POTOMAC_DISCHARGE.daily} | ${UNMATCHED}`,
    );
    expect(text).toContain(`*${structured.note}*`);
    // The unmatched series' months are read once the normals name it.
    expect(statisticsSent()).toEqual(['observationNormals', 'observationIntervals']);
  });
});

/**
 * #44: the sonde's daily mean publishes only p25 10.05 and p75 14.925 (with p50) for 11-11. The
 * captured rows are served with the sonde's latest value replaced to place a reading on each side.
 */
describe('#44: a daily mean that publishes only its quartiles', () => {
  it.each([
    ['14.925', 'above-normal', '≥ 75th percentile; 95th not published'],
    ['10.04', 'below-normal', '< 25th percentile; 10th not published'],
  ])(
    'ranks a sonde reading of %s as %s, naming the threshold left blank',
    async (value, cls, label) => {
      const reading = capturedReading('01646500', '00010');
      const latest = reading.rows.features
        .filter(({ properties: p }) => p.time_series_id === POTOMAC_SONDE.sensor)
        .reduce((a, b) => (String(a.properties.time) > String(b.properties.time) ? a : b));
      latest.properties.value = value;
      water.route(
        ...readingRoutes('01646500', '00010', reading),
        dailyMeansRoute('01646500', '00010'),
        normalsRoute('01646500', '00010', '11-11'),
        intervalsRoute('01646500', '00010', POTOMAC_SONDE.daily),
      );
      const { structured, text } = await conditions('01646500', '00010');

      expect(structured).toMatchObject({
        currentValue: value,
        currentDateTime: '2026-11-11T04:50:00.000-05:00',
        historicalContext: {
          percentileClass: cls,
          percentileLabel: label,
          p05: null,
          p10: null,
          p25: 10.05,
          p75: 14.925,
          p95: null,
          statSeriesId: POTOMAC_SONDE.daily,
          comparisonBasis: COMPARISON_BASIS,
        },
      });
      expect(text).toContain(`**Condition:** ${cls} — ${label} | **Period of record:** 2020–2026`);
      expect(text).toContain('p05=N/A | p10=N/A | p25=10.05 | p50=12.15 | p75=14.925 | p95=N/A');
    },
  );
});

describe('#45: a reading USGS holds no value for', () => {
  it('reports a SEASONAL reading as no data, unranked, naming its qualifiers on both surfaces', async () => {
    const reading = capturedReading('01646500', '00060');
    // Every row as `continuous` sends a seasonal gage's: no value, qualifier SEASONAL.
    for (const { properties } of reading.rows.features) {
      properties.value = null;
      properties.qualifier = ['SEASONAL'];
    }
    water.route(
      ...readingRoutes('01646500', '00060', reading),
      dailyMeansRoute('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC_DISCHARGE.daily),
    );
    const { result, structured, text } = await conditions('01646500', '00060');

    expect(result.isError).toBeFalsy();
    const label = 'no value to rank — USGS reported no data for this reading (qualifiers: P, Ssn)';
    expect(structured).toMatchObject({
      currentValue: '',
      currentDateTime: '2026-11-11T04:50:00.000-05:00',
      qualifiers: ['P', 'Ssn'],
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'unknown',
        percentileLabel: label,
        p05: 1015.6,
        periodOfRecord: '1931–2026',
        comparisonBasis: COMPARISON_BASIS,
        methodMatched: true,
      },
    });
    expect(structured.note).toBe(
      'USGS reported no value for the current reading (qualifiers: P, Ssn), so it is not ranked. The qualifiers give the reason (e.g. seasonal, discontinued, dry, equipment malfunction).',
    );
    expect(text).toContain('**Current value:** no data [P,Ssn]');
    expect(text).toContain(`**Condition:** unknown — ${label} |`);
    expect(text).toContain(`*${structured.note}*`);
    expect(text).not.toContain('record-low');
  });
});

describe('statuses without a ranking', () => {
  it('reports no_record for 261620081464402, whose 62610 normals hold only daily maxima', async () => {
    water.route(
      ...readingRoutes('261620081464402', '62610'),
      dailyMeansRoute('261620081464402', '62610'),
      normalsRoute('261620081464402', '62610', '11-10'),
    );
    const { result, structured, text } = await conditions('261620081464402', '62610');

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      siteName: 'C  -1004R',
      // The captured catalog holds no 62610 record, so name and unit come from the series itself.
      parameterName: 'Elevation, GW, NGVD29',
      unitCode: 'ft',
      methodId: '00b283154be94483aeebd340cf02244a',
      methodDescription: null,
      currentValue: '1.14',
      currentDateTime: '2026-11-10T10:00:00.000-05:00',
      qualifiers: ['P'],
      historicalContext: null,
      historicalContextStatus: 'no_record',
    });
    expect(structured.note).toBe(
      'No historical daily-mean percentiles are published for this site and parameter on this calendar day. The record may be too new or too short to compute them, or this parameter has no daily-mean statistics here (some series carry only daily maximum or minimum statistics).',
    );
    expect(text).toContain('**Parameter:** Elevation, GW, NGVD29 (62610) | **Unit:** ft');
    expect(text).toContain('**Condition:** No historical context available.');
    expect(text).toContain('**Historical context status:** no_record');
    expect(statisticsSent()).toEqual(['observationNormals']);
  });

  it('answers no_data_for_parameter for 404931073382101, whose 62610 well sent nothing in the window', async () => {
    water.route(
      ...readingRoutes('404931073382101', '62610'),
      dailyMeansRoute('404931073382101', '62610'),
    );
    const { result, text } = await conditions('404931073382101', '62610');

    expect(result.isError).toBe(true);
    const recovery = declaredRecovery(tool.errors, 'no_data_for_parameter');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message:
          "No reading for site 404931073382101 parameter 62610 in the last 2 hours — the site reports this parameter but sent no value in that window. Call water_get_readings with a longer period for its latest value; water_get_site_data_catalog gives the series' endDate, its last report.",
        data: { reason: 'no_data_for_parameter', recovery },
      },
    });
    expect(text).toContain(recovery.hint);
    expect(statisticsSent()).toEqual([]);
  });
});

describe('#20: a statistics failure keeps the reading', () => {
  it('reports a Statistics API 429 as unavailable with its wait, sending the normals once', async () => {
    water.route(
      ...readingRoutes('01646500', '00060'),
      dailyMeansRoute('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11', () => rateLimitResponse(3600, 4000)),
      intervalsRoute('01646500', '00060', POTOMAC_DISCHARGE.daily),
    );
    const { result, structured, text } = await conditions('01646500', '00060');

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      currentValue: '1940',
      methodId: POTOMAC_DISCHARGE.sensor,
      historicalContext: null,
      historicalContextStatus: 'unavailable',
    });
    expect(structured.note).toBe(
      "Historical percentile context could not be retrieved — the statistics service call failed. USGS Water Data Statistics API rate limit reached (OVER_RATE_LIMIT). The limit is 4000 requests per hour per IP address without an API key. Retry after 3600 s. This is an upstream failure, not a statement about the site's record; call again later for the ranking.",
    );
    expect(text).toContain('**Current value:** 1940 ft3/s [P]');
    expect(text).toContain('**Historical context status:** unavailable');
    expect(text).toContain(`*${structured.note}*`);
    expect(normalsDays()).toHaveLength(1);
  });

  it('reports unavailable when the daily-mean series list arrives unreadable, sending no statistics request', async () => {
    const truncated = waterDataFixture('time-series-metadata-daily-mean-01646500-00060.json').slice(
      0,
      200,
    );
    water.route(
      ...readingRoutes('01646500', '00060'),
      dailyMeansRoute('01646500', '00060', () => jsonResponse(truncated)),
    );
    const { result, structured } = await conditions('01646500', '00060');

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      currentValue: '1940',
      methodId: POTOMAC_DISCHARGE.sensor,
      historicalContext: null,
      historicalContextStatus: 'unavailable',
    });
    expect(structured.note).toBe(
      "Historical percentile context could not be retrieved — the statistics service call failed. USGS Water Data OGC API sent a response that is not JSON (water_get_conditions). This is an upstream failure, not a statement about the site's record; call again later for the ranking.",
    );
    // A complete body that does not parse fails at once: read once, never re-sent.
    expect(sent().filter((name) => name === 'time-series-metadata Daily')).toHaveLength(1);
    expect(statisticsSent()).toEqual([]);
  });
});

describe('a reading the upstream cannot deliver', () => {
  it('fails as upstream_error with its recovery hint when the two-hour rows arrive unreadable', async () => {
    const reading = capturedReading('01646500', '00060');
    const truncated = JSON.stringify(reading.rows).slice(0, 500);
    water.route(
      ...readingRoutes('01646500', '00060', { ...reading, rows: () => jsonResponse(truncated) }),
      dailyMeansRoute('01646500', '00060'),
    );
    const { result, text } = await conditions('01646500', '00060');

    expect(result.isError).toBe(true);
    const recovery = declaredRecovery(tool.errors, 'upstream_error');
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: 'USGS Water Data OGC API sent a response that is not JSON (water_get_conditions).',
        data: { reason: 'upstream_error', recovery },
      },
    });
    expect(text).toContain(recovery.hint);
    expect(sent().filter((name) => name === 'continuous')).toHaveLength(1);
    expect(statisticsSent()).toEqual([]);
  });
});

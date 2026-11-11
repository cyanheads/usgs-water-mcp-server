/**
 * @fileoverview water_get_conditions with the reading mocked and everything after it real: the
 * Water Data fake serves the site resolver, the daily-mean series metadata, and the Statistics
 * API, so sensor pairing, the observation-day lookup, depth ranking, and the statistics failure
 * paths run through the day-statistics reader. `getReadings` is mocked at its module; the request
 * it receives is the call's own, so the deadline cases prove one budget spans the reading and the
 * statistics. Each test loads the tool fresh, so the resolver cache and cooldown gates start empty.
 * @module tests/tools/water-get-conditions.tool.test
 */

import {
  JsonRpcErrorCode,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockedFunction, vi } from 'vitest';
import type { getReadings as GetReadings } from '@/services/waterdata/observations.js';
import type { NwisTimeSeries } from '@/services/waterdata/types.js';
import { textContent } from '../helpers/content-block.js';
import { contractError, declaredRecovery } from '../helpers/error-contract.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  rateLimitResponse,
  stalled,
  statisticsRoute,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

vi.mock('@/services/waterdata/observations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/waterdata/observations.js')>()),
  getReadings: vi.fn(),
}));

type ConditionsTool =
  typeof import('@/mcp-server/tools/definitions/water-get-conditions.tool.js')['waterGetConditions'];

let tool: ConditionsTool;
let mockGetReadings: MockedFunction<typeof GetReadings>;
let water: WaterDataFake;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  ({ waterGetConditions: tool } = await import(
    '@/mcp-server/tools/definitions/water-get-conditions.tool.js'
  ));
  mockGetReadings = vi.mocked((await import('@/services/waterdata/observations.js')).getReadings);
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

const recovery = (reason: string) => declaredRecovery(tool.errors, reason);
const allText = (content: readonly { type: string; text?: string }[]) =>
  content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('\n');

/** The Potomac discharge gage's daily-mean series and the instantaneous series it comes from. */
const POTOMAC = {
  daily: '2cf409b0d9694c01828f5d4ff14586a5',
  source: '66a4e3fb8abe42fcb0942b5c0fe98f68',
};

const COMPARISON_BASIS =
  "The current value is an instantaneous reading, but these percentiles are computed from approved daily-mean values for this calendar day, so an instantaneous peak can rank above the same day's daily mean. Treat percentileClass as an approximate ranking, not a like-for-like comparison.";
const DEPTH_LABEL = ' — depth ranked as a water level (shallower ranks higher)';
const HIGH = '≥ 95th percentile (percentile-of-record extreme, not a verified all-time record)';
const LOW = '< 5th percentile (percentile-of-record extreme, not a verified all-time record)';

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
  qualifiers: string[];
};

/** A reading series as getReadings returns it — Potomac discharge unless overridden. */
function readingSeries(overrides: Partial<NwisTimeSeries> = {}): NwisTimeSeries {
  return {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
    parameterCd: '00060',
    parameterName: 'Discharge, cubic feet per second',
    unitCode: 'ft3/s',
    methodId: POTOMAC.source,
    methodDescription: null,
    statCd: '00000',
    statName: null,
    values: [],
    ...overrides,
  };
}

const at = (dateTime: string, value: string, qualifiers = ['P']) => ({
  dateTime,
  value,
  qualifiers,
});

/** The resolver answer for every captured site, and one site's captured daily-mean metadata. */
function siteRoutes(site: string, parameterCd: string, metadata?: unknown) {
  return [
    ogcRoute('monitoring-locations', () =>
      jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
    ),
    ogcRoute(
      'time-series-metadata',
      () =>
        jsonResponse(
          metadata ??
            waterDataFixture(`time-series-metadata-daily-mean-${site}-${parameterCd}.json`),
        ),
      { query: { monitoring_location_id: `USGS-${site}`, parameter_code: parameterCd } },
    ),
  ];
}

function normalsRoute(site: string, parameterCd: string, monthDay: string, respond?: unknown) {
  return statisticsRoute(
    'observationNormals',
    typeof respond === 'function'
      ? (respond as () => Response)
      : () =>
          jsonResponse(
            respond ??
              waterDataFixture(
                `statistics-normals-${site}-${parameterCd}-${monthDay.replace('-', '')}.json`,
              ),
          ),
    { query: { monitoring_location_id: `USGS-${site}`, parameter_code: parameterCd } },
  );
}

function intervalsRoute(site: string, parameterCd: string, seriesId: string, respond?: unknown) {
  return statisticsRoute(
    'observationIntervals',
    typeof respond === 'function'
      ? (respond as () => Response)
      : () =>
          jsonResponse(
            respond ??
              waterDataFixture(
                `statistics-intervals-${site}-${parameterCd}-${seriesId.slice(0, 8)}.json`,
              ),
          ),
    { query: { monitoring_location_id: `USGS-${site}`, parent_time_series_id: seriesId } },
  );
}

type Published = Record<'p05' | 'p10' | 'p25' | 'p50' | 'p75' | 'p95', number | null>;

/** An `observationNormals` body (the captured shape) holding one daily-mean series' day. */
function normalsBody(seriesId: string, monthDay: string, t: Published) {
  const value = (v: number | null) => (v === null ? 'nan' : String(v));
  return {
    type: 'FeatureCollection',
    next: null,
    features: [
      {
        type: 'Feature',
        properties: {
          monitoring_location_id: 'USGS-01646500',
          data: [
            {
              parent_time_series_id: seriesId,
              parent_statistic_id: '00003',
              values: [
                {
                  time_of_year: monthDay,
                  time_of_year_type: 'day_of_year',
                  computation: 'percentile',
                  sample_count: 96,
                  approval_status: 'approved',
                  percentiles: ['5', '10', '25', '50', '75', '90', '95'],
                  values: [t.p05, t.p10, t.p25, t.p50, t.p75, null, t.p95].map(value),
                },
              ],
            },
          ],
        },
      },
    ],
  };
}

/** Approved June months for water years 1930–2025, in the `observationIntervals` shape. */
function juneIntervals(seriesId: string) {
  return {
    type: 'FeatureCollection',
    next: null,
    features: [
      {
        type: 'Feature',
        properties: {
          monitoring_location_id: 'USGS-01646500',
          data: [
            {
              parent_time_series_id: seriesId,
              parent_statistic_id: '00003',
              values: Array.from({ length: 96 }, (_, i) => ({
                start_date: `${1930 + i}-06-01`,
                end_date: `${1930 + i}-06-30`,
                interval_type: 'month',
                computation: 'arithmetic_mean',
              })),
            },
          ],
        },
      },
    ],
  };
}

/** A `time-series-metadata` page with one daily-mean series computed from `source`. */
function metadataPage(daily: string, source: string, sublocation: string | null = null) {
  return ogcPage([
    {
      type: 'Feature',
      id: daily,
      properties: {
        parent_time_series_id: source,
        sublocation_identifier: sublocation,
        web_description: null,
      },
      geometry: null,
    },
  ]);
}

const statisticsRequests = () =>
  water.requests.filter((r) => r.url.pathname.startsWith('/statistics/v0/'));

async function conditions(input: { parameterCd: string; site: string }, signal?: AbortSignal) {
  const result = await runToolContract(tool, input, signal ? { context: { signal } } : undefined);
  return {
    result,
    structured: result.structuredContent as Conditions,
    text: allText(result.content),
  };
}

describe('ranking against captured statistics', () => {
  it("ranks a discharge reading against its own sensor's daily mean (characterization)", async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({ values: [at('2026-11-11T02:50:00.000-05:00', '5000')] }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { result, structured, text } = await conditions({
      site: '01646500',
      parameterCd: '00060',
    });

    expect(result.isError).toBeFalsy();
    // WaterServices for 11-11: p05 1020 … p95 36200 (3 significant figures), 1931–2026.
    expect(structured).toMatchObject({
      currentValue: '5000',
      methodId: POTOMAC.source,
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'normal',
        percentileLabel: '25th–75th percentile',
        p05: 1015.6,
        p10: 1599,
        p25: 2257.5,
        p50: 3600,
        p75: 7545,
        p95: 36210,
        periodOfRecord: '1931–2026',
        comparisonBasis: COMPARISON_BASIS,
        statSeriesId: POTOMAC.daily,
        statSeriesDescription: null,
        methodMatched: true,
      },
    });
    expect(structured.note).toBeUndefined();
    expect(text).toContain(
      '**Condition:** normal — 25th–75th percentile | **Period of record:** 1931–2026',
    );
    expect(text).toContain('p05=1015.6 | p10=1599 | p25=2257.5 | p50=3600 | p75=7545 | p95=36210');
    expect(text).toContain(
      `**Percentile series:** (no description) | **Stat series ID:** ${POTOMAC.daily} | matched to the reported method — the daily mean of the sensor's own series`,
    );
    expect(water.requests.map((r) => r.url.pathname)).toEqual([
      '/ogcapi/v1/collections/monitoring-locations/items',
      '/ogcapi/v1/collections/time-series-metadata/items',
      '/statistics/v0/observationNormals',
      '/statistics/v0/observationIntervals',
    ]);
  });

  it('hands getReadings the call’s own request: the two-hour window and the caller’s signal', async () => {
    mockGetReadings.mockResolvedValue([]);
    water.route(...siteRoutes('01646500', '00060'));
    const controller = new AbortController();
    await conditions({ site: '01646500', parameterCd: '00060' }, controller.signal);
    expect(mockGetReadings).toHaveBeenCalledTimes(1);
    const [params, request] = mockGetReadings.mock.calls[0] ?? [];
    expect(params).toEqual({ sites: ['01646500'], parameterCds: ['00060'], period: 'PT2H' });
    expect(request).toMatchObject({ operation: 'water_get_conditions', signal: controller.signal });
    expect(request?.deadline.budgetMs).toBe(45_000);
  });

  it.each([
    ['40000', 'record-high', HIGH],
    ['900', 'record-low', LOW],
  ])('ranks discharge %s as %s, ascending as before', async (value, cls, label) => {
    mockGetReadings.mockResolvedValue([
      readingSeries({ values: [at('2026-11-11T02:50:00.000-05:00', value)] }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured.historicalContext).toMatchObject({
      percentileClass: cls,
      percentileLabel: label,
    });
  });
});

/**
 * #53: depth-to-water codes rank by water level. Each row is a well's reading on 2026-11-11 against
 * the thresholds the Statistics API published for that day; before this change the server ranked
 * the raw depth (record-high, record-high, below-normal on the WaterServices thresholds).
 */
describe('depth-to-water codes rank by water level (#53)', () => {
  it.each([
    {
      site: '322323106314701',
      source: '9ae2ce5bd34540c8ad6b394855489479',
      daily: '0d91e794e4a24e99abb3b363a75599ad',
      depth: '75.27',
      observed: '2026-11-11T00:00:00.000-07:00',
      cls: 'record-low',
      label: `${LOW}${DEPTH_LABEL}`,
      thresholds: { p05: 74.813, p10: 73.626, p25: 71.137, p50: 69.435, p75: 67.602, p95: 58.543 },
      periodOfRecord: '2000–2026',
    },
    {
      site: '394829074053503',
      source: '1ec15e4b3b6146ad9e5901b2ad79786c',
      daily: 'a6f5254c83bc486a86cac90282465b67',
      depth: '15.93',
      observed: '2026-11-11T03:15:00.000-05:00',
      cls: 'record-low',
      label: `${LOW}${DEPTH_LABEL}`,
      thresholds: { p05: 15.395, p10: 15.345, p25: 14.645, p50: 14.325, p75: 12.98, p95: 1.27 },
      periodOfRecord: '1974–2026',
    },
    {
      site: '414429074052001',
      source: 'bde0bb15e6f549cdb80d8f5f05825329',
      daily: '346545fa961f42db899790de432fcbee',
      depth: '24.99',
      observed: '2026-11-11T02:45:00.000-05:00',
      cls: 'above-normal',
      label: `75th–95th percentile${DEPTH_LABEL}`,
      thresholds: { p05: 28.844, p10: 28.114, p25: 27.595, p50: 26.19, p75: 25.065, p95: 23.022 },
      periodOfRecord: '2006–2026',
    },
  ])('ranks $depth ft at $site as $cls', async (row) => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: row.site,
        parameterCd: '72019',
        unitCode: 'ft',
        methodId: row.source,
        values: [at(row.observed, row.depth)],
      }),
    ]);
    water.route(
      ...siteRoutes(row.site, '72019'),
      normalsRoute(row.site, '72019', '11-11'),
      intervalsRoute(row.site, '72019', row.daily),
    );
    const { structured, text } = await conditions({ site: row.site, parameterCd: '72019' });

    expect(structured.currentValue).toBe(row.depth);
    expect(structured.historicalContext).toMatchObject({
      percentileClass: row.cls,
      percentileLabel: row.label,
      ...row.thresholds,
      periodOfRecord: row.periodOfRecord,
      statSeriesId: row.daily,
      methodMatched: true,
    });
    const basis = structured.historicalContext?.comparisonBasis ?? '';
    expect(basis.startsWith(COMPARISON_BASIS)).toBe(true);
    expect(basis).toContain('a depth below the surface, ranked as a water level');
    expect(basis).toContain('p95 is the shallowest of these depths and p05 the deepest');
    expect(text).toContain(`**Condition:** ${row.cls} — ${row.label} |`);
    expect(text).toContain(basis);
  });

  it('keeps p05 deeper than p95 at 401105074120201 and ranks a shallower depth higher', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: '401105074120201',
        parameterCd: '72019',
        methodId: '0081e4cc7cac4c79b12d49ead50aece2',
        values: [at('2026-11-10T08:00:00.000-05:00', '130.0')],
      }),
    ]);
    water.route(
      ...siteRoutes('401105074120201', '72019'),
      normalsRoute('401105074120201', '72019', '11-10'),
      intervalsRoute('401105074120201', '72019', 'ef4df5f138444f23bc58729959c31f0b'),
    );
    const { structured } = await conditions({ site: '401105074120201', parameterCd: '72019' });
    const context = structured.historicalContext;
    expect(context).toMatchObject({ p05: 144.428, p95: 127.045, periodOfRecord: '1989–2026' });
    expect(context?.p05).toBeGreaterThan(context?.p95 ?? Number.POSITIVE_INFINITY);
    // 130.0 ft is shallower than p75 (132.132 ft) but deeper than p95 (127.045 ft).
    expect(context?.percentileClass).toBe('above-normal');
  });

  it.each([
    ['18.5', 'normal', '25th–75th percentile'],
    ['21.0', 'record-high', HIGH],
    ['12.0', 'record-low', LOW],
  ])(
    'ranks an elevation code (62610) reading of %s ft as %s, as before',
    async (value, cls, label) => {
      mockGetReadings.mockResolvedValue([
        readingSeries({
          siteNumber: '404931073382101',
          parameterCd: '62610',
          methodId: '0655ef17e6f94b9bbf800bef5cd21580',
          values: [at('2026-11-10T10:00:00.000-05:00', value)],
        }),
      ]);
      water.route(
        ...siteRoutes('404931073382101', '62610'),
        normalsRoute('404931073382101', '62610', '11-10'),
        intervalsRoute('404931073382101', '62610', 'f2b89f59d6ae4037bca3de1b25cb3f8d'),
      );
      const { structured, text } = await conditions({
        site: '404931073382101',
        parameterCd: '62610',
      });
      expect(structured.historicalContext).toMatchObject({
        percentileClass: cls,
        percentileLabel: label,
        p05: 12.4,
        p95: 20.575,
        periodOfRecord: '1988–2026',
        comparisonBasis: COMPARISON_BASIS,
      });
      expect(text).not.toContain('water level');
    },
  );
});

/**
 * Classification through the assembled tool result, so class and label are asserted on both
 * structuredContent and content[]. The day's percentiles are served for the reading's sensor;
 * thresholds: p05 2000, p10 3000, p25 4500, p75 9000, p95 14000.
 */
describe('percentile classification', () => {
  type Threshold = 'p05' | 'p10' | 'p25' | 'p75' | 'p95';
  const KEYS: Threshold[] = ['p05', 'p10', 'p25', 'p75', 'p95'];
  const JUNE_4 = '2026-06-04T14:15:00.000-04:00';
  let served: { normals: unknown; parameterCd: string };

  beforeEach(() => {
    served = { normals: undefined, parameterCd: '00060' };
    water.route(
      ogcRoute('monitoring-locations', () =>
        jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
      ),
      ogcRoute('time-series-metadata', () =>
        jsonResponse(metadataPage(POTOMAC.daily, POTOMAC.source)),
      ),
      statisticsRoute('observationNormals', () => jsonResponse(served.normals)),
      statisticsRoute('observationIntervals', () => jsonResponse(juneIntervals(POTOMAC.daily))),
    );
  });

  async function classify(
    value: string,
    blank: Threshold[] = [],
    {
      parameterCd = '00060',
      thresholds = { p05: 2000, p10: 3000, p25: 4500, p75: 9000, p95: 14000 },
    } = {},
  ) {
    mockGetReadings.mockResolvedValue([
      readingSeries({ parameterCd, values: [at(JUNE_4, value)] }),
    ]);
    const t: Published = { ...thresholds, p50: 6000 };
    for (const key of blank) t[key] = null;
    served.normals = normalsBody(POTOMAC.daily, '06-04', t);
    const { result, structured, text } = await conditions({ site: '01646500', parameterCd });
    expect(result.isError).toBeFalsy();
    return {
      ...(structured.historicalContext ?? { percentileClass: '', percentileLabel: '' }),
      text,
    };
  }

  it.each([
    ['20000', 'record-high', HIGH],
    ['14000', 'record-high', HIGH],
    ['13999', 'above-normal', '75th–95th percentile'],
    ['9000', 'above-normal', '75th–95th percentile'],
    ['8999', 'normal', '25th–75th percentile'],
    ['4500', 'normal', '25th–75th percentile'],
    ['4499', 'below-normal', '10th–25th percentile'],
    ['3000', 'below-normal', '10th–25th percentile'],
    ['2999', 'low', '5th–10th percentile'],
    ['2000', 'low', '5th–10th percentile'],
    ['1999', 'record-low', LOW],
  ])('classifies %s against a fully published table as %s', async (value, cls, label) => {
    const { percentileClass, percentileLabel, text } = await classify(value);
    expect(percentileClass).toBe(cls);
    expect(percentileLabel).toBe(label);
    expect(text).toContain(`**Condition:** ${cls} — ${label} |`);
  });

  it.each<[string, Threshold[], string, string]>([
    // #44: a value outside p25–p75 is placed by the thresholds that are published.
    ['9500', ['p95'], 'above-normal', '≥ 75th percentile; 95th not published'],
    ['20000', ['p95'], 'above-normal', '≥ 75th percentile; 95th not published'],
    ['4000', ['p10'], 'below-normal', '< 25th percentile; 10th not published'],
    ['1000', ['p05', 'p10'], 'below-normal', '< 25th percentile; 10th not published'],
    ['2500', ['p05'], 'low', '< 10th percentile; 5th not published'],
    ['1000', ['p05'], 'low', '< 10th percentile; 5th not published'],
    // normal needs both quartiles; a value no published threshold can place is unknown.
    ['6000', ['p75'], 'unknown', '25th–95th percentile; 75th not published'],
    ['6000', ['p75', 'p95'], 'unknown', '≥ 25th percentile; 75th, 95th not published'],
    ['6000', ['p25'], 'unknown', '10th–75th percentile; 25th not published'],
    ['6000', ['p05', 'p10', 'p25'], 'unknown', '< 75th percentile; 5th, 10th, 25th not published'],
    ['6000', ['p05', 'p10', 'p25', 'p75', 'p95'], 'unknown', 'no percentile thresholds published'],
  ])('classifies %s with %j blank as %s', async (value, blank, cls, label) => {
    const { percentileClass, percentileLabel, text } = await classify(value, blank);
    expect(percentileClass).toBe(cls);
    expect(percentileLabel).toBe(label);
    expect(text).toContain(`**Condition:** ${cls} — ${label} |`);
  });

  it.each<[string, Threshold[], string, string]>([
    ['6000', ['p05', 'p10', 'p95'], 'normal', '25th–75th percentile'],
    ['20000', ['p75'], 'record-high', HIGH],
    ['1000', ['p10'], 'record-low', LOW],
  ])(
    'keeps %s with %j blank as %s, the published thresholds deciding',
    async (value, blank, cls, label) => {
      const { percentileClass, percentileLabel } = await classify(value, blank);
      expect(percentileClass).toBe(cls);
      expect(percentileLabel).toBe(label);
    },
  );

  it('keeps the label for a non-numeric reading unchanged', async () => {
    const { percentileClass, percentileLabel } = await classify('Ice');
    expect(percentileClass).toBe('unknown');
    expect(percentileLabel).toBe('insufficient percentile data');
  });

  /**
   * Depth thresholds in water-level order: p05 the deepest (20 ft) to p95 the shallowest (5 ft).
   * A depth at p95 is record-high; one at p05 is low, since only a depth deeper than p05 is
   * record-low.
   */
  const DEPTHS = { p05: 20, p10: 18, p25: 15, p75: 10, p95: 5 };

  it.each([
    ['4', 'record-high', HIGH],
    ['5', 'record-high', HIGH],
    ['5.01', 'above-normal', '75th–95th percentile'],
    ['10', 'above-normal', '75th–95th percentile'],
    ['12', 'normal', '25th–75th percentile'],
    ['15', 'normal', '25th–75th percentile'],
    ['16', 'below-normal', '10th–25th percentile'],
    ['18', 'below-normal', '10th–25th percentile'],
    ['19', 'low', '5th–10th percentile'],
    ['20', 'low', '5th–10th percentile'],
    ['20.01', 'record-low', LOW],
  ])('ranks a 72019 depth of %s ft as %s', async (value, cls, label) => {
    const { percentileClass, percentileLabel, text } = await classify(value, [], {
      parameterCd: '72019',
      thresholds: DEPTHS,
    });
    expect(percentileClass).toBe(cls);
    expect(percentileLabel).toBe(`${label}${DEPTH_LABEL}`);
    expect(text).toContain(`**Condition:** ${cls} — ${label}${DEPTH_LABEL} |`);
  });

  it.each(['30210', '99019', '72276'])(
    'ranks %s, another depth-below-surface code, in water-level order',
    async (parameterCd) => {
      // 4 ft is shallower than p95: record-high as a depth, where a rising code would read record-low.
      const { percentileClass, percentileLabel, text } = await classify('4', [], {
        parameterCd,
        thresholds: DEPTHS,
      });
      expect(percentileClass).toBe('record-high');
      expect(percentileLabel).toBe(`${HIGH}${DEPTH_LABEL}`);
      expect(text).toContain(`**Condition:** record-high — ${HIGH}${DEPTH_LABEL} |`);
    },
  );

  it.each<[string, Threshold[], string, string]>([
    ['8', ['p95'], 'above-normal', '≥ 75th percentile; 95th not published'],
    ['16', ['p10'], 'below-normal', '< 25th percentile; 10th not published'],
    ['19', ['p05'], 'low', '< 10th percentile; 5th not published'],
    ['12', ['p75'], 'unknown', '25th–95th percentile; 75th not published'],
  ])(
    'mirrors the blank-threshold rules for a depth of %s ft with %j blank',
    async (value, blank, cls, label) => {
      const { percentileClass, percentileLabel } = await classify(value, blank, {
        parameterCd: '72019',
        thresholds: DEPTHS,
      });
      expect(percentileClass).toBe(cls);
      expect(percentileLabel).toBe(`${label}${DEPTH_LABEL}`);
    },
  );

  /**
   * Every combination of blank thresholds (32) against a value at, between, and beyond each
   * threshold, for a rising code and for depth. The class must be one the published thresholds
   * prove; `unknown` must mean no published threshold decides; an open-ended class must name the
   * threshold it could not check.
   */
  describe('every combination of blank thresholds', () => {
    const COMBINATIONS = Array.from({ length: 2 ** KEYS.length }, (_, mask) =>
      KEYS.filter((_, i) => mask & (1 << i)),
    );
    const SCALES = [
      {
        parameterCd: '00060',
        thresholds: { p05: 2000, p10: 3000, p25: 4500, p75: 9000, p95: 14000 },
        values: [1000, 2000, 2500, 3000, 4000, 4500, 6000, 9000, 12000, 14000, 20000],
        level: (v: number) => v,
      },
      {
        parameterCd: '72019',
        thresholds: DEPTHS,
        values: [25, 20, 19, 18, 16, 15, 12, 10, 7, 5, 2],
        level: (v: number) => -v,
      },
    ];

    /** The class each published threshold set proves for a water level, independent of the tool. */
    function provable(
      v: number,
      blank: Threshold[],
      thresholds: Record<Threshold, number>,
      level: (v: number) => number,
    ): Record<string, boolean> {
      const t = (k: Threshold) => (blank.includes(k) ? null : level(thresholds[k]));
      const x = level(v);
      const below = (k: Threshold) => t(k) !== null && x < (t(k) as number);
      const atOrAbove = (k: Threshold) => t(k) !== null && x >= (t(k) as number);
      const notBelow = (k: Threshold) => t(k) === null || x >= (t(k) as number);
      return {
        'record-high': atOrAbove('p95'),
        'above-normal': atOrAbove('p75') && !atOrAbove('p95'),
        normal: atOrAbove('p25') && below('p75'),
        'below-normal': below('p25') && notBelow('p10') && notBelow('p05'),
        low: below('p10') && notBelow('p05'),
        'record-low': below('p05'),
      };
    }

    it.each(
      SCALES.flatMap((scale) =>
        COMBINATIONS.map((blank) => [scale.parameterCd, blank, scale] as const),
      ),
    )(
      'never places a %s value outside its band with %j blank',
      async (parameterCd, blank, scale) => {
        for (const v of scale.values) {
          const { percentileClass, percentileLabel } = await classify(String(v), blank, {
            parameterCd,
            thresholds: scale.thresholds,
          });
          const proven = provable(v, blank, scale.thresholds, scale.level);
          const decided = Object.entries(proven).filter(([, holds]) => holds);
          expect(decided.length, `value ${v}`).toBeLessThanOrEqual(1);
          if (percentileClass === 'unknown') {
            expect(decided, `value ${v} is decidable`).toEqual([]);
          } else {
            expect(proven[percentileClass], `value ${v} → ${percentileClass}`).toBe(true);
          }
          if (percentileClass === 'above-normal' && blank.includes('p95')) {
            expect(percentileLabel).toContain('95th not published');
          }
          if (percentileClass === 'below-normal' && blank.includes('p10')) {
            expect(percentileLabel).toContain('10th not published');
          }
          if (percentileClass === 'low' && blank.includes('p05')) {
            expect(percentileLabel).toContain('5th not published');
          }
          expect(percentileLabel.endsWith(DEPTH_LABEL)).toBe(parameterCd === '72019');
        }
      },
    );
  });
});

/**
 * The statistics day must be the observation's own calendar date — the date its site-local
 * timestamp already states. Converting through `Date` re-projects the instant into whatever
 * timezone the runner happens to be in and lands on a neighboring day near midnight.
 *
 * Each case below names June 28 and asserts the day the normals were requested for. The three
 * offsets are chosen so no runner timezone passes all three against a local-time lookup: the first
 * fails west of -04:00, the second east of it, and the third — a positive offset, which US
 * territory coverage reaches — fails everywhere but the far-eastern zones, closing the gap at
 * -04:00 itself where the first two coincidentally agree. UTC getters are no substitute either:
 * they resolve the first case and fail the third.
 */
describe('the statistics day follows the observation date, not the runtime timezone (#9)', () => {
  it.each([
    // 2026-06-28T04:50Z — a runner behind -04:00 (e.g. US Pacific) reads this back as June 27.
    ['just after midnight at -04:00', '2026-06-28T00:50:00.000-04:00'],
    // 2026-06-29T03:50Z — a runner ahead of -04:00 (e.g. UTC on CI) reads this forward as June 29.
    ['just before midnight at -04:00', '2026-06-28T23:50:00.000-04:00'],
    // 2026-06-27T14:30Z — Guam is a US territory. Every runner behind +09:30 reads it as June 27.
    ['just after midnight at +10:00', '2026-06-28T00:30:00.000+10:00'],
  ])('asks for June 28 for a reading %s', async (_case, dateTime) => {
    mockGetReadings.mockResolvedValue([readingSeries({ values: [at(dateTime, '6000')] })]);
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute(
        '01646500',
        '00060',
        '06-28',
        normalsBody(POTOMAC.daily, '06-28', {
          p05: 2000,
          p10: 3000,
          p25: 4500,
          p50: 4780,
          p75: 9000,
          p95: 14000,
        }),
      ),
      intervalsRoute('01646500', '00060', POTOMAC.daily, juneIntervals(POTOMAC.daily)),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    const normals = statisticsRequests().find((r) => r.url.pathname.endsWith('observationNormals'));
    expect(normals?.url.searchParams.get('start_date')).toBe('06-28');
    expect(normals?.url.searchParams.get('end_date')).toBe('06-28');
    expect(structured.historicalContext).toMatchObject({ p50: 4780, periodOfRecord: '1930–2025' });
  });
});

describe('a reading USGS reported as no data (#45)', () => {
  /** One sensor series whose latest record carries the given value and qualifiers. */
  function sensor(methodId: string, value: string, qualifiers: string[]) {
    return readingSeries({
      methodId,
      methodDescription: `sensor ${methodId.slice(0, 4)}`,
      values: [at('2026-11-11T02:50:00.000-05:00', value, qualifiers)],
    });
  }

  function routeCaptured() {
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
  }

  it('reports the missing reading as unknown and names its qualifiers on both surfaces', async () => {
    mockGetReadings.mockResolvedValue([sensor(POTOMAC.source, '', ['P', 'EQUIP'])]);
    routeCaptured();
    const { structured, text } = await conditions({ site: '01646500', parameterCd: '00060' });

    expect(structured.currentValue).toBe('');
    expect(structured.qualifiers).toEqual(['P', 'EQUIP']);
    expect(structured.historicalContext).toMatchObject({
      percentileClass: 'unknown',
      percentileLabel:
        'no value to rank — USGS reported no data for this reading (qualifiers: P, EQUIP)',
    });
    expect(structured.note).toBe(
      'USGS reported no value for the current reading (qualifiers: P, EQUIP), so it is not ranked. The qualifiers give the reason (e.g. seasonal, discontinued, dry, equipment malfunction).',
    );
    expect(text).toContain('**Current value:** no data [P,EQUIP]');
    expect(text).toContain(
      `**Condition:** unknown — ${structured.historicalContext?.percentileLabel}`,
    );
  });

  it("prefers another sensor's measured reading over a missing one at the same time", async () => {
    mockGetReadings.mockResolvedValue([
      sensor('11111111111111111111111111111111', '', ['P', 'DISCONTINUED']),
      sensor(POTOMAC.source, '6000', ['P']),
    ]);
    routeCaptured();
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      currentValue: '6000',
      methodId: POTOMAC.source,
      historicalContext: { percentileClass: 'normal', methodMatched: true },
    });
  });

  it('still reports the missing reading when no sensor carries a measurement', async () => {
    mockGetReadings.mockResolvedValue([
      sensor('11111111111111111111111111111111', '', ['P', 'DISCONTINUED']),
      sensor('22222222222222222222222222222222', '', ['P', 'SEASONAL']),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11', {
        type: 'FeatureCollection',
        features: [],
        next: null,
      }),
    );
    const { result, structured, text } = await conditions({
      site: '01646500',
      parameterCd: '00060',
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      currentValue: '',
      methodId: '11111111111111111111111111111111',
      qualifiers: ['P', 'DISCONTINUED'],
      historicalContext: null,
      historicalContextStatus: 'no_record',
    });
    expect(text).toContain('**Current value:** no data [P,DISCONTINUED]');
  });
});

describe('pairing the reporting sensor with a daily-mean series by ID (#43)', () => {
  const SONDE = {
    daily: '40bfcf380ef240e18699ee4875350640',
    source: 'd1875d1d73e447d2a1203105ba654e7d',
  };

  it('ranks the live sonde against its own daily mean beside four retired sensors', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        parameterCd: '00010',
        methodId: 'f60be489a22b4dfd9fd0fb97f3acc285',
        methodDescription: '1.0 ft from riverbed (bottom), [Discontinued]',
      }),
      readingSeries({
        parameterCd: '00010',
        methodId: SONDE.source,
        methodDescription: 'From multiparameter sonde',
        values: [at('2026-11-11T02:45:00.000-05:00', '12.0')],
      }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00010'),
      normalsRoute('01646500', '00010', '11-11'),
      intervalsRoute('01646500', '00010', SONDE.daily),
    );
    const { structured, text } = await conditions({ site: '01646500', parameterCd: '00010' });
    expect(structured).toMatchObject({
      currentValue: '12.0',
      methodId: SONDE.source,
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'normal',
        percentileLabel: '25th–75th percentile',
        p25: 10.05,
        p75: 14.925,
        p05: null,
        p95: null,
        periodOfRecord: '2020–2026',
        statSeriesId: SONDE.daily,
        statSeriesDescription: 'From multiparameter sonde',
        methodMatched: true,
      },
    });
    expect(text).toContain(
      `**Percentile series:** From multiparameter sonde | **Stat series ID:** ${SONDE.daily} | matched`,
    );
  });

  it('pairs the base gage with its own series where the two descriptions differ', async () => {
    // WaterServices matched these only by setting aside its "[BASE GAGE]" label (methodMatched
    // false); the ID chain pairs them exactly.
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: '12396500',
        parameterCd: '00065',
        methodId: 'dea67e89fcc54472ae9db8e097a637fb',
        values: [at('2026-11-10T12:00:00.000-08:00', '87.99')],
      }),
      readingSeries({
        siteNumber: '12396500',
        parameterCd: '00065',
        methodId: '1c9d1f64a6cd4093913ab88ec7c41991',
        methodDescription: 'AUXILIARY GAGE',
        values: [at('2026-11-10T12:00:00.000-08:00', '86.0')],
      }),
    ]);
    water.route(
      ...siteRoutes('12396500', '00065'),
      normalsRoute('12396500', '00065', '11-10'),
      intervalsRoute('12396500', '00065', 'f3f93cac0e144cd8b3b7ee826f0fc2b7'),
    );
    const { structured } = await conditions({ site: '12396500', parameterCd: '00065' });
    expect(structured).toMatchObject({
      currentValue: '87.99',
      methodId: 'dea67e89fcc54472ae9db8e097a637fb',
      historicalContext: {
        // 11-10 base-gage quartiles: p25 21.63, p75 88.9.
        percentileClass: 'normal',
        statSeriesId: 'f3f93cac0e144cd8b3b7ee826f0fc2b7',
        statSeriesDescription: '[BASE GAGE]',
        periodOfRecord: '1984–2026',
        methodMatched: true,
      },
    });
    expect(structured.note).toBeUndefined();
  });

  it('declines to rank when several series exist and none is the reporting sensor’s', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: '12396500',
        parameterCd: '00065',
        methodId: 'ffffffffffffffffffffffffffffffff',
        methodDescription: 'LEFT BANK',
        values: [at('2026-11-10T12:00:00.000-08:00', '87.99')],
      }),
    ]);
    water.route(...siteRoutes('12396500', '00065'), normalsRoute('12396500', '00065', '11-10'));
    const { structured, text } = await conditions({ site: '12396500', parameterCd: '00065' });

    expect(structured).toMatchObject({
      methodDescription: 'LEFT BANK',
      historicalContext: null,
      historicalContextStatus: 'no_matching_method',
    });
    expect(structured.note).toBe(
      "The statistics cover 2 daily-mean series at this site — AUXILIARY GAGE, [AUXILIARY GAGE] [series 81f6f58adb784d90bca74a02877600b8]; [BASE GAGE] [series f3f93cac0e144cd8b3b7ee826f0fc2b7] — and none is computed from the reported sensor's series (ffffffffffffffffffffffffffffffff), so no ranking is made rather than attributing another sensor's percentiles to this reading.",
    );
    expect(text).toContain('**Historical context status:** no_matching_method');
    expect(text).toContain(structured.note ?? '(missing note)');
  });

  it("ranks unmatched against the site's only series and says so", async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: '14233500',
        methodId: 'ffffffffffffffffffffffffffffffff',
        values: [at('2026-11-10T08:00:00.000-08:00', '674')],
      }),
    ]);
    water.route(
      ...siteRoutes('14233500', '00060'),
      normalsRoute('14233500', '00060', '11-10'),
      intervalsRoute('14233500', '00060', '06f3af03b3e24af6982de1c3ac16f299'),
    );
    const { structured, text } = await conditions({ site: '14233500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      historicalContextStatus: 'available',
      historicalContext: {
        percentileClass: 'record-low',
        statSeriesId: '06f3af03b3e24af6982de1c3ac16f299',
        periodOfRecord: '1948–2025',
        methodMatched: false,
      },
    });
    expect(structured.note).toBe(
      "Percentiles come from the only daily-mean series with percentiles for this day, (no description) [series 06f3af03b3e24af6982de1c3ac16f299], which is not computed from the reported sensor's series (ffffffffffffffffffffffffffffffff) — they may come from a different sensor or location than the reading.",
    );
    expect(text).toContain('not matched to the reported method');
  });

  it('takes the most recent reading when no sensor is paired', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        methodId: 'a'.repeat(32),
        values: [at('2026-11-11T02:00:00.000-05:00', '6000')],
      }),
      readingSeries({
        methodId: 'b'.repeat(32),
        values: [at('2026-11-11T02:15:00.000-05:00', '6100')],
      }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060', metadataPage(POTOMAC.daily, 'c'.repeat(32))),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      methodId: 'b'.repeat(32),
      historicalContext: { statSeriesId: POTOMAC.daily, methodMatched: false },
    });
  });

  it('prefers the sensor with a daily-mean series over a newer one without', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({ values: [at('2026-11-11T02:00:00.000-05:00', '6000')] }),
      readingSeries({
        methodId: 'b'.repeat(32),
        values: [at('2026-11-11T02:15:00.000-05:00', '6100')],
      }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      currentValue: '6000',
      methodId: POTOMAC.source,
      historicalContext: { methodMatched: true },
    });
  });

  it("takes the site's default sensor over a labeled one reading at the same instant, listed first", async () => {
    // Both gages have a daily mean; getReadings lists the auxiliary gage first (its ID sorts first).
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: '12396500',
        parameterCd: '00065',
        methodId: '1c9d1f64a6cd4093913ab88ec7c41991',
        methodDescription: 'AUXILIARY GAGE',
        values: [at('2026-11-10T18:00:00.000-08:00', '87.88')],
      }),
      readingSeries({
        siteNumber: '12396500',
        parameterCd: '00065',
        methodId: 'dea67e89fcc54472ae9db8e097a637fb',
        values: [at('2026-11-10T18:00:00.000-08:00', '89.12')],
      }),
    ]);
    water.route(
      ...siteRoutes('12396500', '00065'),
      normalsRoute('12396500', '00065', '11-10'),
      intervalsRoute('12396500', '00065', 'f3f93cac0e144cd8b3b7ee826f0fc2b7'),
    );
    const { structured } = await conditions({ site: '12396500', parameterCd: '00065' });
    expect(structured).toMatchObject({
      currentValue: '89.12',
      methodId: 'dea67e89fcc54472ae9db8e097a637fb',
      methodDescription: null,
      historicalContext: { statSeriesId: 'f3f93cac0e144cd8b3b7ee826f0fc2b7', methodMatched: true },
    });
  });

  it('keeps response order between two labeled sensors reading at the same instant', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        methodId: 'a'.repeat(32),
        methodDescription: 'LEFT BANK',
        values: [at('2026-11-11T02:00:00.000-05:00', '6000')],
      }),
      readingSeries({
        methodId: 'b'.repeat(32),
        methodDescription: 'RIGHT BANK',
        values: [at('2026-11-11T02:00:00.000-05:00', '6100')],
      }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060', metadataPage(POTOMAC.daily, 'c'.repeat(32))),
      normalsRoute('01646500', '00060', '11-11'),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      currentValue: '6000',
      methodId: 'a'.repeat(32),
      methodDescription: 'LEFT BANK',
    });
  });
});

describe('statuses without a ranking', () => {
  it('reports no_record for a well whose only normals are of daily maxima', async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({
        siteNumber: '261620081464402',
        parameterCd: '62610',
        methodId: 'a'.repeat(32),
        values: [at('2026-11-10T08:00:00.000-05:00', '3.0')],
      }),
    ]);
    water.route(
      ...siteRoutes('261620081464402', '62610'),
      normalsRoute('261620081464402', '62610', '11-10'),
    );
    const { structured, text } = await conditions({
      site: '261620081464402',
      parameterCd: '62610',
    });
    expect(structured).toMatchObject({
      currentValue: '3.0',
      historicalContext: null,
      historicalContextStatus: 'no_record',
    });
    expect(structured.note).toBe(
      'No historical daily-mean percentiles are published for this site and parameter on this calendar day. The record may be too new or too short to compute them, or this parameter has no daily-mean statistics here (some series carry only daily maximum or minimum statistics).',
    );
    expect(text).toContain('**Condition:** No historical context available.');
    expect(text).toContain('**Historical context status:** no_record');
  });

  it("reports no_matching_day when the sensor's series has a record but not that day", async () => {
    mockGetReadings.mockResolvedValue([
      readingSeries({ values: [at('2026-06-28T12:00:00.000-04:00', '6000')] }),
    ]);
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '06-28', {
        type: 'FeatureCollection',
        features: [],
        next: null,
      }),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      currentValue: '6000',
      historicalContext: null,
      historicalContextStatus: 'no_matching_day',
      note: "The reported sensor's daily-mean series has an approved record, but no percentiles for the observation's calendar day.",
    });
  });
});

/** #20: a statistics failure returns the reading with "unavailable", never a sparse-record status. */
describe('a statistics failure keeps the reading', () => {
  const reading = () =>
    mockGetReadings.mockResolvedValue([
      readingSeries({ values: [at('2026-11-11T02:50:00.000-05:00', '5000')] }),
    ]);

  it('reports unavailable with the upstream reason when the normals request is rejected', async () => {
    reading();
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute(
        '01646500',
        '00060',
        '11-11',
        () =>
          new Response('400 - Bad request', {
            status: 400,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { result, structured, text } = await conditions({
      site: '01646500',
      parameterCd: '00060',
    });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      currentValue: '5000',
      historicalContext: null,
      historicalContextStatus: 'unavailable',
    });
    expect(structured.note).toBe(
      "Historical percentile context could not be retrieved — the statistics service call failed. USGS Water Data Statistics API rejected the request: Bad request This is an upstream failure, not a statement about the site's record; call again later for the ranking.",
    );
    expect(structured.note).not.toContain('too new');
    expect(text).toContain('**Historical context status:** unavailable');
    expect(text).toContain('statistics service call failed');
  });

  it('reports unavailable when the series metadata fails, sending no statistics request', async () => {
    reading();
    water.route(
      ...siteRoutes('01646500', '00060', undefined).slice(0, 1),
      ogcRoute('time-series-metadata', () =>
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured).toMatchObject({
      currentValue: '5000',
      historicalContextStatus: 'unavailable',
    });
    expect(structured.note).toContain('USGS Water Data OGC API rejected the request');
    expect(statisticsRequests()).toEqual([]);
  });

  it('reports a statistics rate limit as unavailable with its wait', async () => {
    reading();
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11', () => rateLimitResponse(1800, 4000)),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const { structured } = await conditions({ site: '01646500', parameterCd: '00060' });
    expect(structured.historicalContextStatus).toBe('unavailable');
    expect(structured.note).toContain(
      'USGS Water Data Statistics API rate limit reached (OVER_RATE_LIMIT). The limit is 4000 requests per hour per IP address without an API key. Retry after 1800 s.',
    );
    expect(
      statisticsRequests().filter((r) => r.url.pathname.endsWith('observationNormals')),
    ).toHaveLength(1);
  });

  it('spends one budget across the reading and the statistics', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    // The reading takes 44 of the call's 45 seconds; each statistics request would stall far past
    // the second that is left.
    mockGetReadings.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 44_000);
      return [readingSeries({ values: [at('2026-11-11T02:50:00.000-05:00', '5000')] })];
    });
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11', stalled),
      intervalsRoute('01646500', '00060', POTOMAC.daily, stalled),
    );
    let settled = false;
    const pending = conditions({ site: '01646500', parameterCd: '00060' }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(settled).toBe(true);
    const { structured } = await pending;
    expect(structured).toMatchObject({
      currentValue: '5000',
      historicalContextStatus: 'unavailable',
    });
    expect(structured.note).toContain(
      'water_get_conditions ran out of the 45000 ms budget for this call after 1 attempt.',
    );
    expect(
      statisticsRequests().filter((r) => r.url.pathname.endsWith('observationNormals')),
    ).toHaveLength(1);
  });

  it('rethrows caller cancellation during the statistics instead of reporting unavailable', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    reading();
    water.route(
      ...siteRoutes('01646500', '00060'),
      normalsRoute('01646500', '00060', '11-11', stalled),
      intervalsRoute('01646500', '00060', POTOMAC.daily),
    );
    const controller = new AbortController();
    const pending = conditions({ site: '01646500', parameterCd: '00060' }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(statisticsRequests()).toHaveLength(2);
    controller.abort(new DOMException('Caller cancelled conditions', 'AbortError'));
    const { result, text } = await pending;

    const message = 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.';
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message },
    });
    expect(text).toContain(message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statisticsRequests()).toHaveLength(2);
  });
});

describe('reading failures', () => {
  beforeEach(() => {
    water.route(...siteRoutes('01646500', '00060'));
  });

  it('maps an upstream 5xx on the reading to upstream_error', async () => {
    mockGetReadings.mockRejectedValue(
      serviceUnavailable('USGS Water Data OGC API answered HTTP 503.', {
        reason: 'upstream_error',
      }),
    );
    await expect(
      contractError(tool, { site: '01646500', parameterCd: '00060' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'USGS Water Data OGC API answered HTTP 503.',
      data: { reason: 'upstream_error', recovery: recovery('upstream_error') },
    });
  });

  it('maps an upstream rejection to invalid_request, keeping its stated reason', async () => {
    mockGetReadings.mockRejectedValue(
      validationError(
        'USGS Water Data OGC API rejected the request: The requested time envelope is too large.',
        { reason: 'invalid_request', upstreamStatus: 400 },
      ),
    );
    await expect(
      contractError(tool, { site: '01646500', parameterCd: '00060' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: expect.stringContaining('time envelope is too large'),
      data: { reason: 'invalid_request', recovery: recovery('invalid_request') },
    });
  });

  it('maps a spent budget to upstream_timeout, keeping its retry diagnostics', async () => {
    mockGetReadings.mockRejectedValue(
      timeout(
        'water_get_conditions ran out of the 45000 ms budget for this call after 4 attempts.',
        {
          reason: 'retry_deadline_exceeded',
          deadlineMs: 45_000,
          retryAttempts: 4,
          operation: 'water_get_conditions',
        },
      ),
    );
    await expect(
      contractError(tool, { site: '01646500', parameterCd: '00060' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: {
        reason: 'upstream_timeout',
        retryAttempts: 4,
        operation: 'water_get_conditions',
        recovery: recovery('upstream_timeout'),
      },
    });
  });

  it('passes a rate limit through with its wait', async () => {
    mockGetReadings.mockRejectedValue(
      rateLimited(
        'USGS Water Data OGC API rate limit reached (OVER_RATE_LIMIT). Retry after 600 s.',
        {
          reason: 'rate_limited',
          retryAfter: 600,
        },
      ),
    );
    await expect(
      contractError(tool, { site: '01646500', parameterCd: '00060' }),
    ).resolves.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: 600 },
    });
  });

  it('rethrows an unclassified reading error rather than guessing a reason', async () => {
    mockGetReadings.mockRejectedValue(new TypeError('fetch failed'));
    const error = await contractError(tool, { site: '01646500', parameterCd: '00060' });
    expect(error.message).toBe('fetch failed');
    expect(error.data?.reason).toBeUndefined();
  });
});

/** #52: the recovery and both messages send the caller to the catalog, never to water_find_sites. */
describe('no_data_for_parameter', () => {
  it('declares a recovery naming the catalog and a longer readings period', () => {
    const { hint } = recovery('no_data_for_parameter');
    expect(hint).toBe(
      'Call water_get_site_data_catalog for the site: not_found means no such site, an empty series list means the parameter was never measured there, and endDate gives the last report. For a gage silent only in the last two hours, call water_get_readings with a longer period.',
    );
    const contract = JSON.stringify(tool.errors);
    expect(contract).not.toContain('water_find_sites');
  });

  it('names the catalog and a longer period when a known site returns no series', async () => {
    mockGetReadings.mockResolvedValue([]);
    water.route(...siteRoutes('01646500', '00060'));
    const error = await contractError(tool, { site: '01646500', parameterCd: '00060' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message:
        'No 00060 data came back for site 01646500 in the last 2 hours — the site may never have measured this parameter, or reported nothing in that window. water_get_site_data_catalog tells them apart (an empty series list: never measured; endDate: the last report), and water_get_readings with a longer period returns the latest value of a gage silent only in the last two hours.',
      data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
    });
  });

  it('says the site does not exist when no location has the number', async () => {
    mockGetReadings.mockResolvedValue([]);
    water.route(
      ogcRoute('monitoring-locations', () =>
        jsonResponse(waterDataFixture('monitoring-locations-conditions-sites.json')),
      ),
    );
    const { result, text } = await conditions({ site: '99999999', parameterCd: '00060' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message:
          'No USGS monitoring location has site number 99999999. Check the number: water_get_site_data_catalog answers not_found for a site that does not exist.',
        data: { reason: 'no_data_for_parameter' },
      },
    });
    expect(text).toContain(recovery('no_data_for_parameter').hint);
    expect(water.requests).toHaveLength(1);
  });

  it('keeps every possibility open when the site lookup itself failed', async () => {
    mockGetReadings.mockResolvedValue([]);
    water.route(
      ogcRoute(
        'monitoring-locations',
        () =>
          new Response('400 - Bad request', {
            status: 400,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );
    const error = await contractError(tool, { site: '01646500', parameterCd: '00060' });
    expect(error.message).toContain(
      'the site may not exist, may never have measured this parameter',
    );
    expect(error.message).toContain('not_found: no such site');
  });

  it('names a longer readings period when the series reported nothing in two hours', async () => {
    mockGetReadings.mockResolvedValue([readingSeries({ values: [] })]);
    water.route(...siteRoutes('01646500', '00060'));
    const error = await contractError(tool, { site: '01646500', parameterCd: '00060' });
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message:
        "No reading for site 01646500 parameter 00060 in the last 2 hours — the site reports this parameter but sent no value in that window. Call water_get_readings with a longer period for its latest value; water_get_site_data_catalog gives the series' endDate, its last report.",
      data: { reason: 'no_data_for_parameter', recovery: recovery('no_data_for_parameter') },
    });
    expect(statisticsRequests()).toEqual([]);
  });
});

describe('format', () => {
  const base = {
    siteNumber: '01646500',
    siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
    parameterCd: '00060',
    parameterName: 'Discharge, cubic feet per second',
    unitCode: 'ft3/s',
    methodId: POTOMAC.source,
    methodDescription: null,
    currentValue: '6000',
    currentDateTime: '2026-11-11T02:50:00.000-05:00',
    qualifiers: ['A'],
  };

  it('renders the reading, the class, every threshold, and the series pairing', () => {
    const text = textContent(
      tool.format?.({
        ...base,
        historicalContext: {
          percentileClass: 'normal',
          percentileLabel: '25th–75th percentile',
          p05: 2000,
          p10: 3000,
          p25: 4500,
          p50: 6000,
          p75: 9000,
          p95: 14000,
          periodOfRecord: '1931–2026',
          comparisonBasis: 'instantaneous reading ranked against daily-mean percentiles',
          statSeriesId: POTOMAC.daily,
          statSeriesDescription: null,
          methodMatched: true,
        },
        historicalContextStatus: 'available',
        note: undefined,
      })[0],
    );
    expect(text).toContain('### POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA (01646500)');
    expect(text).toContain(`**Method:** (no description) | **Method ID:** ${POTOMAC.source}`);
    expect(text).toContain('**Current value:** 6000 ft3/s [A]');
    expect(text).toContain(
      '**Condition:** normal — 25th–75th percentile | **Period of record:** 1931–2026',
    );
    expect(text).toContain('p05=2000 | p10=3000 | p25=4500 | p50=6000 | p75=9000 | p95=14000');
    expect(text).toContain('*instantaneous reading ranked against daily-mean percentiles*');
    expect(text).toContain(`**Stat series ID:** ${POTOMAC.daily}`);
    expect(text).toContain('**Historical context status:** available');
  });

  it('renders a null historicalContext with its status and note', () => {
    const text = textContent(
      tool.format?.({
        ...base,
        historicalContext: null,
        historicalContextStatus: 'unavailable',
        note: 'Historical percentile context could not be retrieved.',
      })[0],
    );
    expect(text).toContain('**Condition:** No historical context available.');
    expect(text).toContain('**Historical context status:** unavailable');
    expect(text).toContain('*Historical percentile context could not be retrieved.*');
  });
});

describe('input validation', () => {
  it('rejects a non-numeric site before any request', () => {
    expect(() => tool.input.parse({ site: 'abc', parameterCd: '00060' })).toThrow();
    expect(mockGetReadings).not.toHaveBeenCalled();
    expect(water.requests).toEqual([]);
  });

  it('rejects a site number outside 8–15 digits', () => {
    expect(() => tool.input.parse({ site: '1646500', parameterCd: '00060' })).toThrow();
    expect(() => tool.input.parse({ site: '0164650012345678', parameterCd: '00060' })).toThrow();
  });

  it('rejects a parameter code that is not exactly 5 digits', () => {
    for (const parameterCd of ['x', '0006', '000600']) {
      expect(() => tool.input.parse({ site: '01646500', parameterCd })).toThrow();
    }
  });

  it('accepts a well-formed site and parameter', () => {
    expect(() => tool.input.parse({ site: '01646500', parameterCd: '00060' })).not.toThrow();
  });
});

/**
 * @fileoverview water_get_series end to end over captured USGS Water Data responses: the tool
 * handler, the observations service, the site resolver, the parameter and statistic-code
 * catalogs, and the request core all run for real; only `fetch` is faked. Each route answers from
 * captured `daily`, `continuous`, and `time-series-metadata` bodies with the features the
 * request's own query selects — site, parameter, statistic, and time window — as the upstream
 * does. DataCanvas stays disabled here; staging and table naming are covered in
 * water-get-series.tool.test.ts.
 * @module tests/tools/water-get-series.upstream.test
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

type SeriesTool =
  typeof import('@/mcp-server/tools/definitions/water-get-series.tool.js')['waterGetSeries'];

type Value = { dateTime: string; qualifiers: string[]; value: string };
type OtherSeries = {
  methodDescription: string | null;
  methodId: string | null;
  recordCount: number;
  statCd: string;
  statName: string | null;
};
type Series = {
  methodDescription: string | null;
  methodId: string | null;
  otherSeries: OtherSeries[];
  statCd: string;
  statName: string | null;
  totalRecords: number;
  truncated: boolean;
  values: Value[];
};

type Feature = { id: string; properties: Record<string, unknown> };
type Collection = { features: Feature[] };

const capture = (name: string) => JSON.parse(waterDataFixture(name)) as Collection;
const merged = (...names: string[]): Collection => ({
  features: names.flatMap((name) => capture(name).features),
});

/** Captured locations of eight sites, 01646500 and 11176400 among them. */
const LOCATIONS = capture('observations-resolver-readings.json');
/** 01646500 daily water temperature (15 series, 2019-09-01..05) and discharge (2024-01-01..10). */
const DAILY_00060 = capture('observations-daily-01646500-00060-20240101-10.json');
const META_00060 = capture('observations-tsm-daily-01646500-00060.json');
const DAILY = merged(
  'observations-daily-01646500-00010-20190901-05.json',
  'observations-daily-01646500-00060-20240101-10.json',
);
const DAILY_META = merged(
  'observations-tsm-daily-01646500-00010.json',
  'observations-tsm-daily-01646500-00060.json',
);
/** Points series of the eight sites, and their `continuous` rows: the two hours to 2026-11-11T09:50Z, plus 01646500 discharge across the 2026-11-01 fall-back. */
const POINTS = capture('observations-tsm-readings-points.json');
const CONTINUOUS = merged(
  'observations-continuous-readings-PT2H.json',
  'observations-continuous-01646500-00060-dst-fall.json',
);

/** 01646500 daily series (OGC time_series_id) the assertions name. */
const DISCHARGE_MEAN = '2cf409b0d9694c01828f5d4ff14586a5';
const TEMPERATURE = {
  meanTop: '262b35c5fc68445bb9d84990eb7b7bb3',
  meanMiddle: '6f2cdd6644424eb188a29a5dcc098a76',
  meanBottom: 'e7b2e294e6ff4b37823201aa90adb381',
  meanSondeRetired: '7fb9204b83544455ada0bd8c8f441cce',
  meanSonde: '40bfcf380ef240e18699ee4875350640',
  maxMiddle: 'd79cffc85456491db8f5e416a62c369e',
} as const;

const TEMPERATURE_2019 = {
  site: '01646500',
  parameterCd: '00010',
  startDate: '2019-09-01',
  endDate: '2019-09-05',
} as const;

const DISCHARGE_2024 = {
  site: '01646500',
  parameterCd: '00060',
  startDate: '2024-01-01',
  endDate: '2024-01-10',
} as const;

const EQUALITY_FILTERS = ['monitoring_location_id', 'parameter_code', 'statistic_id'] as const;

/** Whether a row's `time` (a date or an instant) falls in a `from/to` window, bounds included. */
function inWindow(time: string, window: string): boolean {
  const [from = '', to = ''] = window.split('/');
  if (from.length === 10) return time >= from && time <= to;
  const at = Date.parse(time);
  return at >= Date.parse(from) && at <= Date.parse(to);
}

/** The features of `body` a request's site, parameter, statistic, and `time` filters select. */
function selected(body: Collection, query: URLSearchParams): Feature[] {
  const time = query.get('time');
  return body.features.filter(
    (f) =>
      EQUALITY_FILTERS.every((key) => !query.has(key) || f.properties[key] === query.get(key)) &&
      (time === null || inWindow(String(f.properties['time']), time)),
  );
}

const answeredFrom = (collection: string, body: Collection, query: QueryMatch = {}) =>
  ogcRoute(
    collection,
    (request) => jsonResponse(ogcPage(selected(body, new URL(request.url).searchParams))),
    { query },
  );

/**
 * Two sites measured by hand, as `monitoring-locations` lists them: well 400954074302001 (live
 * capture) and well 450250105010901, whose one 1958 record states only the year.
 */
const MEASURED_SITES: Feature[] = [
  {
    id: 'USGS-400954074302001',
    properties: {
      monitoring_location_number: '400954074302001',
      monitoring_location_name: '250790-- Imlaystown MW1',
      agency_code: 'USGS',
      time_zone_abbreviation: 'EST',
      uses_daylight_savings: 'Y',
    },
  },
  {
    id: 'USGS-450250105010901',
    properties: {
      monitoring_location_number: '450250105010901',
      monitoring_location_name: null,
      agency_code: 'USGS',
      time_zone_abbreviation: 'MST',
      uses_daylight_savings: 'Y',
    },
  },
];

/** `monitoring-locations` for a number list: the captured locations it names. */
const locationsRoute = () =>
  ogcRoute('monitoring-locations', (request) => {
    const asked = new Set(
      new URL(request.url).searchParams.get('monitoring_location_number')?.split(','),
    );
    return jsonResponse(
      ogcPage(
        [...LOCATIONS.features, ...MEASURED_SITES].filter((f) =>
          asked.has(String(f.properties['monitoring_location_number'])),
        ),
      ),
    );
  });

/** Field measurements of well 400954074302001 (six each of 72019, 62610, 62611) and their series. */
const WELL_FIELD = capture('field-measurements-400954074302001.json');
const WELL_FIELD_META = capture('field-measurements-metadata-400954074302001.json');
/** 01646500 gage height measured in 2025, two reading types, and the site's field series. */
const GAGE_FIELD = capture('field-measurements-01646500-00065-2025.json');
const GAGE_FIELD_META = capture('field-measurements-metadata-01646500.json');
/** Field records dated by year or year and month alone, across sites. */
const PARTIAL_DATES = capture('field-measurements-day-null.json');
/** The 2025 annual peak of 01646500 discharge, and its series (live capture, trimmed). */
const PEAKS_2025 = capture('peaks-01646500-00060-wy2025.json');
const PEAK_META: Collection = {
  features: [
    {
      id: '51a7ecee083843328f6609518990e022',
      properties: {
        monitoring_location_id: 'USGS-01646500',
        parameter_code: '00060',
        statistic_id: null,
        begin: '1931-04-03T05:00:00+00:00',
        sublocation_identifier: null,
        web_description: null,
        unit_of_measure: 'ft^3/s',
        parameter_name: 'Discharge',
        computation_period_identifier: 'Water Year',
        computation_identifier: 'Max At Event Time',
      },
    },
  ],
};

/** The 72019 field series of well 400954074302001 and the 01646500 gage-height field series. */
const FIELD_IDS = {
  wellDepth: '4270d483-4184-4046-9d76-67ee60ca7a35',
  staffGage: '69cf03cd-7795-4b55-9550-ef69dd8fe9c1',
  meanGage: 'c141575d-9f1d-42ce-aa4a-0584728735ce',
} as const;

/** Every route a field call reads, answering from `rows` and `metadata`. */
const fieldUpstream = (rows: Collection, metadata: Collection) => [
  locationsRoute(),
  answeredFrom('field-measurements-metadata', metadata),
  answeredFrom('field-measurements', rows),
  catalogRoute(),
];

const catalogRoute = () =>
  ogcRoute('parameter-codes', () =>
    jsonResponse(waterDataFixture('observations-parameter-codes.json')),
  );
const statisticCodesRoute = () =>
  ogcRoute('statistic-codes', () =>
    jsonResponse(waterDataFixture('observations-statistic-codes.json')),
  );

const dailyMetadataRoute = (body: Collection = DAILY_META) =>
  answeredFrom('time-series-metadata', body, { computation_period_identifier: 'Daily' });

/** Every route a daily call reads. */
const dailyUpstream = () => [
  locationsRoute(),
  answeredFrom('daily', DAILY),
  dailyMetadataRoute(),
  catalogRoute(),
  statisticCodesRoute(),
];

/** The routes of a daily call whose `daily` read answers with `respond` instead. */
const dailyAnswering = (respond: Parameters<typeof ogcRoute>[1]) => [
  locationsRoute(),
  ogcRoute('daily', respond),
  dailyMetadataRoute(),
  catalogRoute(),
  statisticCodesRoute(),
];

/** Every route an instantaneous call reads. */
const instantaneousUpstream = () => [
  locationsRoute(),
  answeredFrom('time-series-metadata', POINTS, { computation_period_identifier: 'Points' }),
  answeredFrom('continuous', CONTINUOUS),
  catalogRoute(),
];

let tool: SeriesTool;
let water: WaterDataFake;

/** A fresh module graph per test: empty site and code caches, an open rate-limit gate. */
beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  ({ waterGetSeries: tool } = await import(
    '@/mcp-server/tools/definitions/water-get-series.tool.js'
  ));
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

async function series(input: Record<string, unknown>, signal?: AbortSignal) {
  const result = await runToolContract(
    tool,
    input as never,
    signal ? { context: { signal } } : undefined,
  );
  return {
    result,
    structured: result.structuredContent as Series,
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

describe('water_get_series over captured Water Data responses', () => {
  it('returns a single daily series whole (characterization)', async () => {
    water.route(...dailyUpstream());
    const { result, structured, text } = await series(DISCHARGE_2024);

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      parameterCd: '00060',
      parameterName: 'Discharge, cubic feet per second',
      unitCode: 'ft3/s',
      seriesType: 'daily',
      statCd: '00003',
      statName: 'Mean',
      methodId: DISCHARGE_MEAN,
      methodDescription: null,
      totalRecords: 10,
      truncated: false,
      otherSeries: [],
    });
    expect(structured.values.map((v) => v.value)).toEqual([
      '8930',
      '7760',
      '6860',
      '6050',
      '5430',
      '5480',
      '7410',
      '6380',
      '9460',
      '39000',
    ]);
    expect(structured.values[0]).toEqual({
      dateTime: '2024-01-01T00:00:00.000',
      value: '8930',
      qualifiers: ['A'],
    });

    expect(text).toContain('### POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA (01646500)');
    expect(text).toContain(
      '**Parameter:** Discharge, cubic feet per second (00060) | **Unit:** ft3/s',
    );
    expect(text).toContain('**Series type:** daily | **Total records:** 10');
    expect(text).toContain(
      `**Statistic:** Mean (statCd 00003) | **Method:** (no description) | **Method ID:** ${DISCHARGE_MEAN}`,
    );
    expect(text).toContain('- 2024-01-10T00:00:00.000: **39000** ft3/s [A]');

    const [daily] = sentTo('daily');
    expect(daily?.url.searchParams.get('time')).toBe('2024-01-01/2024-01-10');
    expect(daily?.url.searchParams.has('statistic_id')).toBe(false);
  });

  it('costs five requests cold and two once the site and code caches are warm', async () => {
    water.route(...dailyUpstream());

    expect((await series(DISCHARGE_2024)).result.isError).toBeFalsy();
    expect(collectionsSent()).toEqual([
      'daily',
      'monitoring-locations',
      'parameter-codes',
      'statistic-codes',
      'time-series-metadata',
    ]);

    const before = water.requests.length;
    expect((await series(DISCHARGE_2024)).result.isError).toBeFalsy();
    expect(collectionsSent(before)).toEqual(['daily', 'time-series-metadata']);
  });

  describe('statistic and method selection (#43)', () => {
    it('returns the daily mean by default, a tie going to the series that began first', async () => {
      // Every mean sensor holds 5 records; the top sensor's series began first (1988).
      water.route(...dailyUpstream());
      const { structured, text } = await series(TEMPERATURE_2019);

      expect(structured).toMatchObject({
        parameterName: 'Temperature, water, degrees Celsius',
        unitCode: 'deg C',
        statCd: '00003',
        statName: 'Mean',
        methodId: TEMPERATURE.meanTop,
        methodDescription: '7.1 ft from riverbed (top), [Discontinued]',
        totalRecords: 5,
      });
      expect(structured.values.map((v) => v.value)).toEqual([
        '26.5',
        '26.6',
        '26.6',
        '27.1',
        '27.5',
      ]);

      expect(text).toContain(
        `**Statistic:** Mean (statCd 00003) | **Method:** 7.1 ft from riverbed (top), [Discontinued] | **Method ID:** ${TEMPERATURE.meanTop}`,
      );
      expect(text).toContain('- 2019-09-01T00:00:00.000: **26.5** deg C [A]');
    });

    it('lists every other statistic × method, empty series included, on both surfaces', async () => {
      water.route(...dailyUpstream());
      const { structured, text } = await series(TEMPERATURE_2019);

      const others = structured.otherSeries;
      expect(others).toHaveLength(14);
      expect(others.map((s) => s.statCd)).toEqual([
        ...Array<string>(5).fill('00001'),
        ...Array<string>(5).fill('00002'),
        ...Array<string>(4).fill('00003'),
      ]);
      expect(others).toContainEqual({
        statCd: '00003',
        statName: 'Mean',
        methodId: TEMPERATURE.meanSonde,
        methodDescription: 'From multiparameter sonde',
        recordCount: 5,
      });
      // The retired sonde holds nothing in 2019 and still comes back.
      expect(others).toContainEqual({
        statCd: '00003',
        statName: 'Mean',
        methodId: TEMPERATURE.meanSondeRetired,
        methodDescription: 'From multiparameter sonde, [Discontinued]',
        recordCount: 0,
      });
      expect(others).toContainEqual(
        expect.objectContaining({
          statCd: '00001',
          statName: 'Maximum',
          methodId: TEMPERATURE.maxMiddle,
        }),
      );
      expect(others.filter((s) => s.statCd === '00002').map((s) => s.statName)).toEqual(
        Array<string>(5).fill('Minimum'),
      );

      expect(text).toContain(
        `Mean (statCd 00003), From multiparameter sonde (methodId ${TEMPERATURE.meanSonde}), 5 records`,
      );
      expect(text).toContain(
        `Mean (statCd 00003), From multiparameter sonde, [Discontinued] (methodId ${TEMPERATURE.meanSondeRetired}), 0 records`,
      );
    });

    it('forwards statCd upstream and returns the series the methodId names', async () => {
      water.route(...dailyUpstream());
      const { structured, text } = await series({
        ...TEMPERATURE_2019,
        statCd: '00003',
        methodId: TEMPERATURE.meanSonde,
      });

      expect(structured).toMatchObject({
        statCd: '00003',
        methodId: TEMPERATURE.meanSonde,
        methodDescription: 'From multiparameter sonde',
      });
      // The values WaterServices served for the same sonde (its method 300173).
      expect(structured.values.map((v) => v.value)).toEqual([
        '26.6',
        '26.9',
        '26.9',
        '27.6',
        '27.6',
      ]);
      expect(structured.otherSeries.map((s) => s.methodId)).toEqual([
        TEMPERATURE.meanTop,
        TEMPERATURE.meanMiddle,
        TEMPERATURE.meanBottom,
        TEMPERATURE.meanSondeRetired,
      ]);
      expect(text).toContain(`statCd=00003, methodId=${TEMPERATURE.meanSonde}`);
      for (const collection of ['daily', 'time-series-metadata']) {
        expect(sentTo(collection)[0]?.url.searchParams.get('statistic_id')).toBe('00003');
      }
    });

    it('resolves a series of another statistic from its methodId alone', async () => {
      water.route(...dailyUpstream());
      const { structured } = await series({ ...TEMPERATURE_2019, methodId: TEMPERATURE.maxMiddle });

      expect(structured).toMatchObject({
        statCd: '00001',
        statName: 'Maximum',
        methodId: TEMPERATURE.maxMiddle,
        methodDescription: '4.1 ft from riverbed (middle), [Discontinued]',
      });
      expect(structured.values.map((v) => v.value)).toEqual([
        '27.4',
        '27.9',
        '27.8',
        '29.0',
        '28.1',
      ]);
      expect(sentTo('daily')[0]?.url.searchParams.has('statistic_id')).toBe(false);
    });

    it('treats empty-string statCd and methodId as omitted', async () => {
      water.route(...dailyUpstream());
      const { structured } = await series({ ...TEMPERATURE_2019, statCd: '', methodId: '' });

      expect(structured).toMatchObject({ statCd: '00003', methodId: TEMPERATURE.meanTop });
      expect(sentTo('daily')[0]?.url.searchParams.has('statistic_id')).toBe(false);
    });

    it('returns the instantaneous series with the most records, its empty siblings in otherSeries', async () => {
      water.route(...instantaneousUpstream());
      const { structured, text } = await series({
        site: '01646500',
        parameterCd: '00010',
        startDate: '2026-11-11',
        endDate: '2026-11-11',
        seriesType: 'instantaneous',
        statCd: '00000',
      });

      expect(structured).toMatchObject({
        seriesType: 'instantaneous',
        statCd: '00000',
        statName: null,
        methodId: 'd1875d1d73e447d2a1203105ba654e7d',
        methodDescription: 'From multiparameter sonde',
        totalRecords: 21,
        truncated: false,
      });
      expect(structured.otherSeries).toEqual(
        [
          ['52b33353ad684b76a8afd49cf017a42c', '4.1 ft from riverbed (middle), [Discontinued]'],
          ['c8e767f6cdfc4ff484a99f77962dc46c', '7.1 ft from riverbed (top), [Discontinued]'],
          ['f60be489a22b4dfd9fd0fb97f3acc285', '1.0 ft from riverbed (bottom), [Discontinued]'],
          ['089a50eca92a4e268b8816a1bc22c000', 'From multiparameter sonde, [Discontinued]'],
        ].map(([methodId, methodDescription]) => ({
          statCd: '00000',
          statName: null,
          methodId,
          methodDescription,
          recordCount: 0,
        })),
      );
      expect(structured.values.at(-1)).toEqual({
        dateTime: '2026-11-11T04:50:00.000-05:00',
        value: '13.4',
        qualifiers: ['P'],
      });
      expect(text).toContain('**Statistic:** unnamed (statCd 00000)');
      expect(text).toContain('- 2026-11-11T04:50:00.000-05:00: **13.4** deg C [P]');

      const [continuous] = sentTo('continuous');
      expect(continuous?.url.searchParams.has('statistic_id')).toBe(false);
      expect(collectionsSent()).toEqual([
        'continuous',
        'monitoring-locations',
        'parameter-codes',
        'time-series-metadata',
      ]);
    });

    it('reads a range past one year in chunks, joining them oldest first across the fall-back', async () => {
      water.route(...instantaneousUpstream());
      const { structured, text } = await series({
        site: '01646500',
        parameterCd: '00060',
        startDate: '2025-11-01',
        endDate: '2026-11-11',
        seriesType: 'instantaneous',
      });

      expect(
        sentTo('continuous')
          .map((r) => r.url.searchParams.get('time'))
          .sort(),
      ).toEqual([
        '2025-11-01T04:00:00Z/2026-11-02T04:59:59Z',
        '2026-11-02T05:00:00Z/2026-11-12T04:59:59Z',
      ]);
      expect(structured).toMatchObject({
        methodId: '66a4e3fb8abe42fcb0942b5c0fe98f68',
        totalRecords: 70,
        otherSeries: [],
      });
      expect(structured.values[0]).toEqual({
        dateTime: '2026-10-31T23:30:00.000-04:00',
        value: '2260',
        qualifiers: ['P'],
      });
      expect(structured.values[29]?.dateTime).toBe('2026-11-01T01:55:00.000-04:00');
      expect(structured.values[30]?.dateTime).toBe('2026-11-01T01:00:00.000-05:00');
      expect(structured.values.at(-1)).toEqual({
        dateTime: '2026-11-11T04:50:00.000-05:00',
        value: '1940',
        qualifiers: ['P'],
      });
      expect(text).toContain('- 2026-11-01T01:30:00.000-04:00: **');
      expect(text).toContain('- 2026-11-01T01:30:00.000-05:00: **');
      expect(water.requests).toHaveLength(5);
    });

    it('answers no_data_for_range in four requests for a parameter the site has no Points series of, over a century', async () => {
      vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
      water.route(...instantaneousUpstream());
      const { result, text } = await series({
        site: '01646500',
        parameterCd: '00045',
        startDate: '1900-01-01',
        endDate: '2099-12-31',
        seriesType: 'instantaneous',
      });

      const message =
        'No data returned for site 01646500 parameter 00045 — site may not exist, or no data in the requested date range (1900-01-01 to 2099-12-31).';
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, message, data: { reason: 'no_data_for_range' } },
      });
      expect(text).toContain(message);
      // Only the last 366 days to today on the site's clock: a series the metadata does not list
      // yet is at most about a day old.
      expect(sentTo('continuous').map((r) => r.url.searchParams.get('time'))).toEqual([
        '2025-11-11T05:00:00Z/2026-11-12T04:59:59Z',
      ]);
      expect(collectionsSent()).toEqual([
        'continuous',
        'monitoring-locations',
        'parameter-codes',
        'time-series-metadata',
      ]);
    });
  });

  describe('selection errors', () => {
    it('reports method_not_found with the series that do exist for the statistic', async () => {
      water.route(...dailyUpstream());
      const { result, text } = await series({
        ...TEMPERATURE_2019,
        statCd: '00003',
        methodId: TEMPERATURE.maxMiddle,
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: `No series with methodId "${TEMPERATURE.maxMiddle}" and statCd 00003 was returned for site 01646500 parameter 00010 (daily) over 2019-09-01 to 2019-09-05.`,
          data: { reason: 'method_not_found' },
        },
      });
      const { hint } = (
        result.structuredContent as { error: { data: { recovery: { hint: string } } } }
      ).error.data.recovery;
      expect(hint).toContain(
        `statCd 00003, methodId ${TEMPERATURE.meanSonde} (From multiparameter sonde)`,
      );
      expect(hint).not.toContain(TEMPERATURE.maxMiddle);
      // content[] carries the hint Markdown-escaped ("\[Discontinued\]").
      expect(text).toContain(
        `Recovery: Re-request with one of these (pass its statCd and methodId), or omit methodId to get the method with the most records: statCd 00003, methodId ${TEMPERATURE.meanTop} (7.1 ft from riverbed (top), \\[Discontinued\\]);`,
      );
      expect(text).toContain(
        `statCd 00003, methodId ${TEMPERATURE.meanSonde} (From multiparameter sonde).`,
      );
      expect(text).toContain('(reason method_not_found');
    });

    it('fails a numeric WaterServices method ID as method_not_found, saying why', async () => {
      water.route(...dailyUpstream());
      const { result, text } = await series({ ...TEMPERATURE_2019, methodId: '68481' });

      const message =
        'No series with methodId "68481" was returned for site 01646500 parameter 00010 (daily) over 2019-09-01 to 2019-09-05. Numeric NWIS method IDs match no series: methodId takes a 32-character time-series ID, such as the ones this error lists.';
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, message, data: { reason: 'method_not_found' } },
      });
      expect(text).toContain(message);
      for (const id of [TEMPERATURE.meanTop, TEMPERATURE.meanSondeRetired, TEMPERATURE.maxMiddle]) {
        expect(text).toContain(`methodId ${id}`);
      }
    });

    it('rejects a malformed statCd before any request', async () => {
      const { result, text } = await series({ ...TEMPERATURE_2019, statCd: 'mean' });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_stat_cd' } },
      });
      expect(text).toContain('"00003" (mean)');
      expect(water.requests).toHaveLength(0);
    });

    it('rejects a daily statCd on an instantaneous series before any request', async () => {
      const { result, text } = await series({
        ...TEMPERATURE_2019,
        seriesType: 'instantaneous',
        statCd: '00003',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ValidationError,
          data: { reason: 'stat_cd_for_instantaneous' },
        },
      });
      expect(text).toContain('set seriesType to "daily"');
      expect(water.requests).toHaveLength(0);
    });

    it('reports no_data_for_range, naming the statistic, when the site publishes none for statCd', async () => {
      water.route(...dailyUpstream());
      const { result, text } = await series({ ...TEMPERATURE_2019, statCd: '00008' });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_data_for_range' } },
      });
      expect(text).toContain('no daily statistic 00008');
      expect(sentTo('daily')[0]?.url.searchParams.get('statistic_id')).toBe('00008');
    });

    it('reports no_data_for_range after one request for a site with no location', async () => {
      water.route(locationsRoute());
      const { result, text } = await series({ ...DISCHARGE_2024, site: '99999999' });

      const recovery = declaredRecovery(tool.errors, 'no_data_for_range');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message:
            'No data returned for site 99999999 parameter 00060 — site may not exist, or no data in the requested date range (2024-01-01 to 2024-01-10).',
          data: { reason: 'no_data_for_range', recovery },
        },
      });
      expect(text).toContain(recovery.hint);
      expect(collectionsSent()).toEqual(['monitoring-locations']);
    });

    it('reports no_data_for_range for a range before the series began', async () => {
      water.route(...dailyUpstream());
      const { result } = await series({
        ...DISCHARGE_2024,
        startDate: '1920-01-01',
        endDate: '1920-01-10',
      });

      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.NotFound,
          message: 'No data for site 01646500 parameter 00060 in the requested date range.',
          data: { reason: 'no_data_for_range' },
        },
      });
    });
  });

  describe('records the upstream reported as no data (#45)', () => {
    it('returns an all-no-data series as missing records with their qualifiers', async () => {
      // 11176400 reported zero flow with no value at every interval of the window.
      water.route(...instantaneousUpstream());
      const { result, structured, text } = await series({
        site: '11176400',
        parameterCd: '00060',
        startDate: '2026-11-11',
        endDate: '2026-11-11',
        seriesType: 'instantaneous',
      });

      expect(result.isError).toBeFalsy();
      expect(structured.totalRecords).toBe(7);
      expect(structured.values.every((v) => v.value === '')).toBe(true);
      expect(structured.values.at(-1)).toEqual({
        dateTime: '2026-11-11T01:45:00.000-08:00',
        value: '',
        qualifiers: ['P', 'ZFL'],
      });
      expect(text).toContain('- 2026-11-11T01:45:00.000-08:00: no data [P,ZFL]');
      expect(text).not.toContain('null');
    });

    /**
     * The captured Potomac daily discharge series (10 means), re-shaped per test into several
     * statistics and methods. A block marked `missing` holds no value on any day, provisional and
     * qualified DISCONTINUED, the way the upstream reports a discontinued sensor.
     */
    describe('default selection over series that hold no measured value', () => {
      type Block = { id: number; missing?: boolean; records: number; statCd: string };

      /** A synthetic 32-hex time-series ID. */
      const tsid = (n: number) => `5e${String(n).padStart(30, '0')}`;

      function routeBlocks(blocks: Block[]) {
        const days = DAILY_00060.features.toSorted((a, b) =>
          String(a.properties['time']).localeCompare(String(b.properties['time'])),
        );
        const [template] = META_00060.features;
        if (!template) throw new Error('The metadata capture lost its series.');
        const rows = blocks.flatMap((block) =>
          days.slice(0, block.records).map((day) => ({
            ...day,
            properties: {
              ...day.properties,
              time_series_id: tsid(block.id),
              statistic_id: block.statCd,
              ...(block.missing
                ? { value: null, approval_status: 'Provisional', qualifier: ['DISCONTINUED'] }
                : {}),
            },
          })),
        );
        const metadata = blocks.map((block) => ({
          ...template,
          id: tsid(block.id),
          properties: { ...template.properties, statistic_id: block.statCd },
        }));
        water.route(
          locationsRoute(),
          answeredFrom('daily', { features: rows }),
          dailyMetadataRoute({ features: metadata }),
          catalogRoute(),
          statisticCodesRoute(),
        );
      }

      it('picks the method with the most records when every method measures (characterization)', async () => {
        routeBlocks([
          { id: 1, statCd: '00003', records: 3 },
          { id: 2, statCd: '00003', records: 6 },
        ]);
        const { structured, text } = await series(DISCHARGE_2024);

        expect(structured).toMatchObject({ methodId: tsid(2), totalRecords: 6 });
        expect(text).toContain(`**Method ID:** ${tsid(2)}`);
      });

      it('keeps the default pick when every series is all no-data (characterization)', async () => {
        routeBlocks([
          { id: 11, statCd: '00001', records: 10, missing: true },
          { id: 1, statCd: '00003', records: 4, missing: true },
          { id: 2, statCd: '00003', records: 10, missing: true },
        ]);
        const { result, structured, text } = await series(DISCHARGE_2024);

        expect(result.isError).toBeFalsy();
        expect(structured).toMatchObject({ statCd: '00003', methodId: tsid(2), totalRecords: 10 });
        expect(structured.values.every((v) => v.value === '')).toBe(true);
        expect(text).toContain('- 2024-01-10T00:00:00.000: no data [P,Dis]');
      });

      it('still returns an all-no-data method the caller names (characterization)', async () => {
        routeBlocks([
          { id: 1, statCd: '00003', records: 10, missing: true },
          { id: 2, statCd: '00003', records: 3 },
        ]);
        const { structured } = await series({ ...DISCHARGE_2024, methodId: tsid(1) });

        expect(structured).toMatchObject({ methodId: tsid(1), totalRecords: 10 });
        expect(structured.values.every((v) => v.value === '')).toBe(true);
      });

      it('prefers a measuring method over an all-no-data sibling with more records', async () => {
        routeBlocks([
          { id: 1, statCd: '00003', records: 10, missing: true },
          { id: 2, statCd: '00003', records: 3 },
        ]);
        const { structured, text } = await series(DISCHARGE_2024);

        expect(structured).toMatchObject({ statCd: '00003', methodId: tsid(2), totalRecords: 3 });
        expect(structured.values.map((v) => v.value)).toEqual(['8930', '7760', '6860']);
        expect(structured.otherSeries).toEqual([
          {
            statCd: '00003',
            statName: 'Mean',
            methodId: tsid(1),
            methodDescription: null,
            recordCount: 10,
          },
        ]);

        expect(text).toContain(`**Method ID:** ${tsid(2)}`);
        expect(text).toContain('- 2024-01-01T00:00:00.000: **8930** ft3/s [A]');
        expect(text).toContain(
          `Mean (statCd 00003), (no description) (methodId ${tsid(1)}), 10 records`,
        );
        expect(text).not.toContain('no data');
      });

      it('falls back to a measuring statistic when the mean series is all no-data', async () => {
        routeBlocks([
          { id: 11, statCd: '00001', records: 5 },
          { id: 1, statCd: '00003', records: 10, missing: true },
        ]);
        const { structured, text } = await series(DISCHARGE_2024);

        expect(structured).toMatchObject({
          statCd: '00001',
          statName: 'Maximum',
          methodId: tsid(11),
          totalRecords: 5,
        });
        expect(structured.otherSeries).toEqual([
          expect.objectContaining({ statCd: '00003', methodId: tsid(1), recordCount: 10 }),
        ]);
        expect(text).toContain('**Statistic:** Maximum (statCd 00001)');
        expect(text).toContain('- 2024-01-01T00:00:00.000: **8930** ft3/s [A]');
      });
    });
  });

  describe('field measurements and annual peaks (#56)', () => {
    const WELL_DEPTH = {
      site: '400954074302001',
      parameterCd: '72019',
      startDate: '2000-01-01',
      endDate: '2026-11-22',
      seriesType: 'field',
    } as const;
    const GAGE_HEIGHT_2025 = {
      site: '01646500',
      parameterCd: '00065',
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      seriesType: 'field',
    } as const;

    it('returns a well’s six depth-to-water measurements, the last timed on the site clock, the first a bare date', async () => {
      water.route(...fieldUpstream(WELL_FIELD, WELL_FIELD_META));
      const { result, structured, text } = await series(WELL_DEPTH);

      expect(result.isError).toBeFalsy();
      expect(structured).toMatchObject({
        siteNumber: '400954074302001',
        parameterCd: '72019',
        unitCode: 'ft',
        seriesType: 'field',
        statCd: null,
        statName: null,
        methodId: FIELD_IDS.wellDepth,
        totalRecords: 6,
        truncated: false,
        otherSeries: [],
      });
      expect(structured.values[0]).toEqual({
        dateTime: '2000-09-08',
        value: '3.83',
        qualifiers: ['A', 'Static'],
        unknownDatePart: null,
        observingProcedure: 'GW level, electric tape',
        measurementRated: null,
        controlCondition: null,
      });
      expect(structured.values.at(-1)).toEqual({
        dateTime: '2026-08-05T09:15:00.000-04:00',
        value: '4.43',
        qualifiers: ['P', 'Static'],
        unknownDatePart: null,
        observingProcedure: 'GW level, calib electric tape',
        measurementRated: null,
        controlCondition: null,
      });
      expect(text).toContain('**Statistic:** none (statCd null)');
      expect(text).toContain(
        '- 2026-08-05T09:15:00.000-04:00: **4.43** ft [P,Static] (procedure: GW level, calib electric tape)',
      );
      expect(text).toContain(
        '- 2000-09-08: **3.83** ft [A,Static] (procedure: GW level, electric tape)',
      );
      expect(collectionsSent()).toEqual([
        'field-measurements',
        'field-measurements-metadata',
        'monitoring-locations',
        'parameter-codes',
      ]);
    });

    it('returns one gage-height field series, listing the other reading type, and round-trips each methodId', async () => {
      water.route(...fieldUpstream(GAGE_FIELD, GAGE_FIELD_META));
      const { structured, text } = await series(GAGE_HEIGHT_2025);

      expect(structured).toMatchObject({
        seriesType: 'field',
        methodId: FIELD_IDS.staffGage,
        methodDescription: '[ReferencePrimary]',
        totalRecords: 11,
        otherSeries: [
          {
            statCd: null,
            statName: null,
            methodId: FIELD_IDS.meanGage,
            methodDescription: '[MeanGageHeight]',
            recordCount: 6,
          },
        ],
      });
      expect(text).toContain(`[MeanGageHeight] (methodId ${FIELD_IDS.meanGage}), 6 records`);

      for (const [methodId, count] of [
        [FIELD_IDS.meanGage, 6],
        [FIELD_IDS.staffGage, 11],
      ] as const) {
        const again = await series({ ...GAGE_HEIGHT_2025, methodId });
        expect(again.structured).toMatchObject({ methodId, totalRecords: count });
      }
      // The mean gage height of a discharge measurement carries its rating and control condition.
      const { structured: mean } = await series({
        ...GAGE_HEIGHT_2025,
        methodId: FIELD_IDS.meanGage,
      });
      expect(mean.values[0]).toMatchObject({
        value: '3.85',
        measurementRated: 'Fair',
        controlCondition: 'Clear',
      });
    });

    it('flags a field record whose month the upstream does not know', async () => {
      water.route(
        ...fieldUpstream(PARTIAL_DATES, {
          features: [
            {
              id: '27f2d0da-556a-417f-94f7-8ebe6d390656',
              properties: {
                monitoring_location_id: 'USGS-450250105010901',
                parameter_code: '62610',
                parameter_name: 'Elevation, GW, NGVD29',
                begin: '1958-01-01T00:00:00+00:00',
                end: '1958-01-01T00:00:00+00:00',
                reading_type: 'ReferencePrimary',
                sublocation_identifier: null,
              },
            },
          ],
        }),
      );
      const { structured, text } = await series({
        site: '450250105010901',
        parameterCd: '62610',
        startDate: '1958-01-01',
        endDate: '1958-12-31',
        seriesType: 'field',
      });

      expect(structured.values).toEqual([
        expect.objectContaining({
          dateTime: '1958-01-01',
          value: '3664.00',
          unknownDatePart: 'month',
        }),
      ]);
      expect(text).toContain('(procedure: GW level, logs; month unknown)');
    });

    it('returns the 2025 annual peak of 01646500 discharge at its instant on the site clock', async () => {
      water.route(
        locationsRoute(),
        answeredFrom('time-series-metadata', PEAK_META, {
          computation_identifier: 'Max At Event Time',
        }),
        answeredFrom('peaks', PEAKS_2025),
        catalogRoute(),
      );
      const { result, structured, text } = await series({
        site: '01646500',
        parameterCd: '00060',
        startDate: '2025-01-01',
        endDate: '2025-12-31',
        seriesType: 'peak',
      });

      expect(result.isError).toBeFalsy();
      expect(structured).toMatchObject({
        seriesType: 'peak',
        statCd: null,
        methodId: '51a7ecee083843328f6609518990e022',
        totalRecords: 1,
      });
      // Upstream time 2025-05-16 with time_of_day 02:45 UTC: the evening of the 15th in Eastern time.
      expect(structured.values).toEqual([
        {
          dateTime: '2025-05-15T22:45:00.000-04:00',
          value: '156000',
          qualifiers: [],
          unknownDatePart: null,
          waterYear: 2025,
          peakSince: null,
        },
      ]);
      expect(text).toContain('- 2025-05-15T22:45:00.000-04:00: **156000** ft3/s (water year 2025)');
    });

    it('answers a daily request at a well with no daily series with a recovery naming field', async () => {
      water.route(
        locationsRoute(),
        ogcRoute('daily', () => jsonResponse(ogcPage([]))),
        ogcRoute('time-series-metadata', () => jsonResponse(ogcPage([]))),
        catalogRoute(),
        statisticCodesRoute(),
      );
      const { result, text } = await series({ ...WELL_DEPTH, seriesType: 'daily' });

      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'no_data_for_range' } },
      });
      expect(text).toContain('seriesType="field"');
    });
  });

  describe('upstream failures', () => {
    it('surfaces a 429 as rate_limited with the upstream retryAfter, sending the read once', async () => {
      water.route(...dailyAnswering(() => rateLimitResponse(1800)));
      const { result, text } = await series(DISCHARGE_2024);

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
      expect(sentTo('daily')).toHaveLength(1);
    });

    it('fails an unreadable 200 body at once as upstream_error with its recovery hint', async () => {
      const cut = waterDataFixture('observations-daily-01646500-00060-20240101-10.json').slice(
        0,
        1_000,
      );
      water.route(...dailyAnswering(() => jsonResponse(cut)));
      const { result, text } = await series(DISCHARGE_2024);

      const recovery = declaredRecovery(tool.errors, 'upstream_error');
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          message: 'USGS Water Data OGC API sent a response that is not JSON (water_get_series).',
          data: { reason: 'upstream_error', recovery },
        },
      });
      expect(text).toContain(recovery.hint);
      expect(sentTo('daily')).toHaveLength(1);
    });

    it('recovers when a retry after a 503 returns the body', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(
        ogcRoute('daily', () => new Response('Unavailable', { status: 503 }), { once: true }),
        ...dailyUpstream(),
      );
      const pending = series(DISCHARGE_2024);
      await vi.advanceTimersByTimeAsync(10_000);
      const { result, structured, text } = await pending;

      expect(result.isError).toBeFalsy();
      expect(structured).toMatchObject({ methodId: DISCHARGE_MEAN, totalRecords: 10 });
      expect(text).toContain('- 2024-01-10T00:00:00.000: **39000** ft3/s [A]');
      expect(sentTo('daily')).toHaveLength(2);
    });

    it('stops at a caller cancellation while waiting on the statistic names, reporting the caller’s reason', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      water.route(
        locationsRoute(),
        answeredFrom('daily', DAILY),
        dailyMetadataRoute(),
        catalogRoute(),
        ogcRoute('statistic-codes', stalled),
      );
      const controller = new AbortController();
      const pending = series(DISCHARGE_2024, controller.signal);
      await untilSent(() => water.requests.length === 5);
      controller.abort(new DOMException('Request cancelled by caller', 'AbortError'));
      const { result, text } = await pending;

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled, message: 'Request cancelled by caller' },
      });
      expect(text).toContain('Request cancelled by caller');
      expect(sentTo('daily')).toHaveLength(1);
      expect(sentTo('time-series-metadata')).toHaveLength(1);
    });
  });
});

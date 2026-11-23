/**
 * @fileoverview Series assembly from Water Data rows and their series metadata, at its own seam:
 * the qualifier word → WaterServices code table one row per word, approval codes, method labels,
 * one series per metadata entry plus one per unlisted series that has rows, records de-duplicated
 * and ordered by time, series order, and the catalog → metadata fallbacks for unit and parameter
 * name. Field-measurement and peak assembly runs on rows copied from live captures: the instant a
 * `time` and `time_of_day` name, the bare date without one, unknown months and days, and the
 * site-local days a record must fall on.
 * @module tests/services/observation-series.test
 */

import { describe, expect, it } from 'vitest';
import {
  assembleFieldSeries,
  assemblePeakSeries,
  assembleSeries,
  type FieldMeasurement,
  type FieldSeriesMetadata,
  type MeasurementContext,
  measuredInstant,
  methodLabel,
  type Observation,
  type PeakMeasurement,
  type SeriesContext,
  type SeriesMetadata,
  TimeOfDaySchema,
} from '@/services/waterdata/observation-series.js';
import type { CatalogParameter } from '@/services/waterdata/parameter-catalog.js';
import type { ResolvedSite } from '@/services/waterdata/site-resolver.js';

const SITE: ResolvedSite = {
  agencyCode: 'USGS',
  monitoringLocationId: 'USGS-01646500',
  siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
  siteNumber: '01646500',
  timeZone: { abbreviation: 'EST', observesDaylightSaving: true },
};

const DISCHARGE: CatalogParameter = {
  code: '00060',
  name: 'Discharge',
  unit: 'ft3/s',
  description: 'Discharge, cubic feet per second',
};

function context(overrides: Partial<SeriesContext> = {}): SeriesContext {
  return {
    seriesType: 'instantaneous',
    sites: new Map([[SITE.monitoringLocationId, SITE]]),
    parameters: new Map([[DISCHARGE.code, DISCHARGE]]),
    statisticNames: new Map([['00003', 'Mean']]),
    ...overrides,
  };
}

function meta(id: string, overrides: Partial<SeriesMetadata> = {}): SeriesMetadata {
  return {
    id,
    monitoringLocationId: SITE.monitoringLocationId,
    parameterCd: '00060',
    statCd: '00011',
    begin: '2000-01-01T05:00:00+00:00',
    sublocation: null,
    webDescription: null,
    unit: 'ft^3/s',
    parameterName: 'Discharge',
    ...overrides,
  };
}

function row(seriesId: string, time: string, overrides: Partial<Observation> = {}): Observation {
  return {
    seriesId,
    monitoringLocationId: SITE.monitoringLocationId,
    parameterCd: '00060',
    statCd: '00011',
    time,
    value: '1890',
    approvalStatus: 'Provisional',
    qualifiers: [],
    ...overrides,
  };
}

/** The qualifier codes the one record of a one-row series carries. */
function codesFor(qualifiers: readonly string[], approvalStatus: string | null = 'Provisional') {
  const [series] = assembleSeries(
    [meta('a')],
    [row('a', '2026-11-11T07:50:00+00:00', { qualifiers, approvalStatus })],
    context(),
  );
  return series?.values[0]?.qualifiers;
}

describe('qualifier codes', () => {
  it.each([
    ['ESTIMATED', 'e'],
    ['REVISED', 'R'],
    ['SEASONAL', 'Ssn'],
    ['EQUIP', 'Eqp'],
    ['DISCONTINUED', 'Dis'],
    ['BACKWATER', 'Bkw'],
    ['FLOOD', 'Fld'],
    ['ICE', 'Ice'],
    ['RATINGDEV', 'Rat'],
    ['DRY', 'Dry'],
    ['ZEROFLOW', 'ZFL'],
    ['UNAVAIL', '***'],
    ['MAINT', 'Mnt'],
    ['LESSTHAN', '<'],
    ['GREATERTHAN', '>'],
  ])('writes %s as %s', (word, code) => {
    expect(codesFor([word])).toEqual(['P', code]);
  });

  it.each(['OTHERAGENCY', 'FORCEINTERPOLATION', 'BLWMIN', 'estimated', 'Ice'])(
    'passes %s through as written',
    (word) => {
      expect(codesFor([word])).toEqual(['P', word]);
    },
  );

  it.each([
    ['Approved', 'A'],
    ['Provisional', 'P'],
    ['Working', 'Working'],
  ])('writes approval status %s first, as %s', (status, code) => {
    expect(codesFor(['ICE'], status)).toEqual([code, 'Ice']);
  });

  it('writes no approval code when the row has none', () => {
    expect(codesFor(['ICE'], null)).toEqual(['Ice']);
    expect(codesFor([], null)).toEqual([]);
  });

  it('lists every word of a multi-word record, in the order the row gives them', () => {
    expect(codesFor(['DISCONTINUED', 'EQUIP'])).toEqual(['P', 'Dis', 'Eqp']);
    expect(codesFor(['LESSTHAN', 'SEASONAL'])).toEqual(['P', '<', 'Ssn']);
    expect(codesFor(['BLWMIN', 'UNAVAIL'])).toEqual(['P', 'BLWMIN', '***']);
    expect(codesFor(['EQUIP', 'OTHERAGENCY'])).toEqual(['P', 'Eqp', 'OTHERAGENCY']);
  });
});

describe('methodLabel', () => {
  it.each([
    ['From multiparameter sonde', 'Discontinued', 'From multiparameter sonde, [Discontinued]'],
    [null, 'Radar', '[Radar]'],
    ['', 'Radar', '[Radar]'],
    ['Met station', null, 'Met station'],
    ['Met station', '', 'Met station'],
    [null, null, null],
    ['', '', null],
  ])('labels sublocation %j and description %j as %j', (sublocation, description, label) => {
    expect(methodLabel(sublocation, description)).toBe(label);
  });
});

describe('assembleSeries', () => {
  it('keeps one series per metadata entry, an entry with no rows included', () => {
    const series = assembleSeries(
      [
        meta('a'),
        meta('b', { webDescription: 'Discontinued', begin: '1990-01-01T05:00:00+00:00' }),
      ],
      [row('a', '2026-11-11T07:50:00+00:00')],
      context(),
    );
    expect(series.map((s) => [s.methodId, s.methodDescription, s.values.length])).toEqual([
      ['b', '[Discontinued]', 0],
      ['a', null, 1],
    ]);
  });

  it('builds the WaterServices series shape from the catalog, metadata, and site', () => {
    const [series] = assembleSeries(
      [
        meta('66a4e3fb8abe42fcb0942b5c0fe98f68', {
          sublocation: 'Bridge',
          webDescription: 'Radar',
        }),
      ],
      [
        row('66a4e3fb8abe42fcb0942b5c0fe98f68', '2026-11-11T07:50:00+00:00', {
          qualifiers: ['ICE'],
        }),
      ],
      context(),
    );
    expect(series).toEqual({
      siteNumber: '01646500',
      siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
      parameterCd: '00060',
      parameterName: 'Discharge, cubic feet per second',
      unitCode: 'ft3/s',
      statCd: '00000',
      statName: null,
      methodId: '66a4e3fb8abe42fcb0942b5c0fe98f68',
      methodDescription: 'Bridge, [Radar]',
      values: [
        { dateTime: '2026-11-11T02:50:00.000-05:00', value: '1890', qualifiers: ['P', 'Ice'] },
      ],
    });
  });

  it('falls back to the series metadata for a code the catalog lacks, and to "" with neither', () => {
    const series = assembleSeries(
      [
        meta('a', { parameterCd: '99999', unit: 'widgets', parameterName: 'Widget count' }),
        meta('b', { parameterCd: '99998', unit: null, parameterName: null }),
      ],
      [],
      context(),
    );
    expect(series.map((s) => [s.parameterCd, s.unitCode, s.parameterName])).toEqual([
      ['99998', '', ''],
      ['99999', 'widgets', 'Widget count'],
    ]);
  });

  it('writes an empty value for a null one and keeps its qualifiers', () => {
    const [series] = assembleSeries(
      [meta('a')],
      [row('a', '2026-11-11T08:15:00+00:00', { value: null, qualifiers: ['ZEROFLOW'] })],
      context(),
    );
    expect(series?.values).toEqual([
      { dateTime: '2026-11-11T03:15:00.000-05:00', value: '', qualifiers: ['P', 'ZFL'] },
    ]);
  });

  it('orders records oldest first and counts a time read twice once, keeping the first read', () => {
    const [series] = assembleSeries(
      [meta('a')],
      [
        row('a', '2026-11-11T08:00:00+00:00', { value: '3' }),
        row('a', '2026-11-11T07:50:00+00:00', { value: '1' }),
        row('a', '2026-11-11T07:55:00Z', { value: '2' }),
        row('a', '2026-11-11T02:55:00-05:00', { value: 'duplicate' }),
        row('a', '2026-11-11T08:00:00+00:00', { value: 'duplicate' }),
      ],
      context(),
    );
    expect(series?.values.map((v) => [v.dateTime, v.value])).toEqual([
      ['2026-11-11T02:50:00.000-05:00', '1'],
      ['2026-11-11T02:55:00.000-05:00', '2'],
      ['2026-11-11T03:00:00.000-05:00', '3'],
    ]);
  });

  it('keeps a series that has rows but no metadata yet, unlabeled, after every listed one', () => {
    const series = assembleSeries(
      [meta('z', { begin: '2026-01-01T05:00:00+00:00' })],
      [row('a', '2026-11-11T07:50:00+00:00'), row('z', '2026-11-11T07:50:00+00:00')],
      context(),
    );
    expect(
      series.map((s) => [s.methodId, s.methodDescription, s.unitCode, s.parameterName]),
    ).toEqual([
      ['z', null, 'ft3/s', 'Discharge, cubic feet per second'],
      ['a', null, 'ft3/s', 'Discharge, cubic feet per second'],
    ]);
  });

  it('drops rows and metadata of a location outside the resolved sites', () => {
    const series = assembleSeries(
      [meta('a'), meta('b', { monitoringLocationId: 'USGS-99999999' })],
      [
        row('a', '2026-11-11T07:50:00+00:00'),
        row('b', '2026-11-11T07:50:00+00:00', { monitoringLocationId: 'USGS-99999999' }),
        row('c', '2026-11-11T07:50:00+00:00', { monitoringLocationId: 'USGS-99999999' }),
      ],
      context(),
    );
    expect(series.map((s) => s.methodId)).toEqual(['a']);
  });

  it('orders series by site number, parameter code, statistic code, first observation, then ID', () => {
    const other: ResolvedSite = {
      ...SITE,
      monitoringLocationId: 'USGS-01638500',
      siteNumber: '01638500',
      siteName: null,
    };
    const series = assembleSeries(
      [
        meta('p2', { parameterCd: '00065', begin: '1900-01-01T05:00:00+00:00' }),
        meta('late', { begin: '2020-01-01T05:00:00+00:00' }),
        meta('tie-b', { begin: '2010-01-01T05:00:00+00:00' }),
        meta('tie-a', { begin: '2010-01-01T05:00:00+00:00' }),
        meta('no-begin', { begin: null }),
        meta('s2', {
          monitoringLocationId: other.monitoringLocationId,
          begin: '2030-01-01T05:00:00+00:00',
        }),
      ],
      [],
      context({
        sites: new Map([
          [SITE.monitoringLocationId, SITE],
          [other.monitoringLocationId, other],
        ]),
      }),
    );
    expect(series.map((s) => s.methodId)).toEqual([
      's2',
      'tie-a',
      'tie-b',
      'late',
      'no-begin',
      'p2',
    ]);
    expect(series[0]?.siteName).toBe('');
  });

  it('orders daily series by statistic code, names each statistic, and writes the calendar day', () => {
    const series = assembleSeries(
      [
        meta('mean', { statCd: '00003' }),
        meta('max', { statCd: '00001' }),
        meta('odd', { statCd: '00099' }),
        meta('none', { statCd: null }),
      ],
      [
        row('mean', '2019-09-02', { statCd: '00003', value: '26.9', approvalStatus: 'Approved' }),
        row('mean', '2019-09-01', { statCd: '00003', value: '26.6', approvalStatus: 'Approved' }),
        row('unlisted', '2019-09-01', { statCd: '00008', value: '1', approvalStatus: 'Approved' }),
      ],
      context({
        seriesType: 'daily',
        statisticNames: new Map([
          ['00001', 'Maximum'],
          ['00003', 'Mean'],
          ['00008', 'Median'],
        ]),
      }),
    );
    expect(series.map((s) => [s.methodId, s.statCd, s.statName])).toEqual([
      ['none', '', null],
      ['max', '00001', 'Maximum'],
      ['mean', '00003', 'Mean'],
      ['unlisted', '00008', 'Median'],
      ['odd', '00099', null],
    ]);
    expect(series[2]?.values).toEqual([
      { dateTime: '2019-09-01T00:00:00.000', value: '26.6', qualifiers: ['A'] },
      { dateTime: '2019-09-02T00:00:00.000', value: '26.9', qualifiers: ['A'] },
    ]);
  });

  it('writes instantaneous values on the site clock, and in UTC for a site with no known zone', () => {
    const utcSite: ResolvedSite = { ...SITE, timeZone: null };
    const [series] = assembleSeries(
      [meta('a')],
      [row('a', '2026-07-11T07:50:00+00:00')],
      context({ sites: new Map([[utcSite.monitoringLocationId, utcSite]]) }),
    );
    expect(series?.values[0]?.dateTime).toBe('2026-07-11T07:50:00.000+00:00');
  });

  it('returns nothing for no metadata and no rows', () => {
    expect(assembleSeries([], [], context())).toEqual([]);
  });
});

describe('a measurement’s time of day', () => {
  it.each([
    ['2026-08-05', '13:15:00+00:00', '2026-08-05T13:15:00.000Z'],
    ['2025-05-16', '02:45:00+00:00', '2025-05-16T02:45:00.000Z'],
    ['2018-05-21', '16:04:30+00:00', '2018-05-21T16:04:30.000Z'],
    ['2026-08-05', '13:15:00.5Z', '2026-08-05T13:15:00.500Z'],
    ['2026-08-05', '13:15:00-05:00', '2026-08-05T18:15:00.000Z'],
  ])('reads %s at %s as %s', (date, timeOfDay, instant) => {
    expect(measuredInstant(date, timeOfDay)).toBe(instant);
  });

  it.each(['13:15:00+00:00', '13:15:00Z', '16:04:30.25+00:00', '23:59:59-10:00'])(
    'accepts %j',
    (timeOfDay) => {
      expect(TimeOfDaySchema.safeParse(timeOfDay).success).toBe(true);
    },
  );

  // A clock time without an offset would read as the server host's local time.
  it.each(['13:15:00', '13:15+00:00', 'afternoon', '', '2026-08-05T13:15:00+00:00'])(
    'rejects %j',
    (timeOfDay) => {
      expect(TimeOfDaySchema.safeParse(timeOfDay).success).toBe(false);
    },
  );
});

/** The Monmouth County, NJ well: Eastern time with daylight saving. */
const WELL: ResolvedSite = {
  agencyCode: 'USGS',
  monitoringLocationId: 'USGS-400954074302001',
  siteName: '250790-- Imlaystown MW1',
  siteNumber: '400954074302001',
  timeZone: { abbreviation: 'EST', observesDaylightSaving: true },
};

const DEPTH: CatalogParameter = {
  code: '72019',
  name: 'Water level, depth LSD',
  unit: 'ft',
  description: 'Depth to water level, feet below land surface',
};

const GAGE_HEIGHT: CatalogParameter = {
  code: '00065',
  name: 'Gage height',
  unit: 'ft',
  description: 'Gage height, feet',
};

const WELL_SERIES = '4270d483-4184-4046-9d76-67ee60ca7a35';

function measurementContext(overrides: Partial<MeasurementContext> = {}): MeasurementContext {
  return {
    days: ['2000-01-01', '2026-11-22'],
    sites: new Map([
      [WELL.monitoringLocationId, WELL],
      [SITE.monitoringLocationId, SITE],
    ]),
    parameters: new Map([
      [DEPTH.code, DEPTH],
      [GAGE_HEIGHT.code, GAGE_HEIGHT],
      [DISCHARGE.code, DISCHARGE],
    ]),
    ...overrides,
  };
}

function fieldMeta(id: string, overrides: Partial<FieldSeriesMetadata> = {}): FieldSeriesMetadata {
  return {
    id,
    monitoringLocationId: WELL.monitoringLocationId,
    parameterCd: '72019',
    parameterName: 'Depth to water level, feet below land surface',
    readingType: 'ReferencePrimary',
    begin: '2000-09-08T12:00:00+00:00',
    sublocation: null,
    ...overrides,
  };
}

/** A well measurement; the defaults are the 2026-08-05 record of the captured series. */
function fieldRow(overrides: Partial<FieldMeasurement> = {}): FieldMeasurement {
  return {
    seriesId: WELL_SERIES,
    monitoringLocationId: WELL.monitoringLocationId,
    parameterCd: '72019',
    date: '2026-08-05',
    timeOfDay: '13:15:00+00:00',
    month: 8,
    day: 5,
    value: '4.43',
    unit: 'ft',
    approvalStatus: 'Provisional',
    qualifiers: ['Static'],
    observingProcedure: 'GW level, calib electric tape',
    measurementRated: null,
    controlCondition: null,
    readingType: 'ReferencePrimary',
    sublocation: null,
    ...overrides,
  };
}

describe('assembleFieldSeries', () => {
  it('writes a measurement with a time of day on the site clock, and one without as its bare date', () => {
    const [series] = assembleFieldSeries(
      [fieldMeta(WELL_SERIES)],
      [
        fieldRow(),
        fieldRow({
          date: '2000-09-08',
          timeOfDay: null,
          month: 9,
          day: 8,
          value: '3.83',
          approvalStatus: 'Approved',
          observingProcedure: 'GW level, electric tape',
        }),
      ],
      measurementContext(),
    );
    expect(series?.values).toEqual([
      {
        dateTime: '2000-09-08',
        value: '3.83',
        qualifiers: ['A', 'Static'],
        unknownDatePart: null,
        observingProcedure: 'GW level, electric tape',
        measurementRated: null,
        controlCondition: null,
      },
      {
        dateTime: '2026-08-05T09:15:00.000-04:00',
        value: '4.43',
        qualifiers: ['P', 'Static'],
        unknownDatePart: null,
        observingProcedure: 'GW level, calib electric tape',
        measurementRated: null,
        controlCondition: null,
      },
    ]);
  });

  it('builds the series shape: no statistic, the reading type as its label, catalog unit and name', () => {
    const [series] = assembleFieldSeries(
      [fieldMeta(WELL_SERIES)],
      [fieldRow()],
      measurementContext(),
    );
    expect(series).toEqual({
      siteNumber: '400954074302001',
      siteName: '250790-- Imlaystown MW1',
      parameterCd: '72019',
      parameterName: 'Depth to water level, feet below land surface',
      unitCode: 'ft',
      seriesType: 'field',
      statCd: null,
      statName: null,
      methodId: WELL_SERIES,
      methodDescription: '[ReferencePrimary]',
      readingType: 'ReferencePrimary',
      values: [expect.objectContaining({ value: '4.43' })],
    });
  });

  it('keeps one series per reading type, the one with no records on the days included', () => {
    // 01646500 gage height: staff-gage readings since 2020, mean gage height of each discharge
    // measurement since 1930.
    const staff = '69cf03cd-7795-4b55-9550-ef69dd8fe9c1';
    const mean = 'c141575d-9f1d-42ce-aa4a-0584728735ce';
    const gage = { monitoringLocationId: SITE.monitoringLocationId, parameterCd: '00065' };
    const series = assembleFieldSeries(
      [
        fieldMeta(staff, {
          ...gage,
          readingType: 'ReferencePrimary',
          begin: '2020-10-06T13:22:00+00:00',
        }),
        fieldMeta(mean, {
          ...gage,
          readingType: 'MeanGageHeight',
          begin: '1930-03-25T22:40:00+00:00',
        }),
      ],
      [
        fieldRow({
          ...gage,
          seriesId: staff,
          date: '2025-07-30',
          timeOfDay: '13:11:00+00:00',
          month: 7,
          day: 30,
          value: '3.46',
          approvalStatus: 'Approved',
          qualifiers: [],
          observingProcedure: 'Gage height, staff gage',
          controlCondition: 'Clear',
        }),
      ],
      measurementContext({ days: ['2025-07-30', '2025-07-30'] }),
    );
    expect(
      series.map((s) => [s.methodId, s.readingType, s.methodDescription, s.values.length]),
    ).toEqual([
      [mean, 'MeanGageHeight', '[MeanGageHeight]', 0],
      [staff, 'ReferencePrimary', '[ReferencePrimary]', 1],
    ]);
    expect(series[1]?.values[0]).toMatchObject({
      dateTime: '2025-07-30T09:11:00.000-04:00',
      qualifiers: ['A'],
      controlCondition: 'Clear',
      measurementRated: null,
    });
  });

  it('writes a discharge measurement’s rating and control condition', () => {
    const [series] = assembleFieldSeries(
      [],
      [
        fieldRow({
          seriesId: 'c141575d-9f1d-42ce-aa4a-0584728735ce',
          monitoringLocationId: SITE.monitoringLocationId,
          parameterCd: '00065',
          date: '2025-11-26',
          timeOfDay: '17:14:00+00:00',
          month: 11,
          day: 26,
          value: '2.86',
          approvalStatus: 'Approved',
          qualifiers: [],
          observingProcedure: 'None',
          measurementRated: 'Fair',
          controlCondition: 'Debris - Light',
          readingType: 'MeanGageHeight',
        }),
      ],
      measurementContext({ days: ['2025-01-01', '2025-12-31'] }),
    );
    expect(series?.values).toEqual([
      {
        dateTime: '2025-11-26T12:14:00.000-05:00',
        value: '2.86',
        qualifiers: ['A'],
        unknownDatePart: null,
        observingProcedure: 'None',
        measurementRated: 'Fair',
        controlCondition: 'Debris - Light',
      },
    ]);
  });

  it('flags a date whose month or day the upstream does not know', () => {
    // 450250105010901 on 1958 (month and day null) and 450623089111501 in March 1964 (day null).
    const series = assembleFieldSeries(
      [],
      [
        fieldRow({ seriesId: 'a', date: '1958-01-01', timeOfDay: null, month: null, day: null }),
        fieldRow({ seriesId: 'a', date: '1964-03-01', timeOfDay: null, month: 3, day: null }),
        fieldRow({ seriesId: 'a', date: '1964-03-02', timeOfDay: null, month: 3, day: 2 }),
      ],
      measurementContext({ days: ['1900-01-01', '2026-11-22'] }),
    );
    expect(series[0]?.values.map((v) => [v.dateTime, v.unknownDatePart])).toEqual([
      ['1958-01-01', 'month'],
      ['1964-03-01', 'day'],
      ['1964-03-02', null],
    ]);
  });

  it('keeps the records on the site-local days asked, one dated the next UTC day included', () => {
    const on = (date: string, timeOfDay: string | null) =>
      fieldRow({ seriesId: 'a', date, timeOfDay, value: `${date} ${timeOfDay}` });
    const [series] = assembleFieldSeries(
      [],
      [
        on('2025-05-14', '23:00:00+00:00'), // 19:00 EDT on 05-14
        on('2025-05-15', '03:30:00+00:00'), // 23:30 EDT on 05-14
        on('2025-05-15', '12:00:00+00:00'), // 08:00 EDT on 05-15
        on('2025-05-16', '02:45:00+00:00'), // 22:45 EDT on 05-15
        on('2025-05-16', '04:15:00+00:00'), // 00:15 EDT on 05-16
        on('2025-05-14', null),
        on('2025-05-15', null),
        on('2025-05-16', null),
      ],
      measurementContext({ days: ['2025-05-15', '2025-05-15'] }),
    );
    expect(series?.values.map((v) => v.dateTime)).toEqual([
      '2025-05-15',
      '2025-05-15T08:00:00.000-04:00',
      '2025-05-15T22:45:00.000-04:00',
    ]);
  });

  it('orders records oldest first and keeps two measurements on one date', () => {
    const [series] = assembleFieldSeries(
      [],
      [
        fieldRow({ seriesId: 'a', date: '2010-05-12', timeOfDay: '13:45:00+00:00', value: '3.00' }),
        fieldRow({ seriesId: 'a', date: '1990-06-01', timeOfDay: null, value: 'first' }),
        fieldRow({ seriesId: 'a', date: '1990-06-01', timeOfDay: null, value: 'second' }),
        fieldRow({
          seriesId: 'a',
          date: '2000-09-28',
          timeOfDay: '13:50:00+00:00',
          value: '10.80',
        }),
      ],
      measurementContext({ days: ['1900-01-01', '2026-11-22'] }),
    );
    expect(series?.values.map((v) => v.value)).toEqual(['first', 'second', '10.80', '3.00']);
  });

  it('keeps a series that has rows but no metadata yet, after every listed one, labeled from its rows', () => {
    const series = assembleFieldSeries(
      [fieldMeta(WELL_SERIES, { begin: '2000-09-08T12:00:00+00:00' })],
      [
        fieldRow({
          seriesId: 'new',
          readingType: 'ReferencePrimary',
          sublocation: 'North casing',
          unit: 'm',
        }),
      ],
      measurementContext({ parameters: new Map() }),
    );
    expect(
      series.map((s) => [s.methodId, s.methodDescription, s.unitCode, s.parameterName]),
    ).toEqual([
      [WELL_SERIES, '[ReferencePrimary]', '', 'Depth to water level, feet below land surface'],
      ['new', 'North casing, [ReferencePrimary]', 'm', ''],
    ]);
  });

  it('drops rows and metadata of a location outside the resolved sites', () => {
    const elsewhere = { monitoringLocationId: 'USGS-99999999' };
    expect(
      assembleFieldSeries(
        [fieldMeta('x', elsewhere)],
        [fieldRow({ ...elsewhere, seriesId: 'y' })],
        measurementContext(),
      ),
    ).toEqual([]);
  });

  it('returns nothing for no metadata and no rows', () => {
    expect(assembleFieldSeries([], [], measurementContext())).toEqual([]);
  });
});

const PEAK_SERIES = '51a7ecee083843328f6609518990e022';

/** A 01646500 discharge peak; the defaults are the water-year 2025 crest. */
function peakRow(overrides: Partial<PeakMeasurement> = {}): PeakMeasurement {
  return {
    seriesId: PEAK_SERIES,
    monitoringLocationId: SITE.monitoringLocationId,
    parameterCd: '00060',
    date: '2025-05-16',
    timeOfDay: '02:45:00+00:00',
    month: 5,
    day: 16,
    value: '156000',
    unit: 'ft^3/s',
    qualifiers: [],
    waterYear: 2025,
    peakSince: null,
    ...overrides,
  };
}

describe('assemblePeakSeries', () => {
  const peakMeta = meta(PEAK_SERIES, { statCd: null, begin: '1931-04-03T05:00:00+00:00' });

  it('writes the crest on the site clock with its water year, and no approval code', () => {
    const series = assemblePeakSeries(
      [peakMeta],
      [peakRow()],
      measurementContext({ days: ['2025-01-01', '2025-12-31'] }),
    );
    expect(series).toEqual([
      {
        siteNumber: '01646500',
        siteName: 'POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA',
        parameterCd: '00060',
        parameterName: 'Discharge, cubic feet per second',
        unitCode: 'ft3/s',
        seriesType: 'peak',
        statCd: null,
        statName: null,
        methodId: PEAK_SERIES,
        methodDescription: null,
        values: [
          {
            dateTime: '2025-05-15T22:45:00.000-04:00',
            value: '156000',
            qualifiers: [],
            unknownDatePart: null,
            waterYear: 2025,
            peakSince: null,
          },
        ],
      },
    ]);
  });

  it('codes peak qualifiers as instantaneous values do and flags a peak whose month is unknown', () => {
    // USGS-05482800, water year 1980: month and day null, filled to 01-01.
    const [series] = assemblePeakSeries(
      [],
      [
        peakRow({
          date: '1980-01-01',
          timeOfDay: null,
          month: null,
          day: null,
          value: '25.0',
          qualifiers: ['LESSTHAN', 'MONTHUNKNOWN'],
          waterYear: 1980,
        }),
        peakRow({
          date: '1889-06-02',
          timeOfDay: null,
          month: 6,
          day: 2,
          value: '484000',
          qualifiers: ['REVISED', 'DIFFDATUM'],
          waterYear: 1889,
          peakSince: 1889,
        }),
      ],
      measurementContext({ days: ['1800-01-01', '2026-11-22'] }),
    );
    expect(series?.values).toEqual([
      {
        dateTime: '1889-06-02',
        value: '484000',
        qualifiers: ['R', 'DIFFDATUM'],
        unknownDatePart: null,
        waterYear: 1889,
        peakSince: 1889,
      },
      {
        dateTime: '1980-01-01',
        value: '25.0',
        qualifiers: ['<', 'MONTHUNKNOWN'],
        unknownDatePart: 'month',
        waterYear: 1980,
        peakSince: null,
      },
    ]);
  });

  it('falls back to the series metadata for a code the catalog lacks, then to the row’s unit', () => {
    const noCatalog = measurementContext({
      parameters: new Map(),
      days: ['2025-01-01', '2025-12-31'],
    });
    const [listed] = assemblePeakSeries([peakMeta], [], noCatalog);
    expect(listed).toMatchObject({ unitCode: 'ft^3/s', parameterName: 'Discharge', values: [] });
    const [unlisted] = assemblePeakSeries([], [peakRow({ unit: 'ft3/s?' })], noCatalog);
    expect(unlisted).toMatchObject({
      unitCode: 'ft3/s?',
      parameterName: '',
      methodDescription: null,
    });
  });
});

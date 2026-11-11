/**
 * @fileoverview Series assembly from Water Data rows and their time-series metadata, at its own
 * seam: the qualifier word → WaterServices code table one row per word, approval codes, method
 * labels, one series per metadata entry plus one per unlisted series that has rows, records
 * de-duplicated and ordered by time, series order, and the catalog → metadata fallbacks for unit
 * and parameter name.
 * @module tests/services/observation-series.test
 */

import { describe, expect, it } from 'vitest';
import {
  assembleSeries,
  methodLabel,
  type Observation,
  type SeriesContext,
  type SeriesMetadata,
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

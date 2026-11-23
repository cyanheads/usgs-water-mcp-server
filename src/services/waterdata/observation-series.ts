/**
 * @fileoverview Assemble observation rows and their series metadata into series: `continuous` or
 * `daily` rows with `time-series-metadata` into the {@link NwisTimeSeries} shape WaterServices
 * produced, and `field-measurements` or `peaks` rows into {@link FieldSeries} and
 * {@link PeakSeries}. One series per time series (a statistic × method, a reading type, or a peak
 * series), listed whether or not it holds values in the window, with WaterServices' timestamps,
 * units, method labels, and qualifier codes. Also the one reading of a measurement's `time` and
 * `time_of_day`, shared with site discovery.
 * @module services/waterdata/observation-series
 */

import { z } from '@cyanheads/mcp-ts-core';
import type {
  FieldSeries,
  FieldValueRecord,
  NwisTimeSeries,
  NwisValueRecord,
  PeakSeries,
  PeakValueRecord,
} from '@/services/waterdata/types.js';
import type { CatalogParameter } from './parameter-catalog.js';
import { type SiteTimeZone, siteLocalDate, toSiteLocalTimestamp } from './site-local-time.js';
import type { ResolvedSite } from './site-resolver.js';

/** The `time-series-metadata` computation of an annual-peak series, whatever its computation period. */
export const PEAK_COMPUTATION = 'Max At Event Time';

/**
 * A `time_of_day` of `field-measurements`, `latest-field-measurements`, or `peaks`: a clock time
 * with its UTC offset (`13:15:00+00:00`), read with the row's `time`, the UTC date.
 */
export const TimeOfDaySchema = z
  .string()
  .regex(
    /^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    'expected a clock time with a UTC offset (HH:MM:SS+00:00)',
  );

/**
 * The instant of a field measurement or peak in UTC (`2026-08-05T13:15:00.000Z`): its `time`, the
 * UTC date, joined to its `time_of_day`. A row without a time of day has its date alone.
 */
export function measuredInstant(date: string, timeOfDay: string): string {
  return new Date(`${date}T${timeOfDay}`).toISOString();
}

/** One time series from `time-series-metadata`. */
export interface SeriesMetadata {
  /** Earliest observation, UTC. */
  begin: string | null;
  /** The OGC `time_series_id`. */
  id: string;
  monitoringLocationId: string;
  parameterCd: string;
  /** The series' own parameter name, for a code the parameter catalog lacks. */
  parameterName: string | null;
  statCd: string | null;
  sublocation: string | null;
  /** The series' own unit (`ft^3/s`), for a code the parameter catalog lacks. */
  unit: string | null;
  webDescription: string | null;
}

/** One `continuous` or `daily` row. */
export interface Observation {
  approvalStatus: string | null;
  monitoringLocationId: string;
  parameterCd: string;
  qualifiers: readonly string[];
  seriesId: string;
  statCd: string | null;
  /** A UTC instant (`continuous`) or a calendar date, `YYYY-MM-DD` (`daily`). */
  time: string;
  /** Null when the upstream holds no value for the time. */
  value: string | null;
}

/** What a `field-measurements` and a `peaks` row share. */
interface MeasurementRow {
  /** `time`: the UTC date, `YYYY-MM-DD`. Its month and day read 01 when the upstream does not know them. */
  date: string;
  /** Null when the upstream does not know the day of the month. */
  day: number | null;
  monitoringLocationId: string;
  /** Null when the upstream does not know the month. */
  month: number | null;
  parameterCd: string;
  qualifiers: readonly string[];
  seriesId: string;
  /** `time_of_day` (`13:15:00+00:00`); null when unrecorded. */
  timeOfDay: string | null;
  /** The row's own unit (`ft`, `ft^3/s`), for a code the parameter catalog lacks. */
  unit: string | null;
  /** Null when the upstream holds no value. */
  value: string | null;
}

/** One `field-measurements` row; `seriesId` is its `field_measurements_series_id`. */
export interface FieldMeasurement extends MeasurementRow {
  approvalStatus: string | null;
  controlCondition: string | null;
  measurementRated: string | null;
  observingProcedure: string | null;
  readingType: string | null;
  sublocation: string | null;
}

/** One `peaks` row; `seriesId` is its `time_series_id`. */
export interface PeakMeasurement extends MeasurementRow {
  peakSince: number | null;
  waterYear: number | null;
}

/** One series from `field-measurements-metadata`. */
export interface FieldSeriesMetadata {
  /** Earliest measurement, UTC. */
  begin: string | null;
  /** The series ID, the rows' `field_measurements_series_id`. */
  id: string;
  monitoringLocationId: string;
  parameterCd: string;
  /** The series' own parameter description, for a code the parameter catalog lacks. */
  parameterName: string | null;
  readingType: string | null;
  sublocation: string | null;
}

/** What turns field-measurement or peak rows into series beyond the rows themselves. */
export interface MeasurementContext {
  /** Site-local days `[first, last]` a record must fall on; the rows read can reach a day past each. */
  days: readonly [string, string];
  /** Parameter code → catalog record, the source of `unitCode` and `parameterName`. */
  parameters: ReadonlyMap<string, CatalogParameter>;
  /** Monitoring-location ID → site, for the number, name, and clock. */
  sites: ReadonlyMap<string, ResolvedSite>;
}

/** What turns rows into series beyond the rows themselves. */
export interface SeriesContext {
  /** Parameter code → catalog record, the source of `unitCode` and `parameterName`. */
  parameters: ReadonlyMap<string, CatalogParameter>;
  seriesType: 'daily' | 'instantaneous';
  /** Monitoring-location ID → site, for the number, name, and clock. */
  sites: ReadonlyMap<string, ResolvedSite>;
  /** Statistic code → name, for a daily series; unused for instantaneous values. */
  statisticNames: ReadonlyMap<string, string>;
}

/** The code WaterServices wrote for an approval status. */
const APPROVAL_CODES: ReadonlyMap<string, string> = new Map([
  ['Approved', 'A'],
  ['Provisional', 'P'],
]);

/**
 * The code WaterServices wrote for each qualifier word, matched record by record between the two
 * services: ESTIMATED ↔ `e` and REVISED ↔ `R` over every record of 01646500/00060; the rest on
 * live gages reporting each word, whose WaterServices descriptions confirm the pairing. `>` is the
 * counterpart of `<` in the same code table. A word missing here has no WaterServices code and
 * passes through as written.
 */
const QUALIFIER_CODES: ReadonlyMap<string, string> = new Map([
  ['BACKWATER', 'Bkw'],
  ['DISCONTINUED', 'Dis'],
  ['DRY', 'Dry'],
  ['EQUIP', 'Eqp'],
  ['ESTIMATED', 'e'],
  ['FLOOD', 'Fld'],
  ['GREATERTHAN', '>'],
  ['ICE', 'Ice'],
  ['LESSTHAN', '<'],
  ['MAINT', 'Mnt'],
  ['RATINGDEV', 'Rat'],
  ['REVISED', 'R'],
  ['SEASONAL', 'Ssn'],
  ['UNAVAIL', '***'],
  ['ZEROFLOW', 'ZFL'],
]);

/** Approval code first, then each qualifier, as WaterServices listed them. */
function qualifierCodes(approvalStatus: string | null, qualifiers: readonly string[]): string[] {
  const codes = approvalStatus ? [APPROVAL_CODES.get(approvalStatus) ?? approvalStatus] : [];
  for (const word of qualifiers) codes.push(QUALIFIER_CODES.get(word) ?? word);
  return codes;
}

/**
 * WaterServices' method label: the sublocation, then the description in brackets —
 * `From multiparameter sonde, [Discontinued]`, `[Radar]`, `Met station`. Null when the series has
 * neither, as WaterServices' empty label for a site's default sensor read.
 */
export function methodLabel(
  sublocation: string | null | undefined,
  webDescription: string | null | undefined,
): string | null {
  if (!webDescription) return sublocation || null;
  return sublocation ? `${sublocation}, [${webDescription}]` : `[${webDescription}]`;
}

/** What a series' metadata entry and each of its rows say about the series. */
interface SeriesIdentity {
  monitoringLocationId: string;
  parameterCd: string;
}

/**
 * One series gathered: its metadata entry, if listed, and its rows in the order read. `identity` is
 * the metadata entry, or the first row for a series the metadata does not list yet.
 */
interface SeriesGroup<M extends SeriesIdentity, R extends SeriesIdentity> {
  id: string;
  identity: M | R;
  metadata: M | undefined;
  rows: R[];
  site: ResolvedSite;
}

/**
 * One group per metadata entry — a series with no rows in the window stays, with none — plus one
 * per series that has rows but no metadata yet (the metadata refreshes at most daily). Rows and
 * metadata of a location outside `sites` are dropped.
 */
function groupBySeries<
  M extends SeriesIdentity & { id: string },
  R extends SeriesIdentity & { seriesId: string },
>(
  metadata: readonly M[],
  rows: readonly R[],
  sites: ReadonlyMap<string, ResolvedSite>,
): SeriesGroup<M, R>[] {
  const groups = new Map<string, { identity: M | R; metadata: M | undefined; rows: R[] }>();
  for (const m of metadata) groups.set(m.id, { identity: m, metadata: m, rows: [] });
  for (const row of rows) {
    if (!sites.has(row.monitoringLocationId)) continue;
    let group = groups.get(row.seriesId);
    if (!group) {
      group = { identity: row, metadata: undefined, rows: [] };
      groups.set(row.seriesId, group);
    }
    group.rows.push(row);
  }
  return [...groups].flatMap(([id, group]) => {
    const site = sites.get(group.identity.monitoringLocationId);
    return site ? [{ id, site, ...group }] : [];
  });
}

/**
 * Series by site number, parameter code, statistic code (none for field and peak series), first
 * observation, then ID.
 */
function orderSeries<S extends { parameterCd: string; siteNumber: string; statCd: string | null }>(
  built: { begin: string | null; id: string; series: S }[],
): S[] {
  return built
    .sort(
      (a, b) =>
        compare(a.series.siteNumber, b.series.siteNumber) ||
        compare(a.series.parameterCd, b.series.parameterCd) ||
        compare(a.series.statCd ?? '', b.series.statCd ?? '') ||
        compareBegin(a.begin, b.begin) ||
        compare(a.id, b.id),
    )
    .map(({ series }) => series);
}

/**
 * The site, parameter, and unit fields every series leads with. The parameter catalog names the
 * parameter and its unit; the series' own text fills in for a code the catalog lacks.
 */
function seriesNaming(
  context: { parameters: ReadonlyMap<string, CatalogParameter> },
  site: ResolvedSite,
  parameterCd: string,
  own: { name: string | null | undefined; unit: string | null | undefined },
) {
  const parameter = context.parameters.get(parameterCd);
  return {
    siteNumber: site.siteNumber,
    siteName: site.siteName ?? '',
    parameterCd,
    parameterName: parameter?.description ?? own.name ?? '',
    unitCode: parameter?.unit ?? own.unit ?? '',
  };
}

function record(row: Observation, context: SeriesContext, site: ResolvedSite): NwisValueRecord {
  return {
    dateTime:
      context.seriesType === 'daily'
        ? `${row.time}T00:00:00.000`
        : toSiteLocalTimestamp(row.time, site.timeZone),
    value: row.value ?? '',
    qualifiers: qualifierCodes(row.approvalStatus, row.qualifiers),
  };
}

/**
 * One series per metadata entry — a sensor with no rows in the window stays, with no values — plus
 * one per time series that has rows but no metadata yet (the metadata refreshes at most daily).
 * Records run oldest first, one per time, so rows read twice across query chunks count once.
 * Series run by site number, parameter code, statistic code, and first observation.
 */
export function assembleSeries(
  metadata: readonly SeriesMetadata[],
  rows: readonly Observation[],
  context: SeriesContext,
): NwisTimeSeries[] {
  const daily = context.seriesType === 'daily';
  const groups = groupBySeries(metadata, rows, context.sites);
  return orderSeries(
    groups.map(({ id, identity, metadata: m, rows: seriesRows, site }) => {
      const records = new Map<number, NwisValueRecord>();
      for (const row of seriesRows) {
        const timeMs = Date.parse(row.time);
        if (!records.has(timeMs)) records.set(timeMs, record(row, context, site));
      }
      const statCd = daily ? (identity.statCd ?? '') : '00000';
      return {
        begin: m?.begin ?? null,
        id,
        series: {
          ...seriesNaming(context, site, identity.parameterCd, {
            name: m?.parameterName,
            unit: m?.unit,
          }),
          statCd,
          statName: daily ? (context.statisticNames.get(statCd) ?? null) : null,
          methodId: id,
          methodDescription: methodLabel(m?.sublocation ?? null, m?.webDescription ?? null),
          values: [...records.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
        },
      };
    }),
  );
}

/** When a field measurement or peak happened, as each use of it needs. */
interface MeasurementTime {
  /** The record's `dateTime`: the instant on the site's clock, or the bare date. */
  dateTime: string;
  /** The site-local date, or the bare date when no time of day is known. */
  localDate: string;
  /** For ordering: the instant, or 00:00 UTC on the bare date. */
  sortMs: number;
  unknownDatePart: 'month' | 'day' | null;
}

function measurementTime(row: MeasurementRow, zone: SiteTimeZone | null): MeasurementTime {
  const unknownDatePart = row.month === null ? 'month' : row.day === null ? 'day' : null;
  if (row.timeOfDay === null) {
    return {
      dateTime: row.date,
      localDate: row.date,
      sortMs: Date.parse(`${row.date}T00:00:00Z`),
      unknownDatePart,
    };
  }
  const instant = measuredInstant(row.date, row.timeOfDay);
  const instantMs = Date.parse(instant);
  return {
    dateTime: toSiteLocalTimestamp(instant, zone),
    localDate: siteLocalDate(instantMs, zone),
    sortMs: instantMs,
    unknownDatePart,
  };
}

/**
 * The groups of `rows` with each group's records on the context's days, oldest first. Every record
 * is kept, two on one date included: a series is read in one query, so no row arrives twice.
 */
function measurementGroups<
  M extends SeriesIdentity & { id: string },
  R extends MeasurementRow,
  V extends NwisValueRecord,
>(
  metadata: readonly M[],
  rows: readonly R[],
  context: MeasurementContext,
  toRecord: (row: R, time: MeasurementTime) => V,
): (SeriesGroup<M, R> & { values: V[] })[] {
  const [first, last] = context.days;
  return groupBySeries(metadata, rows, context.sites).map((group) => {
    const dated = group.rows.flatMap((row) => {
      const time = measurementTime(row, group.site.timeZone);
      return time.localDate >= first && time.localDate <= last
        ? [{ sortMs: time.sortMs, value: toRecord(row, time) }]
        : [];
    });
    return { ...group, values: dated.sort((a, b) => a.sortMs - b.sortMs).map((d) => d.value) };
  });
}

/**
 * One series per `field-measurements-metadata` entry (a reading type of the parameter), one with no
 * records on the days included, plus one per series that has rows but no metadata yet. Each record
 * carries the approval code and qualifiers, the observing procedure, and a discharge measurement's
 * rating and control condition.
 */
export function assembleFieldSeries(
  metadata: readonly FieldSeriesMetadata[],
  rows: readonly FieldMeasurement[],
  context: MeasurementContext,
): FieldSeries[] {
  const groups = measurementGroups(
    metadata,
    rows,
    context,
    (row, time): FieldValueRecord => ({
      dateTime: time.dateTime,
      value: row.value ?? '',
      qualifiers: qualifierCodes(row.approvalStatus, row.qualifiers),
      unknownDatePart: time.unknownDatePart,
      observingProcedure: row.observingProcedure,
      measurementRated: row.measurementRated,
      controlCondition: row.controlCondition,
    }),
  );
  return orderSeries(
    groups.map(({ id, identity, metadata: m, rows, site, values }) => ({
      begin: m?.begin ?? null,
      id,
      series: {
        ...seriesNaming(context, site, identity.parameterCd, {
          name: m?.parameterName,
          unit: rows[0]?.unit,
        }),
        seriesType: 'field' as const,
        statCd: null,
        statName: null,
        methodId: id,
        methodDescription: methodLabel(identity.sublocation, identity.readingType),
        readingType: identity.readingType,
        values,
      },
    })),
  );
}

/**
 * One series per `time-series-metadata` entry computed {@link PEAK_COMPUTATION}, one with no peaks on
 * the days included, plus one per series that has peaks but no metadata yet. Each record carries
 * its water year, `peak_since`, and qualifiers; peaks carry no approval status.
 */
export function assemblePeakSeries(
  metadata: readonly SeriesMetadata[],
  rows: readonly PeakMeasurement[],
  context: MeasurementContext,
): PeakSeries[] {
  const groups = measurementGroups(
    metadata,
    rows,
    context,
    (row, time): PeakValueRecord => ({
      dateTime: time.dateTime,
      value: row.value ?? '',
      qualifiers: qualifierCodes(null, row.qualifiers),
      unknownDatePart: time.unknownDatePart,
      waterYear: row.waterYear,
      peakSince: row.peakSince,
    }),
  );
  return orderSeries(
    groups.map(({ id, identity, metadata: m, rows, site, values }) => ({
      begin: m?.begin ?? null,
      id,
      series: {
        ...seriesNaming(context, site, identity.parameterCd, {
          name: m?.parameterName,
          unit: m?.unit ?? rows[0]?.unit,
        }),
        seriesType: 'peak' as const,
        statCd: null,
        statName: null,
        methodId: id,
        methodDescription: methodLabel(m?.sublocation ?? null, m?.webDescription ?? null),
        values,
      },
    })),
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A series known only from its rows began inside the window, after every listed one. */
function compareBegin(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compare(a, b);
}

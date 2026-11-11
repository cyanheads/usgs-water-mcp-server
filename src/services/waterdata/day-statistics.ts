/**
 * @fileoverview Day-of-year percentiles for one site and parameter from the USGS Water Data
 * Statistics API, the replacement for the WaterServices stat service. Only daily-mean series rank
 * a reading (`parent_statistic_id` 00003; the API also publishes daily-maximum and daily-minimum
 * normals), and the series is paired with the reporting sensor by time-series ID:
 * `time-series-metadata` names the instantaneous series each daily-mean series is computed from,
 * and the Statistics API keys its normals and intervals by the daily-mean series. The period of
 * record is the first and last water year whose monthly interval holds the calendar day.
 * @module services/waterdata/day-statistics
 */

import { z } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { methodLabel } from './observation-series.js';
import { resolveSites } from './site-resolver.js';
import { fetchOgcItems, fetchStatistics, type WaterDataRequest } from './water-data-client.js';
import { SERVICE_NAME } from './water-data-errors.js';

/** Statistic code of a daily mean. */
const DAILY_MEAN = '00003';

/** A daily-mean series at the site, as `time-series-metadata` lists it. */
export interface DailyMeanSeries {
  /**
   * `<sublocation>, [<web description>]`, either part alone when the other is blank (e.g.
   * "AUXILIARY GAGE, [AUXILIARY GAGE]", "[BASE GAGE]"); null when both are blank.
   */
  description: string | null;
  /** The series' time-series ID — the Statistics API's `parent_time_series_id`. */
  id: string;
  /** The instantaneous series it is computed from; null when the metadata names none. */
  sourceSeriesId: string | null;
}

/** The daily-mean series one site keeps for one parameter. */
export interface SiteDailyMeans {
  /** Agency-prefixed identifier the Statistics API takes (`USGS-01646500`). */
  monitoringLocationId: string;
  parameterCd: string;
  series: DailyMeanSeries[];
}

/** One calendar day's daily-mean percentiles, in the API's order; null where it publishes "nan". */
export interface DayPercentiles {
  p05: number | null;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p95: number | null;
}

/** The daily-mean series a reading is ranked against. */
export interface RankedSeries {
  description: string | null;
  id: string;
  percentiles: DayPercentiles;
  /** First and last water year whose approved monthly record holds the calendar day. */
  periodOfRecord: { firstWaterYear: number; lastWaterYear: number };
}

/** What the statistics hold for a reading's calendar day. */
export type DayStatistics =
  /** `matched`: the series is the daily mean of the reading's own sensor series. */
  | { matched: boolean; series: RankedSeries; status: 'available' }
  /** The reading's daily-mean series has an approved record, but no percentiles for this day. */
  | { status: 'no_matching_day' }
  /** Several daily-mean series have percentiles for the day and none is the reading's. */
  | { candidates: { description: string | null; id: string }[]; status: 'no_matching_method' }
  /** No daily-mean percentiles exist for the day. */
  | { status: 'no_record' };

const MetadataSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    parent_time_series_id: z.string().nullish(),
    sublocation_identifier: z.string().nullish(),
    web_description: z.string().nullish(),
  }),
});

/** A Statistics API number: a decimal string, or "nan" where no value is published. */
const StatisticValue = z
  .string()
  .regex(/^(nan|-?\d+(\.\d+)?([eE][-+]?\d+)?)$/, 'expected a decimal number or "nan"')
  .transform((value) => (value === 'nan' ? null : Number(value)));

const NormalValueSchema = z
  .object({
    computation: z.string(),
    time_of_year: z.string(),
    percentiles: z.array(z.string()).optional(),
    values: z.array(StatisticValue).optional(),
  })
  .refine(
    (v) =>
      v.computation !== 'percentile' ||
      (v.percentiles !== undefined && v.percentiles.length === v.values?.length),
    'a percentile computation needs one value per percentile',
  );

const NormalsFeatureSchema = z.object({
  properties: z.object({
    data: z.array(
      z.object({
        parent_time_series_id: z.string().min(1),
        parent_statistic_id: z.string(),
        values: z.array(NormalValueSchema),
      }),
    ),
  }),
});

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const IntervalsFeatureSchema = z.object({
  properties: z.object({
    data: z.array(
      z.object({
        parent_time_series_id: z.string().min(1),
        values: z.array(z.object({ start_date: IsoDate, end_date: IsoDate })),
      }),
    ),
  }),
});

type MonthlyInterval = { end_date: string; start_date: string };

/** The output field each published percentile fills; the API's 90th has none. */
const PERCENTILE_FIELDS: ReadonlyMap<string, keyof DayPercentiles> = new Map([
  ['5', 'p05'],
  ['10', 'p10'],
  ['25', 'p25'],
  ['50', 'p50'],
  ['75', 'p75'],
  ['95', 'p95'],
]);

/**
 * Resolve the site and list its daily-mean series for the parameter.
 *
 * @throws {McpError} `not_found` when no monitoring location has the number (no metadata request
 * is sent); otherwise whatever the Water Data client raises.
 */
export async function getDailyMeanSeries(
  siteNumber: string,
  parameterCd: string,
  request: WaterDataRequest,
): Promise<SiteDailyMeans> {
  const site = (await resolveSites([siteNumber], request)).get(siteNumber);
  if (!site) {
    throw notFound(`No USGS monitoring location has site number ${siteNumber}.`, {
      reason: 'not_found',
      siteNumber,
    });
  }
  const query = new URLSearchParams({
    monitoring_location_id: site.monitoringLocationId,
    parameter_code: parameterCd,
    computation_period_identifier: 'Daily',
    statistic_id: DAILY_MEAN,
    skipGeometry: 'true',
    properties: 'parent_time_series_id,sublocation_identifier,web_description',
    limit: '1000',
  });
  const features = await fetchOgcItems('time-series-metadata', query, MetadataSchema, request);
  return {
    monitoringLocationId: site.monitoringLocationId,
    parameterCd,
    series: features.map(({ id, properties: p }) => ({
      id,
      sourceSeriesId: p.parent_time_series_id || null,
      description: methodLabel(p.sublocation_identifier, p.web_description),
    })),
  };
}

/** The day's percentiles of every daily-mean series, keyed by series ID. */
async function readDayPercentiles(
  site: SiteDailyMeans,
  monthDay: string,
  request: WaterDataRequest,
): Promise<Map<string, DayPercentiles>> {
  const query = new URLSearchParams({
    monitoring_location_id: site.monitoringLocationId,
    parameter_code: site.parameterCd,
    normal_type: 'DOY',
    computation_type: 'percentile',
    start_date: monthDay,
    end_date: monthDay,
  });
  const features = await fetchStatistics(
    'observationNormals',
    query,
    NormalsFeatureSchema,
    request,
  );
  const days = new Map<string, DayPercentiles>();
  for (const series of features.flatMap((f) => f.properties.data)) {
    if (series.parent_statistic_id !== DAILY_MEAN) continue;
    const day = series.values.find(
      (v) => v.computation === 'percentile' && v.time_of_year === monthDay,
    );
    if (!day?.percentiles || !day.values) continue;
    const percentiles: DayPercentiles = {
      p05: null,
      p10: null,
      p25: null,
      p50: null,
      p75: null,
      p95: null,
    };
    for (const [i, label] of day.percentiles.entries()) {
      const field = PERCENTILE_FIELDS.get(label);
      if (field) percentiles[field] = day.values[i] ?? null;
    }
    days.set(series.parent_time_series_id, percentiles);
  }
  return days;
}

/** Every approved month of one daily-mean series, as `start_date`–`end_date` spans. */
async function readMonthlyIntervals(
  site: SiteDailyMeans,
  seriesId: string,
  request: WaterDataRequest,
): Promise<MonthlyInterval[]> {
  const query = new URLSearchParams({
    monitoring_location_id: site.monitoringLocationId,
    parameter_code: site.parameterCd,
    interval_type: 'M',
    computation_type: 'arithmetic_mean',
    parent_time_series_id: seriesId,
  });
  const features = await fetchStatistics(
    'observationIntervals',
    query,
    IntervalsFeatureSchema,
    request,
  );
  return features
    .flatMap((f) => f.properties.data)
    .filter((series) => series.parent_time_series_id === seriesId)
    .flatMap((series) => series.values);
}

/**
 * The first and last water year whose monthly interval holds `monthDay` — the span WaterServices
 * published as `begin_yr`–`end_yr`. A month interval runs from its first to its last approved day,
 * so a partly approved month holds only the days inside that span; February 29 falls inside no
 * common year's February, whose interval ends on the 28th. October–December belong to the next
 * water year.
 *
 * @throws {McpError} `upstream_error` when no interval holds the day — percentiles published for a
 * day the approved record never covers contradict each other.
 */
function periodOfRecord(
  intervals: readonly MonthlyInterval[],
  monthDay: string,
  seriesId: string,
  request: WaterDataRequest,
): RankedSeries['periodOfRecord'] {
  const nextWaterYear = Number(monthDay.slice(0, 2)) >= 10 ? 1 : 0;
  const years = intervals.flatMap(({ start_date: start, end_date: end }) => {
    const day = `${start.slice(0, 4)}-${monthDay}`;
    return start <= day && day <= end ? [Number(start.slice(0, 4)) + nextWaterYear] : [];
  });
  if (years.length === 0) {
    throw serviceUnavailable(
      `${SERVICE_NAME.statistics} published ${monthDay} percentiles for series ${seriesId} but no approved month that holds ${monthDay} (${request.operation}).`,
      { reason: 'upstream_error', retryable: false },
    );
  }
  return { firstWaterYear: Math.min(...years), lastWaterYear: Math.max(...years) };
}

/**
 * The daily-mean percentiles for a reading's calendar day (`MM-DD`, the observation's own date),
 * from the series computed from the reading's sensor (`sourceSeriesId`, the reading's
 * instantaneous time-series ID) when it has them. Otherwise the site's only series with
 * percentiles that day is used, unmatched; several yield `no_matching_method`. Sends the day's
 * normals and — when the reading has a daily-mean series — its monthly intervals at once; an
 * unmatched series costs one more intervals request.
 *
 * @throws {McpError} whatever the Water Data client raises, and `upstream_error` for percentiles
 * the approved record contradicts.
 */
export async function getDayStatistics(
  site: SiteDailyMeans,
  monthDay: string,
  sourceSeriesId: string | null,
  request: WaterDataRequest,
): Promise<DayStatistics> {
  const own =
    sourceSeriesId === null
      ? undefined
      : site.series.find((series) => series.sourceSeriesId === sourceSeriesId);
  const [normals, ownRecord] = await Promise.allSettled([
    readDayPercentiles(site, monthDay, request),
    own ? readMonthlyIntervals(site, own.id, request) : Promise.resolve([]),
  ]);
  if (normals.status === 'rejected') throw normals.reason;
  if (ownRecord.status === 'rejected') throw ownRecord.reason;
  const days = normals.value;
  /** A series with percentiles but no metadata row (none seen live) is described as blank. */
  const describe = (id: string) =>
    site.series.find((series) => series.id === id)?.description ?? null;
  const ranked = (id: string, percentiles: DayPercentiles, intervals: MonthlyInterval[]) => ({
    id,
    description: describe(id),
    percentiles,
    periodOfRecord: periodOfRecord(intervals, monthDay, id, request),
  });

  const ownDay = own && days.get(own.id);
  if (own && ownDay) {
    return { status: 'available', matched: true, series: ranked(own.id, ownDay, ownRecord.value) };
  }
  if (own && ownRecord.value.length > 0) return { status: 'no_matching_day' };
  const [only, ...others] = days;
  if (!only) return { status: 'no_record' };
  if (others.length > 0) {
    return {
      status: 'no_matching_method',
      candidates: [...days.keys()].map((id) => ({ id, description: describe(id) })),
    };
  }
  const [id, percentiles] = only;
  const intervals = await readMonthlyIntervals(site, id, request);
  return { status: 'available', matched: false, series: ranked(id, percentiles, intervals) };
}

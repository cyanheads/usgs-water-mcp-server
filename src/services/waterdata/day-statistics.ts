/**
 * @fileoverview Day-of-year percentiles for many sites and one parameter from the USGS Water Data
 * Statistics API, the replacement for the WaterServices stat service. Only daily-mean series rank
 * a reading (`parent_statistic_id` 00003; the API also publishes daily-maximum and daily-minimum
 * normals), and the series is paired with the reporting sensor by time-series ID:
 * `time-series-metadata` names the instantaneous series each daily-mean series is computed from,
 * and the Statistics API keys its normals and intervals by the daily-mean series. The period of
 * record is the first and last water year whose monthly interval holds the calendar day.
 *
 * Every read takes many sites at once: the daily-mean metadata by `monitoring_location_id IN (…)`,
 * the normals by repeated `monitoring_location_id` (one read per calendar day), and the monthly
 * intervals by repeated `parent_time_series_id`. Statistics reads are chunked to stay under the
 * API's URL limit; each chunk settles on its own, so a failed one leaves only the readings it
 * covered without statistics, and every request draws on the caller's one deadline.
 * @module services/waterdata/day-statistics
 */

import { z } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { cqlIn } from './cql2-text.js';
import { methodLabel } from './observation-series.js';
import { mapConcurrent } from './observations.js';
import { type ResolvedSite, resolveSites } from './site-resolver.js';
import {
  fetchOgcItems,
  fetchStatistics,
  type StatisticsEndpoint,
  statisticsUrl,
  type WaterDataRequest,
} from './water-data-client.js';
import { SERVICE_NAME } from './water-data-errors.js';

/** Statistic code of a daily mean. */
const DAILY_MEAN = '00003';

/**
 * Every Statistics request URL stays shorter than this. The API answers a long URL with HTTP 403
 * and an HTML page — 52 eight-digit locations passed at 2,086 characters, 53 failed at 2,123.
 */
const STATISTICS_URL_LIMIT = 2_048;

/** Room kept for the `next_token` a later page appends (observed tokens run 22 characters). */
const NEXT_TOKEN_ROOM = 64;

/**
 * Series per `observationIntervals` request. Upstream time grows with the series a request names
 * (one 26-series read took ~1.85× the wall time of two concurrent 13-series halves).
 */
const INTERVAL_SERIES_PER_REQUEST = 25;

/** Statistics requests one stage keeps in flight. */
const STATISTICS_CONCURRENCY = 4;

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

/** One reading to rank. */
export interface DayStatisticsQuery {
  /** The reading's own calendar day, `MM-DD`, from its site-local timestamp. */
  monthDay: string;
  /** The reading's site, with the daily-mean series {@link getDailyMeanSeries} listed for it. */
  site: SiteDailyMeans;
  /** The reading's instantaneous time-series ID (its `methodId`); null when it carries none. */
  sourceSeriesId: string | null;
}

const MetadataSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    monitoring_location_id: z.string().min(1),
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
    monitoring_location_id: z.string().min(1),
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

/** One day's percentiles of every daily-mean series at a location, keyed by series ID. */
type SeriesPercentiles = ReadonlyMap<string, DayPercentiles>;

/** The output field each published percentile fills; the API's 90th has none. */
const PERCENTILE_FIELDS: ReadonlyMap<string, keyof DayPercentiles> = new Map([
  ['5', 'p05'],
  ['10', 'p10'],
  ['25', 'p25'],
  ['50', 'p50'],
  ['75', 'p75'],
  ['95', 'p95'],
]);

/** `work`'s outcome as a value; the caller's cancellation is rethrown, never settled. */
async function settle<T>(
  work: Promise<T>,
  request: WaterDataRequest,
): Promise<PromiseSettledResult<T>> {
  try {
    return { status: 'fulfilled', value: await work };
  } catch (reason) {
    if (request.signal?.aborted) throw reason;
    return { status: 'rejected', reason };
  }
}

/** The daily-mean series of each location, in one read (paged by `next` links when long). */
async function readDailyMeans(
  sites: readonly ResolvedSite[],
  parameterCd: string,
  request: WaterDataRequest,
): Promise<Map<string, DailyMeanSeries[]>> {
  const locations = cqlIn(
    'monitoring_location_id',
    sites.map((site) => site.monitoringLocationId),
  );
  const query = new URLSearchParams({
    'filter-lang': 'cql2-text',
    filter: `${locations} AND ${cqlIn('parameter_code', [parameterCd])}`,
    computation_period_identifier: 'Daily',
    statistic_id: DAILY_MEAN,
    skipGeometry: 'true',
    properties:
      'monitoring_location_id,parent_time_series_id,sublocation_identifier,web_description',
    limit: '1000',
  });
  const features = await fetchOgcItems('time-series-metadata', query, MetadataSchema, request);
  const byLocation = new Map<string, DailyMeanSeries[]>();
  for (const { id, properties: p } of features) {
    const series = byLocation.get(p.monitoring_location_id) ?? [];
    series.push({
      id,
      sourceSeriesId: p.parent_time_series_id || null,
      description: methodLabel(p.sublocation_identifier, p.web_description),
    });
    byLocation.set(p.monitoring_location_id, series);
  }
  return byLocation;
}

/**
 * Resolve each site and list its daily-mean series for the parameter — one `time-series-metadata`
 * read for every site that resolves, sharing the resolver's request with any reading lookup in
 * flight for the same numbers. Each distinct number maps, in input order, to its own outcome:
 * fulfilled with its series (empty when it keeps none), or rejected with `not_found` when no
 * monitoring location has the number (no metadata is read for it), or with the resolution or
 * metadata failure that left its series unknown.
 *
 * @throws the caller's cancellation; every other failure is a rejected entry.
 */
export async function getDailyMeanSeries(
  siteNumbers: readonly string[],
  parameterCd: string,
  request: WaterDataRequest,
): Promise<Map<string, PromiseSettledResult<SiteDailyMeans>>> {
  const numbers = [...new Set(siteNumbers)];
  const resolution = await settle(resolveSites(numbers, request), request);
  if (resolution.status === 'rejected') {
    return new Map(numbers.map((number) => [number, resolution]));
  }
  const resolved = resolution.value;
  const sites = numbers.flatMap((number) => resolved.get(number) ?? []);
  const listing =
    sites.length === 0
      ? { status: 'fulfilled' as const, value: new Map<string, DailyMeanSeries[]>() }
      : await settle(readDailyMeans(sites, parameterCd, request), request);
  return new Map(
    numbers.map((siteNumber): [string, PromiseSettledResult<SiteDailyMeans>] => {
      const site = resolved.get(siteNumber);
      if (!site) {
        const reason = notFound(`No USGS monitoring location has site number ${siteNumber}.`, {
          reason: 'not_found',
          siteNumber,
        });
        return [siteNumber, { status: 'rejected', reason }];
      }
      if (listing.status === 'rejected') return [siteNumber, listing];
      const { monitoringLocationId } = site;
      const series = listing.value.get(monitoringLocationId) ?? [];
      return [
        siteNumber,
        { status: 'fulfilled', value: { monitoringLocationId, parameterCd, series } },
      ];
    }),
  );
}

/** One normals request's percentiles, by location: each location's daily-mean series for the day. */
async function readDayPercentiles(
  query: URLSearchParams,
  monthDay: string,
  request: WaterDataRequest,
): Promise<Map<string, SeriesPercentiles>> {
  const features = await fetchStatistics(
    'observationNormals',
    query,
    NormalsFeatureSchema,
    request,
  );
  const byLocation = new Map<string, Map<string, DayPercentiles>>();
  for (const { properties } of features) {
    const days = byLocation.get(properties.monitoring_location_id) ?? new Map();
    byLocation.set(properties.monitoring_location_id, days);
    for (const series of properties.data) {
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
  }
  return byLocation;
}

/** One intervals request's approved months, by daily-mean series ID. */
async function readMonthlyIntervals(
  query: URLSearchParams,
  request: WaterDataRequest,
): Promise<Map<string, MonthlyInterval[]>> {
  const features = await fetchStatistics(
    'observationIntervals',
    query,
    IntervalsFeatureSchema,
    request,
  );
  const bySeries = new Map<string, MonthlyInterval[]>();
  for (const series of features.flatMap((f) => f.properties.data)) {
    const months = bySeries.get(series.parent_time_series_id) ?? [];
    months.push(...series.values);
    bySeries.set(series.parent_time_series_id, months);
  }
  return bySeries;
}

/**
 * Keys one batch reads under the same fixed parameters — a day's locations, or a parameter's
 * series — each with the resolver for what its request settles to.
 */
interface ReadGroup<V> {
  /** The value of a key its request answered without. */
  absent: V;
  endpoint: StatisticsEndpoint;
  /** Parameters every request of the group sends. */
  fixed: URLSearchParams;
  keys: Map<string, PromiseWithResolvers<PromiseSettledResult<V>>>;
  maxPerRequest: number;
  /** Send one request — the fixed parameters plus its keys — and read its values by key. */
  read: (query: URLSearchParams) => Promise<ReadonlyMap<string, V>>;
  /** The parameter repeated once per key. */
  repeated: 'monitoring_location_id' | 'parent_time_series_id';
}

function normalsGroup(
  parameterCd: string,
  monthDay: string,
  request: WaterDataRequest,
): ReadGroup<SeriesPercentiles> {
  return {
    absent: new Map(),
    endpoint: 'observationNormals',
    fixed: new URLSearchParams({
      parameter_code: parameterCd,
      normal_type: 'DOY',
      computation_type: 'percentile',
      start_date: monthDay,
      end_date: monthDay,
    }),
    keys: new Map(),
    maxPerRequest: Number.POSITIVE_INFINITY,
    read: (query) => readDayPercentiles(query, monthDay, request),
    repeated: 'monitoring_location_id',
  };
}

/** Monthly intervals by series ID alone: the location ID changes nothing in the response. */
function intervalsGroup(
  parameterCd: string,
  request: WaterDataRequest,
): ReadGroup<readonly MonthlyInterval[]> {
  return {
    absent: [],
    endpoint: 'observationIntervals',
    fixed: new URLSearchParams({
      parameter_code: parameterCd,
      interval_type: 'M',
      computation_type: 'arithmetic_mean',
    }),
    keys: new Map(),
    maxPerRequest: INTERVAL_SERIES_PER_REQUEST,
    read: (query) => readMonthlyIntervals(query, request),
    repeated: 'parent_time_series_id',
  };
}

/** Add `key` to group `id` (made when new) and return what the read that names it will settle to. */
function enlist<V>(
  groups: Map<string, ReadGroup<V>>,
  id: string,
  make: () => ReadGroup<V>,
  key: string,
): Promise<PromiseSettledResult<V>> {
  let group = groups.get(id);
  if (!group) {
    group = make();
    groups.set(id, group);
  }
  let entry = group.keys.get(key);
  if (!entry) {
    entry = Promise.withResolvers();
    group.keys.set(key, entry);
  }
  return entry.promise;
}

/**
 * Split a group's keys into the fewest requests that each name at most `maxPerRequest` keys and
 * keep the URL under {@link STATISTICS_URL_LIMIT} with {@link NEXT_TOKEN_ROOM} to spare, balanced
 * in count so concurrent requests run about as long. Lengths are of the URL as sent,
 * percent-encoding included: the fixed query, then `&<repeated>=<key>` per key.
 */
function chunkKeys<T>(
  group: Pick<ReadGroup<unknown>, 'endpoint' | 'fixed' | 'maxPerRequest' | 'repeated'>,
  items: readonly [string, T][],
): [string, T][][] {
  const base = statisticsUrl(group.endpoint, group.fixed).href.length;
  const budget = STATISTICS_URL_LIMIT - 1 - NEXT_TOKEN_ROOM - base;
  const sizes = items.map(
    ([key]) => new URLSearchParams([[group.repeated, key]]).toString().length + 1,
  );
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const fewest = Math.ceil(Math.max(items.length / group.maxPerRequest, total / budget, 1));
  for (let count = fewest; count < items.length; count++) {
    const chunks: [string, T][][] = [];
    let fits = true;
    for (let i = 0, start = 0; i < count; i++) {
      const end = start + Math.floor(items.length / count) + (i < items.length % count ? 1 : 0);
      const length = sizes.slice(start, end).reduce((sum, size) => sum + size, 0);
      if (end - start > group.maxPerRequest || length > budget) fits = false;
      chunks.push(items.slice(start, end));
      start = end;
    }
    if (fits) return chunks;
  }
  return items.map((item) => [item]);
}

/**
 * Send every group's requests, each settling on its own so a failure never cancels its siblings,
 * and resolve each key with its value from the request that named it — the group's `absent` value
 * when that request answered without it — or that request's failure.
 *
 * @throws the caller's cancellation.
 */
async function readGroups<V>(
  groups: Iterable<ReadGroup<V>>,
  request: WaterDataRequest,
): Promise<void> {
  const reads = [...groups].flatMap((group) =>
    chunkKeys(group, [...group.keys]).map((entries) => ({ entries, group })),
  );
  await mapConcurrent(reads, STATISTICS_CONCURRENCY, async ({ entries, group }) => {
    const query = new URLSearchParams(group.fixed);
    for (const [key] of entries) query.append(group.repeated, key);
    const outcome = await settle(group.read(query), request);
    for (const [key, entry] of entries) {
      entry.resolve(
        outcome.status === 'rejected'
          ? outcome
          : { status: 'fulfilled', value: outcome.value.get(key) ?? group.absent },
      );
    }
  });
}

/**
 * The first and last water year whose monthly interval holds `monthDay` — the span WaterServices
 * published as `begin_yr`–`end_yr` — or undefined when none does. A month interval runs from its
 * first to its last approved day, so a partly approved month holds only the days inside that span;
 * February 29 falls inside no common year's February, whose interval ends on the 28th.
 * October–December belong to the next water year.
 */
function periodOfRecord(
  intervals: readonly MonthlyInterval[],
  monthDay: string,
): RankedSeries['periodOfRecord'] | undefined {
  const nextWaterYear = Number(monthDay.slice(0, 2)) >= 10 ? 1 : 0;
  const years = intervals.flatMap(({ start_date: start, end_date: end }) => {
    const day = `${start.slice(0, 4)}-${monthDay}`;
    return start <= day && day <= end ? [Number(start.slice(0, 4)) + nextWaterYear] : [];
  });
  if (years.length === 0) return undefined;
  return { firstWaterYear: Math.min(...years), lastWaterYear: Math.max(...years) };
}

/** A reading to rank, with the daily-mean series computed from its sensor, if the site keeps one. */
interface Row extends DayStatisticsQuery {
  own: DailyMeanSeries | undefined;
}

/** "A series with percentiles but no metadata row" (none seen live) is described as blank. */
function describe(row: Row, id: string): string | null {
  return row.site.series.find((series) => series.id === id)?.description ?? null;
}

/**
 * The reading ranked against series `id` — or `upstream_error` (that row only) when no approved
 * month holds the day: percentiles published for a day the record never covers contradict it.
 */
function rankAgainst(
  row: Row,
  matched: boolean,
  [id, percentiles]: [string, DayPercentiles],
  intervals: readonly MonthlyInterval[],
  request: WaterDataRequest,
): PromiseSettledResult<DayStatistics> {
  const period = periodOfRecord(intervals, row.monthDay);
  if (!period) {
    const reason = serviceUnavailable(
      `${SERVICE_NAME.statistics} published ${row.monthDay} percentiles for series ${id} but no approved month that holds ${row.monthDay} (${request.operation}).`,
      { reason: 'upstream_error', retryable: false },
    );
    return { status: 'rejected', reason };
  }
  const series = { id, description: describe(row, id), percentiles, periodOfRecord: period };
  return { status: 'fulfilled', value: { status: 'available', matched, series } };
}

/**
 * A row's outcome from its day's normals and its own series' record, or the site's only series
 * with percentiles that day, whose record is still to read. A failed read fails the row — the
 * normals' failure first — whether or not the outcome needed it.
 */
function firstPass(
  row: Row,
  normals: PromiseSettledResult<SeriesPercentiles>,
  ownRecord: PromiseSettledResult<readonly MonthlyInterval[]>,
  request: WaterDataRequest,
): { outcome: PromiseSettledResult<DayStatistics> } | { only: [string, DayPercentiles] } {
  if (normals.status === 'rejected') return { outcome: normals };
  if (ownRecord.status === 'rejected') return { outcome: ownRecord };
  const days = normals.value;
  const ownDay = row.own && days.get(row.own.id);
  if (row.own && ownDay) {
    return { outcome: rankAgainst(row, true, [row.own.id, ownDay], ownRecord.value, request) };
  }
  const fulfilled = (value: DayStatistics) => ({
    outcome: { status: 'fulfilled' as const, value },
  });
  if (row.own && ownRecord.value.length > 0) return fulfilled({ status: 'no_matching_day' });
  const [only, ...others] = days;
  if (!only) return fulfilled({ status: 'no_record' });
  if (others.length > 0) {
    return fulfilled({
      status: 'no_matching_method',
      candidates: [...days.keys()].map((id) => ({ id, description: describe(row, id) })),
    });
  }
  return { only };
}

/** A row with what its normals and own-series record will settle to. */
interface PendingRow {
  index: number;
  normals: Promise<PromiseSettledResult<SeriesPercentiles>>;
  ownRecord: Promise<PromiseSettledResult<readonly MonthlyInterval[]>>;
  row: Row;
}

/**
 * Rank rows whose reads have all settled, reading the record of each unmatched row's only series
 * in one batch, and put each outcome in `results` at the row's index.
 */
async function rankRows(
  pending: readonly PendingRow[],
  results: PromiseSettledResult<DayStatistics>[],
  request: WaterDataRequest,
): Promise<void> {
  const fallbackGroups = new Map<string, ReadGroup<readonly MonthlyInterval[]>>();
  const unmatched = await Promise.all(
    pending.map(async ({ index, normals, ownRecord, row }) => {
      const pass = firstPass(row, await normals, await ownRecord, request);
      if ('outcome' in pass) {
        results[index] = pass.outcome;
        return [];
      }
      const { parameterCd } = row.site;
      const make = () => intervalsGroup(parameterCd, request);
      const record = enlist(fallbackGroups, parameterCd, make, pass.only[0]);
      return [{ index, only: pass.only, record, row }];
    }),
  );
  await readGroups(fallbackGroups.values(), request);
  for (const { index, only, record, row } of unmatched.flat()) {
    const outcome = await record;
    results[index] =
      outcome.status === 'rejected'
        ? outcome
        : rankAgainst(row, false, only, outcome.value, request);
  }
}

/**
 * The daily-mean percentiles for each reading's calendar day (`MM-DD`, the observation's own
 * date, so readings on two days rank against their own day's percentiles), from the series
 * computed from the reading's sensor (`sourceSeriesId`, the reading's instantaneous time-series
 * ID) when it has them. Otherwise the site's only series with percentiles that day is used,
 * unmatched; several yield `no_matching_method`.
 *
 * Reads are chunked (see {@link chunkKeys}) and run in two stages. The
 * normals — one read per parameter and calendar day, its locations repeated — run beside the
 * monthly intervals of every reading's own series, at most {@link INTERVAL_SERIES_PER_REQUEST}
 * series per request and {@link STATISTICS_CONCURRENCY} requests at a time. The intervals of the
 * unmatched series follow: for readings with no own series once the normals are in, without
 * waiting on the own-series intervals; for the rest once both are. One reading costs one normals
 * and one intervals request, plus one for an unmatched series.
 *
 * Results are in query order, one per query: fulfilled with the day's statistics, or rejected with
 * the failure of a read the reading needed (a failed chunk fails only the readings it covered) or
 * an `upstream_error` for percentiles that reading's approved record contradicts.
 *
 * @throws the caller's cancellation; every other failure is a rejected entry.
 */
export async function getDayStatistics(
  queries: readonly DayStatisticsQuery[],
  request: WaterDataRequest,
): Promise<PromiseSettledResult<DayStatistics>[]> {
  const normalsGroups = new Map<string, ReadGroup<SeriesPercentiles>>();
  const ownGroups = new Map<string, ReadGroup<readonly MonthlyInterval[]>>();
  const noIntervals = Promise.resolve({ status: 'fulfilled' as const, value: [] });
  const rows = queries.map((query, index): PendingRow => {
    const { monitoringLocationId, parameterCd, series } = query.site;
    const own =
      query.sourceSeriesId === null
        ? undefined
        : series.find((s) => s.sourceSeriesId === query.sourceSeriesId);
    const normals = enlist(
      normalsGroups,
      `${parameterCd} ${query.monthDay}`,
      () => normalsGroup(parameterCd, query.monthDay, request),
      monitoringLocationId,
    );
    const ownRecord = own
      ? enlist(ownGroups, parameterCd, () => intervalsGroup(parameterCd, request), own.id)
      : noIntervals;
    return { index, normals, ownRecord, row: { ...query, own } };
  });
  const normalsRead = readGroups(normalsGroups.values(), request);
  const ownRead = readGroups(ownGroups.values(), request);
  const unowned = rows.filter(({ row }) => !row.own);
  const owned = rows.filter(({ row }) => row.own);
  const results: PromiseSettledResult<DayStatistics>[] = [];
  await Promise.all([
    normalsRead.then(() => rankRows(unowned, results, request)),
    Promise.all([normalsRead, ownRead]).then(() => rankRows(owned, results, request)),
  ]);
  return results;
}

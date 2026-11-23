/**
 * @fileoverview Readings and series from the USGS Water Data OGC collections (`continuous`,
 * `daily`, `time-series-metadata`), the replacement for the WaterServices IV and DV readers, plus
 * field measurements (`field-measurements`, `field-measurements-metadata`) and annual peaks
 * (`peaks`). Daily and instantaneous reads return one {@link NwisTimeSeries} per statistic × method
 * series, the shape the tools consumed from the WaterServices reader; field reads one
 * {@link FieldSeries} per reading type, peak reads one {@link PeakSeries}. Every request a call
 * makes — site resolution, metadata, each page and chunk, and the waits on shared catalog reads —
 * runs under the call's one deadline, and the first failure stops the call's other requests.
 * @module services/waterdata/observations
 */

import { z } from '@cyanheads/mcp-ts-core';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import type {
  FieldSeries,
  NwisTimeSeries,
  NwisValueRecord,
  ObservedSeries,
  PeakSeries,
  SeriesType,
} from '@/services/waterdata/types.js';
import { cqlIn } from './cql2-text.js';
import {
  assembleFieldSeries,
  assemblePeakSeries,
  assembleSeries,
  type FieldMeasurement,
  type FieldSeriesMetadata,
  type Observation,
  PEAK_COMPUTATION,
  type PeakMeasurement,
  type SeriesMetadata,
  TimeOfDaySchema,
} from './observation-series.js';
import { type CatalogParameter, getParameterCatalog } from './parameter-catalog.js';
import { type SiteTimeZone, siteLocalDate, siteLocalDayStart } from './site-local-time.js';
import { type ResolvedSite, resolveSites } from './site-resolver.js';
import { getStatisticNames } from './statistic-codes.js';
import { failFast, fetchOgcItems, type WaterDataRequest } from './water-data-client.js';

/** True when at least one record carries a value — a record reported as no data does not. */
export function carriesValues(
  series: { readonly values: readonly NwisValueRecord[] } | undefined,
): boolean {
  return series?.values.some((v) => v.value !== '') ?? false;
}

export interface GetReadingsParams {
  parameterCds?: string[];
  /** ISO 8601 duration; the last two hours when omitted. */
  period?: string;
  sites: string[];
}

export interface GetSeriesParams {
  /** Last site-local day, `YYYY-MM-DD`. */
  endDate: string;
  parameterCd: string;
  seriesType: SeriesType;
  site: string;
  /** First site-local day, `YYYY-MM-DD`. */
  startDate: string;
  /** Daily statistic code to keep (e.g. "00003"); daily series only, ignored for the others. */
  statCd?: string;
}

const DEFAULT_PERIOD = 'PT2H';

/** Rows per page. The collections honor 50,000, above the 10,000 their OpenAPI document states. */
const OBSERVATION_PAGE_LIMIT = '50000';
const METADATA_PAGE_LIMIT = '10000';

/**
 * Site-local days per `continuous` query. The collection rejects a time envelope over 1,100 days;
 * one calendar year (leap years included) stays one query, and a multi-year range runs as parallel
 * queries — a year of 5-minute values is about 105,000 rows, three pages.
 */
const CHUNK_DAYS = 366;
const CHUNK_CONCURRENCY = 4;

const DAY_MS = 86_400_000;

const OBSERVATION_PROPERTIES =
  'time_series_id,monitoring_location_id,parameter_code,statistic_id,time,value,approval_status,qualifier';
const METADATA_PROPERTIES =
  'monitoring_location_id,parameter_code,statistic_id,begin,sublocation_identifier,web_description,unit_of_measure,parameter_name';
const FIELD_PROPERTIES =
  'field_measurements_series_id,monitoring_location_id,parameter_code,time,time_of_day,month,day,value,unit_of_measure,approval_status,qualifier,observing_procedure,measurement_rated,control_condition,reading_type,sublocation_identifier';
const FIELD_METADATA_PROPERTIES =
  'monitoring_location_id,parameter_code,parameter_description,reading_type,begin,sublocation_identifier';
const PEAK_PROPERTIES =
  'time_series_id,monitoring_location_id,parameter_code,time,time_of_day,water_year,month,day,value,unit_of_measure,qualifier,peak_since';

const NullableText = z.string().nullish();
const NullableInteger = z.number().int().nullish();
// Rows carry an array of words; the OpenAPI document describes one string.
const QualifierSchema = z.union([z.array(z.string()), z.string()]).nullish();

function qualifierWords(qualifier: z.infer<typeof QualifierSchema>): string[] {
  return typeof qualifier === 'string' ? [qualifier] : (qualifier ?? []);
}

function observationSchema(time: z.ZodType<string>) {
  return z.object({
    properties: z.object({
      time_series_id: z.string().min(1),
      monitoring_location_id: z.string(),
      parameter_code: z.string(),
      statistic_id: NullableText,
      time,
      value: NullableText,
      approval_status: NullableText,
      qualifier: QualifierSchema,
    }),
  });
}

/** What a `field-measurements` and a `peaks` row share: a UTC date, maybe a time of day, and a value. */
const MeasurementSchema = z.object({
  monitoring_location_id: z.string(),
  parameter_code: z.string(),
  time: z.iso.date(),
  time_of_day: TimeOfDaySchema.nullish(),
  month: NullableInteger,
  day: NullableInteger,
  value: NullableText,
  unit_of_measure: NullableText,
  qualifier: QualifierSchema,
});

const FieldMeasurementSchema = z.object({
  properties: MeasurementSchema.extend({
    field_measurements_series_id: z.string().min(1),
    approval_status: NullableText,
    observing_procedure: NullableText,
    measurement_rated: NullableText,
    control_condition: NullableText,
    reading_type: NullableText,
    sublocation_identifier: NullableText,
  }),
});

const PeakSchema = z.object({
  properties: MeasurementSchema.extend({
    time_series_id: z.string().min(1),
    water_year: NullableInteger,
    peak_since: NullableInteger,
  }),
});

const FieldMetadataSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    monitoring_location_id: z.string(),
    parameter_code: z.string(),
    parameter_description: NullableText,
    reading_type: NullableText,
    begin: NullableText,
    sublocation_identifier: NullableText,
  }),
});

function toMeasurementRow(p: z.infer<typeof MeasurementSchema>) {
  return {
    monitoringLocationId: p.monitoring_location_id,
    parameterCd: p.parameter_code,
    date: p.time,
    timeOfDay: p.time_of_day ?? null,
    month: p.month ?? null,
    day: p.day ?? null,
    value: p.value ?? null,
    unit: p.unit_of_measure ?? null,
    qualifiers: qualifierWords(p.qualifier),
  };
}

function toFieldMeasurement({
  properties: p,
}: z.infer<typeof FieldMeasurementSchema>): FieldMeasurement {
  return {
    ...toMeasurementRow(p),
    seriesId: p.field_measurements_series_id,
    approvalStatus: p.approval_status ?? null,
    observingProcedure: p.observing_procedure ?? null,
    measurementRated: p.measurement_rated ?? null,
    controlCondition: p.control_condition ?? null,
    readingType: p.reading_type ?? null,
    sublocation: p.sublocation_identifier ?? null,
  };
}

function toPeakMeasurement({ properties: p }: z.infer<typeof PeakSchema>): PeakMeasurement {
  return {
    ...toMeasurementRow(p),
    seriesId: p.time_series_id,
    waterYear: p.water_year ?? null,
    peakSince: p.peak_since ?? null,
  };
}

function toFieldMetadata({
  id,
  properties: p,
}: z.infer<typeof FieldMetadataSchema>): FieldSeriesMetadata {
  return {
    id,
    monitoringLocationId: p.monitoring_location_id,
    parameterCd: p.parameter_code,
    parameterName: p.parameter_description ?? null,
    readingType: p.reading_type ?? null,
    begin: p.begin ?? null,
    sublocation: p.sublocation_identifier ?? null,
  };
}

const ContinuousSchema = observationSchema(
  z.string().refine((t) => !Number.isNaN(Date.parse(t)), 'expected an ISO 8601 instant'),
);
const DailySchema = observationSchema(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date'),
);
type ObservationFeature = z.infer<typeof ContinuousSchema>;

const MetadataSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    monitoring_location_id: z.string(),
    parameter_code: z.string(),
    statistic_id: z.string().nullish(),
    begin: z.string().nullish(),
    sublocation_identifier: z.string().nullish(),
    web_description: z.string().nullish(),
    unit_of_measure: z.string().nullish(),
    parameter_name: z.string().nullish(),
  }),
});

function toObservation({ properties: p }: ObservationFeature): Observation {
  return {
    seriesId: p.time_series_id,
    monitoringLocationId: p.monitoring_location_id,
    parameterCd: p.parameter_code,
    statCd: p.statistic_id ?? null,
    time: p.time,
    value: p.value ?? null,
    approvalStatus: p.approval_status ?? null,
    qualifiers: qualifierWords(p.qualifier),
  };
}

function toMetadata({ id, properties: p }: z.infer<typeof MetadataSchema>): SeriesMetadata {
  return {
    id,
    monitoringLocationId: p.monitoring_location_id,
    parameterCd: p.parameter_code,
    statCd: p.statistic_id ?? null,
    begin: p.begin ?? null,
    sublocation: p.sublocation_identifier ?? null,
    webDescription: p.web_description ?? null,
    unit: p.unit_of_measure ?? null,
    parameterName: p.parameter_name ?? null,
  };
}

/** Every feature of one collection matching `filters`, without geometry, `properties` only. */
function readItems<F extends z.ZodType>(
  collection: string,
  filters: Record<string, string>,
  properties: string,
  limit: string,
  schema: F,
  request: WaterDataRequest,
): Promise<z.infer<F>[]> {
  const query = new URLSearchParams({ ...filters, skipGeometry: 'true', properties, limit });
  return fetchOgcItems(collection, query, schema, request);
}

async function readObservations(
  collection: 'continuous' | 'daily',
  filters: Record<string, string>,
  request: WaterDataRequest,
): Promise<Observation[]> {
  const schema = collection === 'daily' ? DailySchema : ContinuousSchema;
  const rows = await readItems(
    collection,
    filters,
    OBSERVATION_PROPERTIES,
    OBSERVATION_PAGE_LIMIT,
    schema,
    request,
  );
  return rows.map(toObservation);
}

async function readMetadata(
  filters: Record<string, string>,
  request: WaterDataRequest,
): Promise<SeriesMetadata[]> {
  const entries = await readItems(
    'time-series-metadata',
    filters,
    METADATA_PROPERTIES,
    METADATA_PAGE_LIMIT,
    MetadataSchema,
    request,
  );
  return entries.map(toMetadata);
}

/**
 * Wait on a read shared with other calls (it carries no caller's signal), giving up at once when
 * this call is cancelled or its deadline runs out. The shared read itself keeps going.
 */
function awaitShared<T>(load: Promise<T>, request: WaterDataRequest, what: string): Promise<T> {
  const { deadline, operation, signal } = request;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      settle();
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      settle();
      reject(
        timeout(
          `${operation} ran out of the ${deadline.budgetMs} ms budget for this call waiting for ${what}.`,
          {
            reason: 'retry_deadline_exceeded',
            deadlineMs: deadline.budgetMs,
            elapsedMs: deadline.elapsedMs(),
            operation,
          },
        ),
      );
    }, deadline.remainingMs());
    function settle() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    // Observe the shared read before any early exit: this call may have started it, and a failure
    // no caller is waiting on would otherwise surface as an unhandled rejection.
    load.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const catalogIndexes = new WeakMap<
  readonly CatalogParameter[],
  ReadonlyMap<string, CatalogParameter>
>();

/** The parameter-code catalog by code — the source of `unitCode` (`ft3/s`) and `parameterName`. */
async function parameterIndex(
  request: WaterDataRequest,
): Promise<ReadonlyMap<string, CatalogParameter>> {
  const catalog = await awaitShared(
    getParameterCatalog(request.ctx),
    request,
    'the parameter-code catalog',
  );
  let index = catalogIndexes.get(catalog);
  if (!index) {
    index = new Map(catalog.map((parameter) => [parameter.code, parameter]));
    catalogIndexes.set(catalog, index);
  }
  return index;
}

/** `task` over `items`, at most `limit` at a time, results in item order; the first failure ends it. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await task(items[index] as T);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function byLocationId(sites: ReadonlyMap<string, ResolvedSite>): Map<string, ResolvedSite> {
  return new Map([...sites.values()].map((site) => [site.monitoringLocationId, site]));
}

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** An instant as the RFC 3339 form the `time` parameter takes, to the second. */
function utcText(instantMs: number): string {
  return `${new Date(instantMs).toISOString().slice(0, 19)}Z`;
}

/**
 * The site-local days of `startDate`…`endDate` that can hold `continuous` rows, as `[first, last]`
 * (`last` before `first` when none can). The range ends at today on the site's clock — later days
 * hold nothing yet — and starts no earlier than the site's first observation of the parameter.
 * When the metadata lists no series, only the last {@link CHUNK_DAYS} days to that end are read:
 * the metadata refreshes about daily, so a series it does not list yet began at most a day or so ago.
 */
function continuousDays(
  startDate: string,
  endDate: string,
  zone: SiteTimeZone | null,
  metadata: readonly SeriesMetadata[],
  nowMs: number,
): readonly [string, string] {
  const today = siteLocalDate(nowMs, zone);
  const last = endDate < today ? endDate : today;
  let earliest: string | undefined;
  if (metadata.length === 0) {
    earliest = addDays(last, 1 - CHUNK_DAYS);
  } else {
    const firstMs = firstObservation(metadata);
    if (firstMs !== undefined) earliest = siteLocalDate(firstMs, zone);
  }
  return [earliest !== undefined && earliest > startDate ? earliest : startDate, last];
}

/**
 * The `time` intervals covering site-local days `firstDay`…`lastDay`, at most {@link CHUNK_DAYS}
 * each, from local midnight to the last second of the last day; none when `lastDay` comes first.
 * A date alone is read upstream as the UTC-midnight instant, never a day, so every bound is an
 * explicit UTC instant.
 */
function continuousWindows(firstDay: string, lastDay: string, zone: SiteTimeZone | null): string[] {
  const windows: string[] = [];
  for (let day = firstDay; day <= lastDay; ) {
    const chunkEnd = addDays(day, CHUNK_DAYS - 1);
    const last = chunkEnd < lastDay ? chunkEnd : lastDay;
    const from = siteLocalDayStart(day, zone);
    const to = siteLocalDayStart(addDays(last, 1), zone) - 1_000;
    windows.push(`${utcText(from)}/${utcText(to)}`);
    day = addDays(last, 1);
  }
  return windows;
}

/** The earliest first observation among `metadata`, or undefined when none states one. */
function firstObservation(metadata: readonly SeriesMetadata[]): number | undefined {
  const begins = metadata.flatMap((m) => (m.begin ? [Date.parse(m.begin)] : []));
  const first = Math.min(...begins.filter((ms) => !Number.isNaN(ms)));
  return Number.isFinite(first) ? first : undefined;
}

const NO_STATISTIC_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * Instantaneous values for up to 100 sites over the trailing `period` (two hours by default), one
 * series per sensor (method) — a sensor with no values in the window included, as an empty series.
 * Sites resolve by number across agencies; a site that resolves to nothing is absent from the
 * result. Costs one `continuous` and one `time-series-metadata` request per page, plus site
 * resolution and the parameter catalog when their caches are cold.
 *
 * @throws {McpError} whatever the Water Data client raises — `RateLimited`, `ConfigurationError`,
 * `ValidationError`, `ServiceUnavailable`, `Timeout` — and the caller's cancellation.
 */
export function getReadings(
  params: GetReadingsParams,
  request: WaterDataRequest,
): Promise<NwisTimeSeries[]> {
  return failFast(request, async (scoped) => {
    const sites = byLocationId(await resolveSites(params.sites, scoped));
    if (sites.size === 0) return [];
    const clauses = [cqlIn('monitoring_location_id', [...sites.keys()])];
    if (params.parameterCds?.length) clauses.push(cqlIn('parameter_code', params.parameterCds));
    const filter = { 'filter-lang': 'cql2-text', filter: clauses.join(' AND ') };
    const [metadata, rows, parameters] = await Promise.all([
      readMetadata({ ...filter, computation_period_identifier: 'Points' }, scoped),
      readObservations('continuous', { ...filter, time: params.period ?? DEFAULT_PERIOD }, scoped),
      parameterIndex(scoped),
    ]);
    return assembleSeries(metadata, rows, {
      seriesType: 'instantaneous',
      sites,
      parameters,
      statisticNames: NO_STATISTIC_NAMES,
    });
  });
}

/** The query filters every series read of one site and parameter shares. */
function siteFilters(site: ResolvedSite, parameterCd: string) {
  return { monitoring_location_id: site.monitoringLocationId, parameter_code: parameterCd };
}

async function readDailySeries(
  params: GetSeriesParams,
  site: ResolvedSite,
  request: WaterDataRequest,
): Promise<NwisTimeSeries[]> {
  const filters = siteFilters(site, params.parameterCd);
  const daily = params.statCd ? { ...filters, statistic_id: params.statCd } : filters;
  const [metadata, rows, parameters, statisticNames] = await Promise.all([
    readMetadata({ ...daily, computation_period_identifier: 'Daily' }, request),
    readObservations('daily', { ...daily, time: `${params.startDate}/${params.endDate}` }, request),
    parameterIndex(request),
    awaitShared(getStatisticNames(request.ctx), request, 'the statistic-code names'),
  ]);
  return assembleSeries(metadata, rows, {
    seriesType: 'daily',
    sites: new Map([[site.monitoringLocationId, site]]),
    parameters,
    statisticNames,
  });
}

async function readInstantaneousSeries(
  params: GetSeriesParams,
  site: ResolvedSite,
  request: WaterDataRequest,
): Promise<NwisTimeSeries[]> {
  const filters = siteFilters(site, params.parameterCd);
  const readContinuous = async () => {
    const metadata = await readMetadata(
      { ...filters, computation_period_identifier: 'Points' },
      request,
    );
    const [firstDay, lastDay] = continuousDays(
      params.startDate,
      params.endDate,
      site.timeZone,
      metadata,
      Date.now(),
    );
    const windows = continuousWindows(firstDay, lastDay, site.timeZone);
    const chunks = await mapConcurrent(windows, CHUNK_CONCURRENCY, (time) =>
      readObservations('continuous', { ...filters, time }, request),
    );
    return { metadata, rows: chunks.flat() };
  };
  const [{ metadata, rows }, parameters] = await Promise.all([
    readContinuous(),
    parameterIndex(request),
  ]);
  return assembleSeries(metadata, rows, {
    seriesType: 'instantaneous',
    sites: new Map([[site.monitoringLocationId, site]]),
    parameters,
    statisticNames: NO_STATISTIC_NAMES,
  });
}

/**
 * The `time` interval of a field-measurement or peak query covering site-local days
 * `startDate`…`endDate`. The collections date a row by its UTC date, which can fall a day either
 * side of the site-local one, so the interval reaches a day past each end — dates are inclusive —
 * and assembly keeps the records on the site's own days.
 */
function measurementWindow(startDate: string, endDate: string): string {
  return `${addDays(startDate, -1)}/${addDays(endDate, 1)}`;
}

async function readFieldSeries(
  params: GetSeriesParams,
  site: ResolvedSite,
  request: WaterDataRequest,
): Promise<FieldSeries[]> {
  const filters = siteFilters(site, params.parameterCd);
  const [metadata, rows, parameters] = await Promise.all([
    readItems(
      'field-measurements-metadata',
      filters,
      FIELD_METADATA_PROPERTIES,
      METADATA_PAGE_LIMIT,
      FieldMetadataSchema,
      request,
    ),
    readItems(
      'field-measurements',
      { ...filters, time: measurementWindow(params.startDate, params.endDate) },
      FIELD_PROPERTIES,
      METADATA_PAGE_LIMIT,
      FieldMeasurementSchema,
      request,
    ),
    parameterIndex(request),
  ]);
  return assembleFieldSeries(metadata.map(toFieldMetadata), rows.map(toFieldMeasurement), {
    days: [params.startDate, params.endDate],
    sites: new Map([[site.monitoringLocationId, site]]),
    parameters,
  });
}

async function readPeakSeries(
  params: GetSeriesParams,
  site: ResolvedSite,
  request: WaterDataRequest,
): Promise<PeakSeries[]> {
  const filters = siteFilters(site, params.parameterCd);
  const [metadata, rows, parameters] = await Promise.all([
    readMetadata({ ...filters, computation_identifier: PEAK_COMPUTATION }, request),
    readItems(
      'peaks',
      { ...filters, time: measurementWindow(params.startDate, params.endDate) },
      PEAK_PROPERTIES,
      METADATA_PAGE_LIMIT,
      PeakSchema,
      request,
    ),
    parameterIndex(request),
  ]);
  return assemblePeakSeries(metadata, rows.map(toPeakMeasurement), {
    days: [params.startDate, params.endDate],
    sites: new Map([[site.monitoringLocationId, site]]),
    parameters,
  });
}

/**
 * One site's series of one parameter over site-local days `startDate`…`endDate`, one entry per
 * series (a series with nothing in the range included, empty). A site that resolves to nothing
 * yields no series.
 *
 * - `daily`: one entry per statistic × method from one `daily` query, `statCd` keeping one
 *   statistic.
 * - `instantaneous`: one entry per method from `continuous` in {@link CHUNK_DAYS}-day chunks run in
 *   parallel, read after the site's series metadata, whose first observation trims the range; the
 *   range ends at today on the site's clock, and when the metadata lists no series only its last
 *   {@link CHUNK_DAYS} days are read, in one request.
 * - `field`: one entry per reading type from one `field-measurements` query beside
 *   `field-measurements-metadata`.
 * - `peak`: one entry per peak series from one `peaks` query beside the `time-series-metadata`
 *   series computed {@link PEAK_COMPUTATION}.
 *
 * `statCd` applies to `daily` only. Each call also reads the parameter catalog, and a daily call
 * the statistic names, when their caches are cold.
 *
 * @throws {McpError} whatever the Water Data client raises — `RateLimited`, `ConfigurationError`,
 * `ValidationError`, `ServiceUnavailable`, `Timeout` — and the caller's cancellation.
 */
export function getSeries(
  params: GetSeriesParams & { seriesType: 'daily' | 'instantaneous' },
  request: WaterDataRequest,
): Promise<NwisTimeSeries[]>;
export function getSeries(
  params: GetSeriesParams & { seriesType: 'field' },
  request: WaterDataRequest,
): Promise<FieldSeries[]>;
export function getSeries(
  params: GetSeriesParams & { seriesType: 'peak' },
  request: WaterDataRequest,
): Promise<PeakSeries[]>;
export function getSeries(
  params: GetSeriesParams,
  request: WaterDataRequest,
): Promise<ObservedSeries[]>;
export function getSeries(
  params: GetSeriesParams,
  request: WaterDataRequest,
): Promise<ObservedSeries[]> {
  return failFast(request, async (scoped): Promise<ObservedSeries[]> => {
    const site = (await resolveSites([params.site], scoped)).get(params.site);
    if (!site) return [];
    switch (params.seriesType) {
      case 'daily':
        return readDailySeries(params, site, scoped);
      case 'instantaneous':
        return readInstantaneousSeries(params, site, scoped);
      case 'field':
        return readFieldSeries(params, site, scoped);
      case 'peak':
        return readPeakSeries(params, site, scoped);
    }
  });
}

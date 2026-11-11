/**
 * @fileoverview Readings and series from the USGS Water Data OGC collections (`continuous`,
 * `daily`, `time-series-metadata`), the replacement for the WaterServices IV and DV readers.
 * Each function returns one {@link NwisTimeSeries} per statistic × method series, the shape the
 * tools consumed from the WaterServices reader. Every request a call makes — site resolution,
 * metadata, each page and chunk, and the waits on shared catalog reads — runs under the call's one
 * deadline, and the first failure stops the call's other requests.
 * @module services/waterdata/observations
 */

import { z } from '@cyanheads/mcp-ts-core';
import { timeout } from '@cyanheads/mcp-ts-core/errors';
import type { NwisTimeSeries } from '@/services/waterdata/types.js';
import { cqlIn } from './cql2-text.js';
import { assembleSeries, type Observation, type SeriesMetadata } from './observation-series.js';
import { type CatalogParameter, getParameterCatalog } from './parameter-catalog.js';
import { type SiteTimeZone, siteLocalDate, siteLocalDayStart } from './site-local-time.js';
import { type ResolvedSite, resolveSites } from './site-resolver.js';
import { getStatisticNames } from './statistic-codes.js';
import { failFast, fetchOgcItems, type WaterDataRequest } from './water-data-client.js';

/** True when at least one record carries a value — a record reported as no data does not. */
export function carriesValues(series: NwisTimeSeries | undefined): boolean {
  return series?.values.some((v) => v.value !== '') ?? false;
}

export interface GetReadingsParams {
  parameterCds?: string[];
  /** ISO 8601 duration; the last two hours when omitted. */
  period?: string;
  sites: string[];
}

export interface GetSeriesParams {
  endDate: string;
  parameterCd: string;
  seriesType: 'daily' | 'instantaneous';
  site: string;
  startDate: string;
  /** Daily statistic code to keep (e.g. "00003"); daily series only. */
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

function observationSchema(time: z.ZodType<string>) {
  return z.object({
    properties: z.object({
      time_series_id: z.string().min(1),
      monitoring_location_id: z.string(),
      parameter_code: z.string(),
      statistic_id: z.string().nullish(),
      time,
      value: z.string().nullish(),
      approval_status: z.string().nullish(),
      // Rows carry an array of words; the OpenAPI document describes one string.
      qualifier: z.union([z.array(z.string()), z.string()]).nullish(),
    }),
  });
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
    qualifiers: typeof p.qualifier === 'string' ? [p.qualifier] : (p.qualifier ?? []),
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

async function readObservations(
  collection: 'continuous' | 'daily',
  filters: Record<string, string>,
  request: WaterDataRequest,
): Promise<Observation[]> {
  const query = new URLSearchParams({
    ...filters,
    skipGeometry: 'true',
    properties: OBSERVATION_PROPERTIES,
    limit: OBSERVATION_PAGE_LIMIT,
  });
  const schema = collection === 'daily' ? DailySchema : ContinuousSchema;
  return (await fetchOgcItems(collection, query, schema, request)).map(toObservation);
}

async function readMetadata(
  filters: Record<string, string>,
  request: WaterDataRequest,
): Promise<SeriesMetadata[]> {
  const query = new URLSearchParams({
    ...filters,
    skipGeometry: 'true',
    properties: METADATA_PROPERTIES,
    limit: METADATA_PAGE_LIMIT,
  });
  return (await fetchOgcItems('time-series-metadata', query, MetadataSchema, request)).map(
    toMetadata,
  );
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
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
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
async function mapConcurrent<T, R>(
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

/**
 * A daily or instantaneous series for one site and parameter over site-local days
 * `startDate`…`endDate`, one entry per statistic × method series (a series with nothing in the
 * range included, empty). Daily values come from one `daily` query, `statCd` keeping one
 * statistic. Instantaneous values come from `continuous` in {@link CHUNK_DAYS}-day chunks run in
 * parallel, read after the site's series metadata, whose first observation trims the range; the
 * range ends at today on the site's clock, and when the metadata lists no series only its last
 * {@link CHUNK_DAYS} days are read, in one request. A site that resolves to nothing yields no series.
 *
 * @throws {McpError} whatever the Water Data client raises — `RateLimited`, `ConfigurationError`,
 * `ValidationError`, `ServiceUnavailable`, `Timeout` — and the caller's cancellation.
 */
export function getSeries(
  params: GetSeriesParams,
  request: WaterDataRequest,
): Promise<NwisTimeSeries[]> {
  return failFast(request, async (scoped) => {
    const site = (await resolveSites([params.site], scoped)).get(params.site);
    if (!site) return [];
    const sites = new Map([[site.monitoringLocationId, site]]);
    const filters = {
      monitoring_location_id: site.monitoringLocationId,
      parameter_code: params.parameterCd,
    };

    if (params.seriesType === 'daily') {
      const daily = params.statCd ? { ...filters, statistic_id: params.statCd } : filters;
      const [metadata, rows, parameters, statisticNames] = await Promise.all([
        readMetadata({ ...daily, computation_period_identifier: 'Daily' }, scoped),
        readObservations(
          'daily',
          { ...daily, time: `${params.startDate}/${params.endDate}` },
          scoped,
        ),
        parameterIndex(scoped),
        awaitShared(getStatisticNames(scoped.ctx), scoped, 'the statistic-code names'),
      ]);
      return assembleSeries(metadata, rows, {
        seriesType: 'daily',
        sites,
        parameters,
        statisticNames,
      });
    }

    const readContinuous = async () => {
      const metadata = await readMetadata(
        { ...filters, computation_period_identifier: 'Points' },
        scoped,
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
        readObservations('continuous', { ...filters, time }, scoped),
      );
      return { metadata, rows: chunks.flat() };
    };
    const [{ metadata, rows }, parameters] = await Promise.all([
      readContinuous(),
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

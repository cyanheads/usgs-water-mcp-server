/**
 * @fileoverview One-page OGC site-series discovery with filter-bound cursors and one deadline for
 * the call: the site resolves to its monitoring location (any agency), then one page of its series
 * metadata is read — `time-series-metadata` (daily, instantaneous, and annual-peak series, and
 * other computations), then `field-measurements-metadata` (field-measurement series), one list
 * paged across both.
 * @module services/waterdata/site-data-catalog
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  McpError,
  notFound,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { SERIES_TYPES, type SeriesType } from '@/services/waterdata/types.js';
import { PEAK_COMPUTATION } from './observation-series.js';
import { type ResolvedSite, resolveSites } from './site-resolver.js';
import {
  fetchOgcPage,
  ogcItemsUrl,
  startRequest,
  type WaterDataRequest,
} from './water-data-client.js';
import { classifyWaterDataFailure } from './water-data-errors.js';

/**
 * The metadata collections the catalog lists, in paging order: `time-series` is
 * `time-series-metadata`, `field` is `field-measurements-metadata`.
 */
const COLLECTIONS = {
  'time-series': 'time-series-metadata',
  field: 'field-measurements-metadata',
} as const;
type CatalogCollection = keyof typeof COLLECTIONS;

const NullableText = z.string().nullish();
const FieldSeriesSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    parameter_code: z.string(),
    parameter_name: NullableText,
    begin: NullableText,
    end: NullableText,
    sublocation_identifier: NullableText,
    reading_type: NullableText,
  }),
});
const SeriesSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    parameter_code: z.string(),
    parameter_name: NullableText,
    unit_of_measure: NullableText,
    statistic_id: NullableText,
    begin: NullableText,
    end: NullableText,
    sublocation_identifier: NullableText,
    web_description: NullableText,
    computation_period_identifier: NullableText,
    computation_identifier: NullableText,
  }),
});
const OffsetSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const CursorSchema = z
  .object({
    version: z.literal(2),
    site: z.string(),
    parameterCd: z.string().nullable(),
    seriesType: z.enum(SERIES_TYPES).nullable(),
    limit: z.number().int(),
    collection: z.enum(['time-series', 'field']),
    offset: OffsetSchema,
  })
  .strict();

/** A single catalog request; a cursor is usable only with the same filters and page size. */
export interface SiteCatalogParams {
  cursor?: string | undefined;
  limit: number;
  parameterCd?: string | undefined;
  seriesType?: SeriesType | undefined;
  site: string;
}

/** A sensor/statistic's metadata, preserving unavailable upstream values as null. */
export interface SiteCatalogSeries {
  beginDate: string | null;
  /** The `time-series-metadata` computation (`Mean`, `Instantaneous`, `Max At Event Time`); null on a field series. */
  computation: string | null;
  /** The `time-series-metadata` computation period (`Daily`, `Points`, `Water Year`); null on a field series. */
  computationPeriod: string | null;
  endDate: string | null;
  parameterCd: string;
  parameterName: string | null;
  /** A field series' reading type (`ReferencePrimary`, `MeanGageHeight`, `Discharge`); null on the others. */
  readingType: string | null;
  /** The `water_get_series` type that reads the series; null for a computation it does not read. */
  seriesType: SeriesType | null;
  statCd: string | null;
  sublocation: string | null;
  /** The series ID: 32 hex digits from `time-series-metadata`, a UUID from `field-measurements-metadata`. */
  timeSeriesId: string;
  /** Null on a field series, whose metadata states none. */
  unit: string | null;
  webDescription: string | null;
}

/** Where a page starts: a collection and the offset into it. */
interface Position {
  collection: CatalogCollection;
  offset: number;
}

/** The collections a `seriesType` filter reads, in paging order. */
function collectionsFor(
  seriesType: SeriesType | undefined,
): readonly [CatalogCollection, ...CatalogCollection[]] {
  if (seriesType === undefined) return ['time-series', 'field'];
  return seriesType === 'field' ? ['field'] : ['time-series'];
}

/** One page; no total or observation count is inferred from metadata. */
export interface SiteDataCatalog {
  nextCursor: string | null;
  series: SiteCatalogSeries[];
  siteName: string | null;
  siteNumber: string;
}

/** Bind continuation to the exact request that generated it. */
function binding(params: SiteCatalogParams) {
  return {
    version: 2 as const,
    site: params.site,
    parameterCd: params.parameterCd ?? null,
    seriesType: params.seriesType ?? null,
    limit: params.limit,
  };
}

/** Decode only bounded data, never a URL to fetch. */
function cursorPosition(params: SiteCatalogParams): Position | undefined {
  if (!params.cursor) return undefined;
  try {
    const decoded = Buffer.from(params.cursor, 'base64url');
    if (decoded.toString('base64url') !== params.cursor) throw new Error('Invalid base64url');
    const cursor = CursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    const { collection, offset, ...filters } = cursor;
    if (JSON.stringify(filters) !== JSON.stringify(binding(params)))
      throw new Error('filter mismatch');
    if (!collectionsFor(params.seriesType).includes(collection))
      throw new Error('collection mismatch');
    return { collection, offset };
  } catch {
    throw validationError(
      'The catalog cursor is malformed or belongs to different filters or limit.',
      { reason: 'invalid_cursor' },
    );
  }
}

function encodeCursor(params: SiteCatalogParams, { collection, offset }: Position): string {
  const cursor = { ...binding(params), collection, offset: OffsetSchema.parse(offset) };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

/** The type a `time-series-metadata` row reads as; the peak mapping keys on the computation alone. */
function seriesType(
  p: z.infer<typeof SeriesSchema>['properties'],
): SiteCatalogSeries['seriesType'] {
  if (p.computation_period_identifier === 'Daily') return 'daily';
  if (p.computation_identifier === PEAK_COMPUTATION) return 'peak';
  return p.computation_period_identifier === 'Points' &&
    p.computation_identifier === 'Instantaneous'
    ? 'instantaneous'
    : null;
}

function timeSeriesRow({ id, properties: p }: z.infer<typeof SeriesSchema>): SiteCatalogSeries {
  return {
    timeSeriesId: id,
    parameterCd: p.parameter_code,
    parameterName: p.parameter_name ?? null,
    unit: p.unit_of_measure ?? null,
    statCd: p.statistic_id ?? null,
    beginDate: p.begin ?? null,
    endDate: p.end ?? null,
    sublocation: p.sublocation_identifier ?? null,
    webDescription: p.web_description ?? null,
    computationPeriod: p.computation_period_identifier ?? null,
    computation: p.computation_identifier ?? null,
    readingType: null,
    seriesType: seriesType(p),
  };
}

function fieldRow({ id, properties: p }: z.infer<typeof FieldSeriesSchema>): SiteCatalogSeries {
  return {
    timeSeriesId: id,
    parameterCd: p.parameter_code,
    parameterName: p.parameter_name ?? null,
    unit: null,
    statCd: null,
    beginDate: p.begin ?? null,
    endDate: p.end ?? null,
    sublocation: p.sublocation_identifier ?? null,
    webDescription: null,
    computationPeriod: null,
    computation: null,
    readingType: p.reading_type ?? null,
    seriesType: 'field',
  };
}

/** The `time-series-metadata` filters a `seriesType` other than `field` adds. */
function timeSeriesFilters(seriesType: SeriesType | undefined): [string, string][] {
  switch (seriesType) {
    case 'daily':
      return [['computation_period_identifier', 'Daily']];
    case 'instantaneous':
      return [
        ['computation_period_identifier', 'Points'],
        ['computation_identifier', 'Instantaneous'],
      ];
    case 'peak':
      return [['computation_identifier', PEAK_COMPUTATION]];
    default:
      return [];
  }
}

/**
 * Read up to `limit` rows of one collection's metadata for `site` from `offset`. A read the
 * caller's cursor positioned turns an upstream rejection of its offset into `invalid_cursor`.
 */
async function readPage(
  params: SiteCatalogParams,
  site: ResolvedSite,
  { collection, offset }: Position,
  limit: number,
  fromCursor: boolean,
  request: WaterDataRequest,
): Promise<{ hasNext: boolean; rows: SiteCatalogSeries[] }> {
  const query = new URLSearchParams({
    monitoring_location_id: site.monitoringLocationId,
    limit: String(limit),
  });
  if (params.parameterCd) query.set('parameter_code', params.parameterCd);
  if (collection === 'time-series')
    for (const [key, value] of timeSeriesFilters(params.seriesType)) query.set(key, value);
  if (offset) query.set('offset', String(offset));
  const name = COLLECTIONS[collection];
  try {
    const url = ogcItemsUrl(name, query);
    if (collection === 'field') {
      const page = await fetchOgcPage(name, url, FieldSeriesSchema, request);
      return { hasNext: page.nextUrl !== null, rows: page.features.map(fieldRow) };
    }
    const page = await fetchOgcPage(name, url, SeriesSchema, request);
    return { hasNext: page.nextUrl !== null, rows: page.features.map(timeSeriesRow) };
  } catch (error) {
    const cursorRejected =
      fromCursor &&
      offset > 0 &&
      error instanceof McpError &&
      error.data?.reason === 'invalid_request';
    if (cursorRejected)
      throw validationError(
        'USGS rejected the continuation cursor. Restart the catalog without cursor.',
        { reason: 'invalid_cursor' },
        { cause: error },
      );
    throw error;
  }
}

/**
 * Resolve the site and read one page of its series metadata within one 45-second deadline,
 * retries and body parsing included. The pages run through `time-series-metadata`, then
 * `field-measurements-metadata` (a `seriesType` filter reads only the one that holds it): a page
 * that ends the first collection with room left fills from the second, one more request.
 *
 * @throws {McpError} `not_found` (no location has the number), `invalid_cursor`, `upstream_timeout`,
 * `upstream_error`; a rate limit (`RateLimited`), a rejected `USGS_API_KEY`
 * (`ConfigurationError`), and caller cancellation pass through unchanged.
 */
export async function getSiteDataCatalog(
  params: SiteCatalogParams,
  ctx: Context,
): Promise<SiteDataCatalog> {
  const resumed = cursorPosition(params);
  const collections = collectionsFor(params.seriesType);
  const start: Position = resumed ?? { collection: collections[0], offset: 0 };
  const request = startRequest(ctx, 'getSiteDataCatalog');
  try {
    const site = (await resolveSites([params.site], request)).get(params.site);
    if (!site) throw notFound(`USGS site ${params.site} was not found.`, { reason: 'not_found' });
    const page = await readPage(params, site, start, params.limit, resumed !== undefined, request);
    const series = page.rows;
    /** Offset paging keeps position stable when upstream switches continuation styles. */
    let next: Position | null = page.hasNext
      ? { collection: start.collection, offset: start.offset + series.length }
      : null;
    const following = collections[collections.indexOf(start.collection) + 1];
    if (!page.hasNext && following) {
      const room = params.limit - series.length;
      next = { collection: following, offset: 0 };
      if (room > 0) {
        /**
         * The fill only saves the caller a request: the page already ends the first collection, so a
         * failed fill ends the page there and its cursor starts the second collection, whose own
         * page reports the failure if it persists. Failing the call would drop the rows it read.
         */
        try {
          const fill = await readPage(params, site, next, room, false, request);
          series.push(...fill.rows);
          next = fill.hasNext ? { collection: following, offset: fill.rows.length } : null;
        } catch (error) {
          if (ctx.signal?.aborted) throw error;
          ctx.log.warning('Field-series fill failed; the page ends at the time series', {
            site: params.site,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    return {
      siteNumber: params.site,
      siteName: site.siteName,
      series,
      nextCursor: next ? encodeCursor(params, next) : null,
    };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    if (
      error instanceof McpError &&
      (error.data?.reason === 'not_found' || error.data?.reason === 'invalid_cursor')
    )
      throw error;
    const failure = classifyWaterDataFailure(error);
    if (!failure) throw error;
    if (failure.reason === 'upstream_timeout')
      throw timeout(
        failure.message,
        { ...failure.data, reason: 'upstream_timeout' },
        { cause: error },
      );
    throw serviceUnavailable(
      failure.message,
      { ...failure.data, reason: 'upstream_error' },
      { cause: error },
    );
  }
}

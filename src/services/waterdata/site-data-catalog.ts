/**
 * @fileoverview One-page OGC site-series discovery with filter-bound cursors and one deadline for
 * the call: the site resolves to its monitoring location (any agency), then one page of its
 * `time-series-metadata` is read.
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
import { resolveSites } from './site-resolver.js';
import {
  fetchOgcPage,
  ogcItemsUrl,
  startRequest,
  type WaterDataRequest,
} from './water-data-client.js';
import { classifyWaterDataFailure } from './water-data-errors.js';

const NullableText = z.string().nullish();
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
const OffsetSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const CursorSchema = z
  .object({
    version: z.literal(1),
    site: z.string(),
    parameterCd: z.string().nullable(),
    seriesType: z.enum(['daily', 'instantaneous']).nullable(),
    limit: z.number().int(),
    offset: OffsetSchema,
  })
  .strict();

/** A single catalog request; a cursor is usable only with the same filters and page size. */
export interface SiteCatalogParams {
  cursor?: string | undefined;
  limit: number;
  parameterCd?: string | undefined;
  seriesType?: 'daily' | 'instantaneous' | undefined;
  site: string;
}

/** A sensor/statistic's metadata, preserving unavailable upstream values as null. */
export interface SiteCatalogSeries {
  beginDate: string | null;
  computation: string | null;
  computationPeriod: string | null;
  endDate: string | null;
  parameterCd: string;
  parameterName: string | null;
  seriesType: 'daily' | 'instantaneous' | null;
  statCd: string | null;
  sublocation: string | null;
  timeSeriesId: string;
  unit: string | null;
  webDescription: string | null;
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
    version: 1 as const,
    site: params.site,
    parameterCd: params.parameterCd ?? null,
    seriesType: params.seriesType ?? null,
    limit: params.limit,
  };
}

/** Decode only bounded data, never a URL to fetch. */
function cursorToken(params: SiteCatalogParams): number | undefined {
  if (!params.cursor) return undefined;
  try {
    const decoded = Buffer.from(params.cursor, 'base64url');
    if (decoded.toString('base64url') !== params.cursor) throw new Error('Invalid base64url');
    const cursor = CursorSchema.parse(JSON.parse(decoded.toString('utf8')));
    const { offset, ...filters } = cursor;
    if (JSON.stringify(filters) !== JSON.stringify(binding(params)))
      throw new Error('filter mismatch');
    return offset;
  } catch {
    throw validationError(
      'The catalog cursor is malformed or belongs to different filters or limit.',
      { reason: 'invalid_cursor' },
    );
  }
}

function seriesType(
  p: z.infer<typeof SeriesSchema>['properties'],
): SiteCatalogSeries['seriesType'] {
  if (p.computation_period_identifier === 'Daily') return 'daily';
  return p.computation_period_identifier === 'Points' &&
    p.computation_identifier === 'Instantaneous'
    ? 'instantaneous'
    : null;
}

/** Read one metadata page of `monitoringLocationId`, turning an upstream cursor rejection into `invalid_cursor`. */
async function readSeriesPage(
  params: SiteCatalogParams,
  monitoringLocationId: string,
  offset: number | undefined,
  request: WaterDataRequest,
) {
  const query = new URLSearchParams({
    monitoring_location_id: monitoringLocationId,
    limit: String(params.limit),
  });
  if (params.parameterCd) query.set('parameter_code', params.parameterCd);
  if (params.seriesType)
    query.set('computation_period_identifier', params.seriesType === 'daily' ? 'Daily' : 'Points');
  if (params.seriesType === 'instantaneous') query.set('computation_identifier', 'Instantaneous');
  if (offset) query.set('offset', String(offset));
  try {
    return await fetchOgcPage(
      'time-series-metadata',
      ogcItemsUrl('time-series-metadata', query),
      SeriesSchema,
      request,
    );
  } catch (error) {
    if (offset && error instanceof McpError && error.data?.reason === 'invalid_request')
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
 * retries and body parsing included.
 *
 * @throws {McpError} `not_found` (no location has the number), `invalid_cursor`, `upstream_timeout`,
 * `upstream_error`; a rate limit (`RateLimited`), a rejected `USGS_API_KEY`
 * (`ConfigurationError`), and caller cancellation pass through unchanged.
 */
export async function getSiteDataCatalog(
  params: SiteCatalogParams,
  ctx: Context,
): Promise<SiteDataCatalog> {
  const offset = cursorToken(params);
  const request = startRequest(ctx, 'getSiteDataCatalog');
  try {
    const site = (await resolveSites([params.site], request)).get(params.site);
    if (!site) throw notFound(`USGS site ${params.site} was not found.`, { reason: 'not_found' });
    const page = await readSeriesPage(params, site.monitoringLocationId, offset, request);
    /** Offset paging keeps position stable when upstream switches continuation styles. */
    const nextCursor = page.nextUrl
      ? Buffer.from(
          JSON.stringify({
            ...binding(params),
            offset: OffsetSchema.parse((offset ?? 0) + page.features.length),
          }),
        ).toString('base64url')
      : null;
    return {
      siteNumber: params.site,
      siteName: site.siteName,
      series: page.features.map(({ id, properties: p }) => ({
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
        seriesType: seriesType(p),
      })),
      nextCursor,
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

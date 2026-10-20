/**
 * @fileoverview One-page OGC site-series discovery with filter-bound cursors and a shared deadline.
 * @module services/waterdata/site-data-catalog
 */
import { type Context, z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  notFound,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';

const BASE = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections';
const METADATA = `${BASE}/time-series-metadata/items`;
const NullableText = z.string().nullish();
const PageSchema = z.object({
  features: z.array(
    z.object({
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
    }),
  ),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});
const LocationSchema = z.object({
  properties: z.object({
    monitoring_location_number: z.string(),
    monitoring_location_name: NullableText,
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

/** Read location and metadata together within 45 seconds, including retries and body parsing. */
export async function getSiteDataCatalog(
  params: SiteCatalogParams,
  ctx: Context,
): Promise<SiteDataCatalog> {
  const token = cursorToken(params);
  const query = new URLSearchParams({
    f: 'json',
    monitoring_location_id: `USGS-${params.site}`,
    limit: String(params.limit),
  });
  if (params.parameterCd) query.set('parameter_code', params.parameterCd);
  if (params.seriesType)
    query.set('computation_period_identifier', params.seriesType === 'daily' ? 'Daily' : 'Points');
  if (params.seriesType === 'instantaneous') query.set('computation_identifier', 'Instantaneous');
  if (token) query.set('offset', String(token));
  const cfg = getServerConfig();
  try {
    return await withRetry(
      async ({ signal, remainingMs }) => {
        const options = {
          signal,
          headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' },
        };
        let locationResponse: Response;
        try {
          locationResponse = await fetchWithTimeout(
            `${BASE}/monitoring-locations/items/USGS-${params.site}?f=json`,
            Math.min(cfg.requestTimeoutMs, remainingMs),
            ctx,
            { ...options, expectedStatuses: [404] },
          );
        } catch (error) {
          if (error instanceof McpError && error.code === JsonRpcErrorCode.NotFound)
            throw notFound(`USGS site ${params.site} was not found.`, { reason: 'not_found' });
          throw error;
        }
        const location = LocationSchema.parse(await locationResponse.json());
        if (location.properties.monitoring_location_number !== params.site)
          throw new Error('Unexpected monitoring location');
        let response: Response;
        try {
          response = await fetchWithTimeout(
            `${METADATA}?${query}`,
            Math.min(cfg.requestTimeoutMs, remainingMs),
            ctx,
            options,
          );
        } catch (error) {
          if (
            error instanceof McpError &&
            (error.data?.status === 400 || error.data?.status === 422) &&
            token
          )
            throw validationError(
              'USGS rejected the continuation cursor. Restart the catalog without cursor.',
              { reason: 'invalid_cursor' },
            );
          throw error;
        }
        const page = PageSchema.parse(await response.json());
        let nextCursor: string | null = null;
        const next = page.links?.find((link) => link.rel === 'next');
        if (next) {
          const url = new URL(next.href);
          if (
            url.origin !== new URL(METADATA).origin ||
            url.pathname !== new URL(METADATA).pathname
          )
            throw new Error('Unexpected metadata continuation');
          if (page.features.length === 0) throw new Error('Empty metadata page has a continuation');
          /** Offset paging keeps position stable when upstream switches continuation styles. */
          const offset = OffsetSchema.parse((token ?? 0) + page.features.length);
          nextCursor = Buffer.from(JSON.stringify({ ...binding(params), offset })).toString(
            'base64url',
          );
        }
        return {
          siteNumber: params.site,
          siteName: location.properties.monitoring_location_name ?? null,
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
            seriesType:
              p.computation_period_identifier === 'Daily'
                ? ('daily' as const)
                : p.computation_period_identifier === 'Points' &&
                    p.computation_identifier === 'Instantaneous'
                  ? ('instantaneous' as const)
                  : null,
          })),
          nextCursor,
        };
      },
      {
        deadlineMs: 45_000,
        maxRetries: 2,
        baseDelayMs: 500,
        operation: 'getSiteDataCatalog',
        context: ctx,
        signal: ctx.signal,
      },
    );
  } catch (error) {
    if (
      ctx.signal?.aborted ||
      (error instanceof McpError && error.code === JsonRpcErrorCode.RequestCancelled)
    )
      throw error;
    if (
      error instanceof McpError &&
      (error.data?.reason === 'not_found' || error.data?.reason === 'invalid_cursor')
    )
      throw error;
    if (error instanceof McpError && error.code === JsonRpcErrorCode.Timeout)
      throw new McpError(
        error.code,
        error.message,
        { ...error.data, reason: 'upstream_timeout' },
        { cause: error },
      );
    throw serviceUnavailable(
      'The USGS site-series catalog could not be read.',
      { reason: 'upstream_error' },
      { cause: error },
    );
  }
}

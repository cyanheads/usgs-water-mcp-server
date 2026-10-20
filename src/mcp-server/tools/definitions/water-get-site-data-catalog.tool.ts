/**
 * @fileoverview Discover per-site parameters, sensors, statistics, and UTC record bounds.
 * @module mcp-server/tools/definitions/water-get-site-data-catalog.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { escapeHtml } from '@cyanheads/mcp-ts-core/utils';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/nwis/input-schemas.js';
import { getSiteDataCatalog } from '@/services/waterdata/site-data-catalog.js';

/** Escape Markdown syntax without changing values; entities preserve embedded line breaks. */
function scalar(value: string | null): string {
  if (value === null) return '`null`';
  if (value === '') return '`""`';
  let text = escapeHtml(value).replaceAll('\\', '\\\\');
  for (const punctuation of ['`', '*', '_', '[', ']'])
    text = text.replaceAll(punctuation, `\\${punctuation}`);
  text = text.replaceAll('\r', '&#13;').replaceAll('\n', '&#10;').replaceAll('\t', '&#9;');
  return value === value.trim() ? text : text.replaceAll(' ', '&#32;');
}

/** Per-site series metadata for planning a subsequent water_get_series call. */
export const waterGetSiteDataCatalog = tool('water_get_site_data_catalog', {
  description:
    'Discover a USGS site’s parameters, sensors, statistics, and UTC record bounds before calling water_get_series. Find site numbers with water_find_sites. Each row is a distinct series; metadata bounds may contain gaps and lag observations. For water_get_series, take YYYY-MM-DD from beginDate/endDate, pass statCd only for daily rows, and obtain methodId from a water_get_series response; timeSeriesId is an OGC identifier, never an NWIS methodId. Rows with null seriesType are other computations and cannot be requested with water_get_series. Follow nextCursor with the same filters and limit until null.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    site: SiteNumberSchema.describe(
      'USGS site number (8–15 digits), from water_find_sites; e.g. "01646500".',
    ),
    parameterCd: z
      .preprocess((value) => (value === '' ? undefined : value), ParameterCdSchema.optional())
      .describe('Optional 5-digit parameter code from water_list_parameters, e.g. "00060".'),
    seriesType: z
      .preprocess(
        (value) => (value === '' ? undefined : value),
        z.enum(['daily', 'instantaneous']).optional(),
      )
      .describe(
        'Limit to Daily computations or Points/Instantaneous computations. Omit to include all periods.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .describe(
        'Maximum metadata rows per page (1–1000; default 100). Keep unchanged when using cursor.',
      ),
    cursor: z
      .string()
      .max(10_000)
      .optional()
      .describe(
        'Opaque nextCursor from the previous page; keep site, parameterCd, seriesType, and limit unchanged.',
      ),
  }),
  output: z.object({
    siteNumber: z.string().describe('USGS site number, preserving leading zeros.'),
    siteName: z.string().nullable().describe('Upstream site name, or null when unavailable.'),
    series: z
      .array(
        z
          .object({
            timeSeriesId: z
              .string()
              .describe('Distinct OGC time-series identifier; not an NWIS methodId.'),
            parameterCd: z.string().describe('USGS parameter code for this series.'),
            parameterName: z.string().nullable().describe('Upstream parameter name, or null.'),
            unit: z.string().nullable().describe('Upstream unit of measure, or null.'),
            statCd: z
              .string()
              .nullable()
              .describe(
                'Statistic identifier, or null; pass only for daily water_get_series calls.',
              ),
            beginDate: z
              .string()
              .nullable()
              .describe(
                'Full UTC first-observation bound, or null; take YYYY-MM-DD for startDate.',
              ),
            endDate: z
              .string()
              .nullable()
              .describe(
                'Full UTC latest-observation bound, or null; take YYYY-MM-DD for endDate. May lag observations.',
              ),
            sublocation: z
              .string()
              .nullable()
              .describe('Upstream sensor/sublocation description, or null.'),
            webDescription: z.string().nullable().describe('Upstream series description, or null.'),
            computationPeriod: z
              .string()
              .nullable()
              .describe(
                'Raw upstream computation period (e.g. Daily, Points, Water Year), or null.',
              ),
            computation: z
              .string()
              .nullable()
              .describe('Raw upstream computation (e.g. Mean, Instantaneous), or null.'),
            seriesType: z
              .enum(['daily', 'instantaneous'])
              .nullable()
              .describe(
                'daily for Daily; instantaneous for Points with Instantaneous; null otherwise.',
              ),
          })
          .describe('One distinct sensor/statistic metadata record.'),
      )
      .describe(
        'One metadata page; distinct sensors/statistics remain separate. Empty when a known site has no matching rows.',
      ),
    nextCursor: z
      .string()
      .nullable()
      .describe('Continuation for the same filters and limit, or null when no next page exists.'),
  }),
  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The monitoring location does not exist.',
      recovery: 'Find a valid site number with water_find_sites, then retry.',
      thrownBy: 'service',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The cursor is malformed or belongs to different filters or page size.',
      recovery: 'Omit cursor to restart, or reuse the original filters and limit.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The upstream request or shared 45-second deadline expired.',
      recovery: 'Retry after a short backoff; keep the same filters and cursor.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The OGC API failed or returned malformed location or metadata.',
      recovery: 'The USGS Water Data API is unavailable. Retry after a short backoff.',
      retryable: true,
      thrownBy: 'service',
    },
  ],
  handler(input, ctx) {
    return getSiteDataCatalog(
      {
        ...input,
        parameterCd: input.parameterCd,
        seriesType: input.seriesType,
      },
      ctx,
    );
  },
  format(result) {
    const lines = [
      `**siteNumber:** ${scalar(result.siteNumber)}`,
      `**siteName:** ${scalar(result.siteName)}`,
    ];
    for (const [index, row] of result.series.entries()) {
      lines.push('', `### Series ${index + 1}`);
      for (const [key, value] of Object.entries(row)) lines.push(`- **${key}:** ${scalar(value)}`);
    }
    if (result.series.length === 0) lines.push('', '**series:** []');
    lines.push('', `**nextCursor:** ${scalar(result.nextCursor)}`);
    return [{ type: 'text', text: lines.join('\n\n') }];
  },
});

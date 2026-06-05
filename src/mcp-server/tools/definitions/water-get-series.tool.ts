/**
 * @fileoverview Get a time series of daily or instantaneous values for a USGS site and parameter
 * over a date range. Large result sets (>500 rows) spill to DataCanvas when available.
 * @module mcp-server/tools/definitions/water-get-series.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { getSeries } from '@/services/nwis/nwis-service.js';
import type { NwisValueRecord } from '@/services/nwis/types.js';

/** Threshold above which results spill to canvas. */
const SPILLOVER_THRESHOLD = 500;

/** Preview character budget — ~25k tokens. */
const PREVIEW_CHARS = 100_000;

/** A single value record in the series output. */
const ValueRecordSchema = z.object({
  dateTime: z.string().describe('ISO 8601 date or date-time of this observation.'),
  value: z
    .string()
    .describe('Measured value as a string (empty string means no data for that interval).'),
  qualifiers: z
    .array(
      z.string().describe('A USGS data qualifier code (e.g. "P" = provisional, "A" = approved).'),
    )
    .describe('Data qualifier codes for this value.'),
});

export const waterGetSeries = tool('water_get_series', {
  description:
    'Get a time series of daily or instantaneous values for a USGS site and parameter over a date ' +
    'range. Returns siteNumber, parameterCd, and time-ordered value records. ' +
    'For large date ranges (>500 records), results spill to DataCanvas when CANVAS_PROVIDER_TYPE=duckdb ' +
    'is set — the response includes canvas_id and table_name for follow-up SQL via water_dataframe_query. ' +
    'Without DataCanvas, returns the most recent 500 records with a truncated flag. ' +
    'Use water_find_sites to discover valid site numbers. Use water_list_parameters for parameter codes.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    site: z
      .string()
      .describe(
        'USGS site number (8–15 digits, e.g. "01646500" for Potomac River at Little Falls). ' +
          'Use water_find_sites to discover valid site numbers.',
      ),
    parameterCd: z
      .string()
      .describe(
        '5-digit USGS parameter code (e.g. "00060" for discharge, "00065" for gage height). ' +
          'Use water_list_parameters to discover available codes.',
      ),
    startDate: z.string().describe('Start date in YYYY-MM-DD format (e.g. "2024-01-01").'),
    endDate: z.string().describe('End date in YYYY-MM-DD format (e.g. "2024-12-31").'),
    seriesType: z
      .enum(['daily', 'instantaneous'])
      .default('daily')
      .describe(
        '"daily" returns one value per day (DV service, typically mean/max/min). ' +
          '"instantaneous" returns ~15-minute readings (IV service). ' +
          'Default: "daily". Use "instantaneous" for high-resolution analysis.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID from a prior water_get_series call to append data to an existing canvas rather ' +
          'than creating a new one. Omit to start a fresh canvas.',
      ),
  }),
  output: z.object({
    siteNumber: z.string().describe('USGS site number (8–15 digits, e.g. "01646500").'),
    siteName: z.string().describe('Human-readable USGS site name.'),
    parameterCd: z.string().describe('5-digit USGS parameter code (e.g. "00060" for discharge).'),
    parameterName: z
      .string()
      .describe('Human-readable parameter name with units (e.g. "Streamflow, ft³/s").'),
    unitCode: z
      .string()
      .describe('Unit of measure for all values in this series (e.g. "ft3/s", "ft").'),
    seriesType: z
      .enum(['daily', 'instantaneous'])
      .describe(
        '"daily" = one value per day (DV service); "instantaneous" = ~15-minute readings (IV service).',
      ),
    values: z
      .array(
        ValueRecordSchema.describe('A single value record with date-time, value, and qualifiers.'),
      )
      .describe(
        'Time-ordered value records. Contains all records when not truncated, ' +
          'or the most recent 500 when truncated (no canvas) or a preview slice (with canvas).',
      ),
    totalRecords: z
      .number()
      .int()
      .describe('Total number of records in the upstream result set (before any truncation).'),
    truncated: z
      .boolean()
      .describe(
        'True when the result exceeds 500 records and was trimmed. Query the full series via water_dataframe_query when canvas_id is present, or narrow the date range.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID for the DataCanvas holding the full time series. Present only when truncated=true and DataCanvas is enabled. Pass to water_dataframe_describe then water_dataframe_query.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name in the canvas holding all records. Present when canvas_id is present. ' +
          'Use as the FROM target in water_dataframe_query SQL.',
      ),
  }),

  errors: [
    {
      reason: 'site_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The site number returned no time series.',
      recovery: 'Verify the site number using water_find_sites.',
    },
    {
      reason: 'no_data_for_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The site and parameter combination has no data in the requested date range.',
      recovery:
        'Try a shorter date range, verify parameter availability via water_find_sites, or use seriesType="instantaneous" for recent data.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.InvalidParams,
      when: 'endDate is before startDate, or a date is malformed.',
      recovery: 'Ensure startDate is before endDate and both are in YYYY-MM-DD format.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.InternalError,
      when: 'NWIS returned a 5xx error or the request timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    // Validate date range order
    if (input.startDate > input.endDate) {
      throw ctx.fail(
        'invalid_date_range',
        `startDate (${input.startDate}) must be before endDate (${input.endDate}).`,
      );
    }

    ctx.log.info('Getting series', {
      site: input.site,
      parameterCd: input.parameterCd,
      startDate: input.startDate,
      endDate: input.endDate,
      seriesType: input.seriesType,
    });

    let seriesList: Awaited<ReturnType<typeof getSeries>>;
    try {
      seriesList = await getSeries(
        {
          site: input.site,
          parameterCd: input.parameterCd,
          startDate: input.startDate,
          endDate: input.endDate,
          seriesType: input.seriesType,
        },
        ctx.signal,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('rejected') ||
        msg.includes('InvalidParams') ||
        msg.includes('ValidationError')
      ) {
        throw ctx.fail('invalid_date_range', msg);
      }
      if (
        msg.includes('unavailable') ||
        msg.includes('ServiceUnavailable') ||
        msg.includes('timed out')
      ) {
        throw ctx.fail('upstream_error', msg);
      }
      throw err;
    }

    if (seriesList.length === 0) {
      throw ctx.fail('site_not_found', `No time series returned for site ${input.site}.`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ts = seriesList[0]!;
    if (ts.values.length === 0) {
      throw ctx.fail(
        'no_data_for_range',
        `No data for site ${input.site} parameter ${input.parameterCd} in the requested date range.`,
      );
    }

    const totalRecords = ts.values.length;
    ctx.log.info('Series records', { totalRecords, site: ts.siteNumber });

    // Canvas spillover path
    const canvas = getCanvas();
    if (canvas && totalRecords > SPILLOVER_THRESHOLD) {
      const instance = await canvas.acquire(input.canvas_id, ctx);

      // Build rows suitable for canvas
      const rows = ts.values.map((v: NwisValueRecord) => ({
        date_time: v.dateTime,
        value: v.value,
        qualifiers: v.qualifiers.join(','),
        site_number: ts.siteNumber,
        parameter_cd: ts.parameterCd,
        unit_code: ts.unitCode,
      }));

      const tableName = `water_series_${ts.siteNumber}_${ts.parameterCd}`.replace(
        /[^a-z0-9_]/gi,
        '_',
      );

      const spillResult = await spillover({
        canvas: instance,
        source: rows,
        tableName,
        previewChars: PREVIEW_CHARS,
        signal: ctx.signal,
      });

      const previewValues = spillResult.previewRows.map((r) => ({
        dateTime: String(r['date_time'] ?? ''),
        value: String(r['value'] ?? ''),
        qualifiers: String(r['qualifiers'] ?? '')
          .split(',')
          .filter(Boolean),
      }));

      return {
        siteNumber: ts.siteNumber,
        siteName: ts.siteName,
        parameterCd: ts.parameterCd,
        parameterName: ts.parameterName,
        unitCode: ts.unitCode,
        seriesType: input.seriesType,
        values: previewValues,
        totalRecords,
        truncated: spillResult.spilled,
        canvas_id: spillResult.spilled ? instance.canvasId : undefined,
        table_name: spillResult.spilled ? spillResult.handle.tableName : undefined,
      };
    }

    // No canvas: return last 500 records
    const truncated = totalRecords > SPILLOVER_THRESHOLD;
    const values = truncated ? ts.values.slice(-SPILLOVER_THRESHOLD) : ts.values;

    return {
      siteNumber: ts.siteNumber,
      siteName: ts.siteName,
      parameterCd: ts.parameterCd,
      parameterName: ts.parameterName,
      unitCode: ts.unitCode,
      seriesType: input.seriesType,
      values,
      totalRecords,
      truncated,
      canvas_id: undefined,
      table_name: undefined,
    };
  },

  format(result) {
    const lines = [
      `### ${result.siteName} (${result.siteNumber})`,
      `**Parameter:** ${result.parameterName} (${result.parameterCd}) | **Unit:** ${result.unitCode}`,
      `**Series type:** ${result.seriesType} | **Total records:** ${result.totalRecords}`,
    ];

    if (result.truncated && result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` | **Table:** \`${result.table_name}\``,
        `*(result truncated — query the full series via water_dataframe_query)*`,
      );
    } else if (result.truncated) {
      lines.push(
        `*(showing last ${result.values.length} of ${result.totalRecords} records — set CANVAS_PROVIDER_TYPE=duckdb for full access)*`,
      );
    }

    lines.push('');
    const preview = result.values.slice(-20);
    for (const v of preview) {
      const qualifier = v.qualifiers.length > 0 ? ` [${v.qualifiers.join(',')}]` : '';
      lines.push(`- ${v.dateTime}: **${v.value}** ${result.unitCode}${qualifier}`);
    }
    if (result.values.length > 20) {
      lines.push(`*(showing 20 of ${result.values.length} inline records)*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * @fileoverview Get a time series of daily or instantaneous values for a USGS site and parameter
 * over a date range. Large result sets (>500 rows) spill to DataCanvas when available.
 * @module mcp-server/tools/definitions/water-get-series.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/nwis/input-schemas.js';
import { classifyNwisFailure, getSeries } from '@/services/nwis/nwis-service.js';
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
    'Get a daily or instantaneous time series for one USGS site and parameter over a date range, as time-ordered value records. Large sets (>500 records) return the most recent 500 with truncated=true; with DataCanvas enabled they instead spill to a canvas (canvas_id/table_name) for SQL via water_dataframe_query. Use water_find_sites and water_list_parameters to resolve inputs.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    site: SiteNumberSchema.describe(
      'USGS site number (8–15 digits, e.g. "01646500" for Potomac River at Little Falls). Use water_find_sites to discover valid site numbers.',
    ),
    parameterCd: ParameterCdSchema.describe(
      'A single 5-digit USGS parameter code (e.g. "00060" for discharge, "00065" for gage height). One code per call — this tool returns one series. Use water_list_parameters to discover available codes.',
    ),
    startDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be in YYYY-MM-DD format (e.g. "2024-01-01").')
      .describe('Start date in YYYY-MM-DD format (e.g. "2024-01-01").'),
    endDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'endDate must be in YYYY-MM-DD format (e.g. "2024-12-31").')
      .describe('End date in YYYY-MM-DD format (e.g. "2024-12-31").'),
    seriesType: z
      .enum(['daily', 'instantaneous'])
      .default('daily')
      .describe(
        '"daily" returns one value per day (DV service, typically mean/max/min). "instantaneous" returns ~15-minute readings (IV service). Default: "daily". Use "instantaneous" for high-resolution analysis.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID from a prior water_get_series call to append data to an existing canvas rather than creating a new one. Omit to start a fresh canvas.',
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
        'Time-ordered value records. Contains all records when not truncated, or the most recent 500 when truncated (no canvas) or a preview slice (with canvas).',
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
        'DuckDB table name in the canvas holding all records. Present when canvas_id is present. Use as the FROM target in water_dataframe_query SQL.',
      ),
  }),

  enrichment: {
    query: z
      .object({
        site: z.string().describe('Site number queried.'),
        parameterCd: z.string().describe('Parameter code queried.'),
        startDate: z.string().describe('Start date applied (YYYY-MM-DD).'),
        endDate: z.string().describe('End date applied (YYYY-MM-DD).'),
        seriesType: z.enum(['daily', 'instantaneous']).describe('Series type used.'),
      })
      .describe('Query parameters used for this request.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory when the result was truncated — narrow the date range or enable DataCanvas for full access.',
      ),
  },

  enrichmentTrailer: {
    query: {
      render(v) {
        return `**Query:** site=${v.site}, parameterCd=${v.parameterCd}, ${v.startDate} to ${v.endDate}, seriesType=${v.seriesType}`;
      },
    },
  },

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
      code: JsonRpcErrorCode.ValidationError,
      when: 'endDate is before startDate, or a date passes the YYYY-MM-DD shape check but is not a real calendar date.',
      recovery: 'Ensure startDate is before endDate and both are in YYYY-MM-DD format.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NWIS rejected the request. Input formats are validated against NWIS-accepted patterns before the call, so this surfaces a value that is well-formed but unacceptable upstream.',
      recovery:
        'Read the NWIS message in this error — it names the field it rejected. Correct that field and retry.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NWIS returned a 5xx error or the request timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    // Calendar validity: reject dates that pass the YYYY-MM-DD regex but aren't real calendar
    // dates — both NaN cases (month > 12, day > 31) and JS rollover cases (e.g. Feb 30 → Mar 1,
    // Feb 29 on a non-leap year → Mar 1). Round-trip through UTC to catch rollovers.
    const startParsed = new Date(`${input.startDate}T00:00:00Z`);
    const endParsed = new Date(`${input.endDate}T00:00:00Z`);
    const toUtcDate = (d: Date) =>
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (Number.isNaN(startParsed.getTime()) || toUtcDate(startParsed) !== input.startDate) {
      throw ctx.fail(
        'invalid_date_range',
        `Invalid startDate "${input.startDate}" — not a real calendar date. Use YYYY-MM-DD (e.g. month must be 01–12, day must be valid for the month).`,
      );
    }
    if (Number.isNaN(endParsed.getTime()) || toUtcDate(endParsed) !== input.endDate) {
      throw ctx.fail(
        'invalid_date_range',
        `Invalid endDate "${input.endDate}" — not a real calendar date. Use YYYY-MM-DD (e.g. month must be 01–12, day must be valid for the month).`,
      );
    }
    // Validate date range order
    if (startParsed > endParsed) {
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
      const failure = classifyNwisFailure(err);
      if (failure) throw ctx.fail(failure.reason, failure.message, undefined, { cause: err });
      throw err;
    }

    const ts = seriesList[0];
    if (!ts) {
      // NWIS returns an empty timeSeries array for both unknown sites and date ranges with no
      // data — both map here. Use no_data_for_range when the site is plausible but the range
      // may be the issue; callers can retry with a narrower range.
      throw ctx.fail(
        'no_data_for_range',
        `No data returned for site ${input.site} parameter ${input.parameterCd} — site may not exist, or no data in the requested date range (${input.startDate} to ${input.endDate}).`,
      );
    }
    if (ts.values.length === 0) {
      throw ctx.fail(
        'no_data_for_range',
        `No data for site ${input.site} parameter ${input.parameterCd} in the requested date range.`,
      );
    }

    const totalRecords = ts.values.length;
    ctx.log.info('Series records', { totalRecords, site: ts.siteNumber });

    ctx.enrich({
      query: {
        site: input.site,
        parameterCd: input.parameterCd,
        startDate: input.startDate,
        endDate: input.endDate,
        seriesType: input.seriesType,
      },
    });

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

      if (spillResult.spilled) {
        ctx.enrich({
          notice: `Result truncated to ${spillResult.previewRows.length} preview records — query the full ${totalRecords} records via water_dataframe_query using canvas_id.`,
        });
      }

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

    if (truncated) {
      ctx.enrich({
        notice: `Result truncated to ${SPILLOVER_THRESHOLD} records — narrow the date range or enable DataCanvas for full access to all ${totalRecords} records.`,
      });
    }

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
        `*(showing last ${result.values.length} of ${result.totalRecords} records — narrow the date range or enable DataCanvas for full access)*`,
      );
    }

    lines.push('');
    // Render every record in result.values so content[] mirrors structuredContent.values exactly.
    // The set is already bounded upstream — the character-budgeted canvas preview, or the last 500
    // on the no-canvas path — so there is no secondary inline cap to disclose here; the truncation
    // caption above covers the values-vs-totalRecords relationship.
    for (const v of result.values) {
      const qualifier = v.qualifiers.length > 0 ? ` [${v.qualifiers.join(',')}]` : '';
      lines.push(`- ${v.dateTime}: **${v.value}** ${result.unitCode}${qualifier}`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

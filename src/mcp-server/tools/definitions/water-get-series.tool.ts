/**
 * @fileoverview Get a time series of daily or instantaneous values for a USGS site and parameter
 * over a date range. Large result sets (>500 rows) spill to DataCanvas when available.
 * @module mcp-server/tools/definitions/water-get-series.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type CanvasInstance, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  assertCanvasTableName,
  sanitizeIdentifierToken,
} from '@/services/canvas/canvas-table-name.js';
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
    'Get a daily or instantaneous time series for one USGS site and parameter over a date range, as time-ordered value records. Large sets (>500 records) return the most recent records inline with truncated=true — the last 500 without DataCanvas, and with DataCanvas enabled the complete series also spills to a canvas (canvas_id/table_name): inspect the staged table with water_dataframe_describe, then read the full series with water_dataframe_query. Use water_find_sites and water_list_parameters to resolve inputs.',
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
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID from a prior call to add this series as a table on an existing canvas rather than creating a new one. Each distinct site, parameter code, series type, and date range gets its own table name, so re-running the identical query replaces its own table while a different query adds another alongside it. Applies only when the series spills to a canvas. Omit to start a fresh canvas.',
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
        'Time-ordered value records, oldest first within the slice. Holds every record when truncated is false; when truncated, the most recent records only — the last 500 without DataCanvas, or the last N that fit the inline preview budget when the full series is staged on a canvas.',
      ),
    totalRecords: z
      .number()
      .int()
      .describe('Total number of records in the upstream result set (before any truncation).'),
    truncated: z
      .boolean()
      .describe(
        'True when the result exceeds 500 records and only the most recent were returned inline. When canvas_id is present, inspect the staged table with water_dataframe_describe then read the full series with water_dataframe_query; otherwise narrow the date range.',
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
        'Advisory about this result: the staged canvas table and how to read it, the advice to narrow the date range when the series was truncated with no canvas available, or the fact that a supplied canvas_id went unused because nothing was staged.',
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
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NWIS returned a 5xx error or the request timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied canvas_id names a canvas that never existed or has expired. Raised before the NWIS request, so no upstream call is spent on it.',
      recovery:
        'Omit canvas_id to stage this series on a fresh canvas, or pass an id returned by a call that is still within its canvas lifetime.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'canvas_id was omitted and a fresh canvas was needed to stage the series, but this tenant already holds the maximum number of active canvases.',
      recovery:
        'Pass a canvas_id returned by an earlier call instead of starting a fresh canvas, or retry once an existing canvas expires.',
      retryable: true,
      thrownBy: 'service',
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
        ctx.recoveryFor('invalid_date_range'),
      );
    }
    if (Number.isNaN(endParsed.getTime()) || toUtcDate(endParsed) !== input.endDate) {
      throw ctx.fail(
        'invalid_date_range',
        `Invalid endDate "${input.endDate}" — not a real calendar date. Use YYYY-MM-DD (e.g. month must be 01–12, day must be valid for the month).`,
        ctx.recoveryFor('invalid_date_range'),
      );
    }
    // Validate date range order
    if (startParsed > endParsed) {
      throw ctx.fail(
        'invalid_date_range',
        `startDate (${input.startDate}) must be before endDate (${input.endDate}).`,
        ctx.recoveryFor('invalid_date_range'),
      );
    }

    // A supplied canvas_id is resolved before the upstream call so a stale or never-minted id fails
    // without spending an NWIS round trip. Minting stays lazy — a fresh canvas is acquired further
    // down, only once the series actually has to spill.
    const canvas = getCanvas();
    let instance: CanvasInstance | undefined;
    if (canvas && input.canvas_id) {
      try {
        instance = await canvas.acquire(input.canvas_id, ctx);
      } catch (err: unknown) {
        if (err instanceof McpError && err.data?.['reason'] === 'canvas_not_found') {
          throw ctx.fail(
            'canvas_not_found',
            `Canvas ${input.canvas_id} not found or expired.`,
            ctx.recoveryFor('canvas_not_found'),
            { cause: err },
          );
        }
        throw err;
      }
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
        ctx,
      );
    } catch (err: unknown) {
      const failure = classifyNwisFailure(err);
      if (failure)
        throw ctx.fail(failure.reason, failure.message, ctx.recoveryFor(failure.reason), {
          cause: err,
        });
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
        ctx.recoveryFor('no_data_for_range'),
      );
    }
    if (ts.values.length === 0) {
      throw ctx.fail(
        'no_data_for_range',
        `No data for site ${input.site} parameter ${input.parameterCd} in the requested date range.`,
        ctx.recoveryFor('no_data_for_range'),
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

    // A canvas_id the caller supplied that no staging used. Emitted only when the whole series came
    // back inline: a truncated no-canvas result already explains why it was cut, and "returned
    // inline in full" would misdescribe a response holding the last 500 of N.
    const nothingStagedNotice = input.canvas_id
      ? `The ${totalRecords}-record series was returned inline in full, so nothing was staged on canvas "${input.canvas_id}".`
      : undefined;

    // Canvas spillover path
    if (canvas && totalRecords > SPILLOVER_THRESHOLD) {
      instance ??= await canvas.acquire(undefined, ctx);

      // Build rows suitable for canvas
      const rows = ts.values.map((v: NwisValueRecord) => ({
        date_time: v.dateTime,
        value: v.value,
        qualifiers: v.qualifiers.join(','),
        site_number: ts.siteNumber,
        parameter_cd: ts.parameterCd,
        unit_code: ts.unitCode,
      }));

      // The name carries every dimension that changes the staged rows. registerTable is DROP +
      // CREATE, so a name that collapsed a site's daily and instantaneous series — different
      // quantities, identical columns — would replace one with the other and still report success.
      // Every dimension here is fixed-width, so no digest is needed: the longest legal input (a
      // 15-digit site number) lands at 55 characters, inside the 63-character identifier cap.
      // Derived from the request, not the echoed response: the name has to be total over the query,
      // and an upstream value that normalizes two distinct requests to one token would collapse
      // them onto one table — the failure this name exists to prevent.
      const tableName = assertCanvasTableName(
        [
          'water_series',
          sanitizeIdentifierToken(input.site),
          sanitizeIdentifierToken(input.parameterCd),
          input.seriesType === 'daily' ? 'dv' : 'iv',
          sanitizeIdentifierToken(input.startDate.replaceAll('-', '')),
          sanitizeIdentifierToken(input.endDate.replaceAll('-', '')),
        ].join('_'),
      );

      const spillResult = await spillover({
        canvas: instance,
        source: rows,
        tableName,
        previewChars: PREVIEW_CHARS,
        signal: ctx.signal,
      });

      // spillover() fills its preview from the head of the source, so previewRows holds the OLDEST
      // records that fit the character budget. For a time series the recent end is almost always
      // the one that matters — and the no-canvas path below already returns the most recent — so
      // the inline slice is the tail of the same chronological rows at the count the budget chose.
      // The rows handed to spillover() stay in order, so the staged table holds every record
      // chronologically. Sliced from the front index rather than a negative offset: slice(-0)
      // returns the whole array, which would silently inline the full series at an empty preview.
      const values = ts.values.slice(totalRecords - spillResult.previewRows.length);

      if (spillResult.spilled) {
        ctx.enrich({
          notice: `Staged all ${totalRecords} records to table "${spillResult.handle.tableName}" — use water_dataframe_describe to inspect its columns, then water_dataframe_query to analyze the full series with SQL (canvas_id "${instance.canvasId}"). Showing last ${values.length} of ${totalRecords} records inline.`,
        });
      } else if (nothingStagedNotice) {
        // Past the record threshold but under the character budget: spillover() registered nothing,
        // so a supplied canvas_id went unused here exactly as it does below the threshold.
        ctx.enrich({ notice: nothingStagedNotice });
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
        truncated: spillResult.spilled,
        canvas_id: spillResult.spilled ? instance.canvasId : undefined,
        table_name: spillResult.spilled ? spillResult.handle.tableName : undefined,
      };
    }

    // No canvas: return last 500 records
    const truncated = totalRecords > SPILLOVER_THRESHOLD;
    const values = truncated ? ts.values.slice(-SPILLOVER_THRESHOLD) : ts.values;

    if (truncated) {
      // Reaching a truncated result here means no provider is enabled — the spillover branch owns
      // every over-threshold path when one is. A supplied canvas_id is named for the same reason
      // the inline case names it: silence is indistinguishable from data having been staged.
      const unusedCanvas = input.canvas_id
        ? ` DataCanvas is not enabled on this server, so the series was not staged and canvas "${input.canvas_id}" went unused.`
        : '';
      ctx.enrich({
        notice: `Result truncated to the most recent ${SPILLOVER_THRESHOLD} of ${totalRecords} records — narrow the date range or enable DataCanvas for full access.${unusedCanvas}`,
      });
    } else if (nothingStagedNotice) {
      ctx.enrich({ notice: nothingStagedNotice });
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

    // Keyed on canvas_id alone: the staged table is worth naming whenever one exists, and the
    // caption names the inline slice's direction the way the no-canvas caption below always has.
    if (result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` | **Table:** \`${result.table_name}\``,
        `*(result truncated — showing last ${result.values.length} of ${result.totalRecords} records; use water_dataframe_describe for this table's columns, then water_dataframe_query for the full series)*`,
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

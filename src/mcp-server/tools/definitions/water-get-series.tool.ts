/**
 * @fileoverview Get a time series of daily or instantaneous values for a USGS site and parameter
 * over a date range. Large result sets (>500 rows) spill to DataCanvas when available.
 * @module mcp-server/tools/definitions/water-get-series.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type CanvasInstance, spillover } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas } from '@/services/canvas/acquire-canvas.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  assertCanvasTableName,
  sanitizeIdentifierToken,
  shortHash,
} from '@/services/canvas/canvas-table-name.js';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/nwis/input-schemas.js';
import { carriesValues, classifyNwisFailure, getSeries } from '@/services/nwis/nwis-service.js';
import type { NwisTimeSeries, NwisValueRecord } from '@/services/nwis/types.js';

/** Threshold above which results spill to canvas. */
const SPILLOVER_THRESHOLD = 500;

/** Preview character budget — ~25k tokens. */
const PREVIEW_CHARS = 100_000;

/** Daily-mean statistic code — the statistic returned when the caller names none. */
const MEAN_STAT_CD = '00003';

/** The only statistic an instantaneous (IV) series carries. */
const INSTANTANEOUS_STAT_CD = '00000';

/** A form client submits an untouched optional text field as "" — treat it as omitted. */
function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Pick the one series this tool returns from every statistic × method NWIS sent back.
 *
 * A requested statCd and methodId narrow the pool first. Among what remains, series carrying a
 * value win over the rest — an empty series, or one whose every record NWIS reported as no data
 * (see {@link carriesValues}) — the daily mean (00003) wins over other statistics, and within the
 * chosen statistic the method with the most records wins, ties going to the earlier series in
 * NWIS response order. When no series carries a value, the same order runs over the whole pool.
 * Undefined only when the requested statCd/methodId matched nothing.
 */
function selectSeries(
  seriesList: NwisTimeSeries[],
  wanted: { methodId: string | undefined; statCd: string | undefined },
): NwisTimeSeries | undefined {
  const pool = seriesList.filter(
    (s) =>
      (!wanted.statCd || s.statCd === wanted.statCd) &&
      (!wanted.methodId || s.methodId === wanted.methodId),
  );
  const withValues = pool.filter(carriesValues);
  const candidates = withValues.length > 0 ? withValues : pool;
  const statCd = candidates.some((s) => s.statCd === MEAN_STAT_CD)
    ? MEAN_STAT_CD
    : candidates[0]?.statCd;
  return candidates
    .filter((s) => s.statCd === statCd)
    .reduce<NwisTimeSeries | undefined>(
      (best, s) => (!best || s.values.length > best.values.length ? s : best),
      undefined,
    );
}

/** One-line label for a series, used when listing what a query offered. */
function describeSeries(s: {
  methodDescription: string | null;
  methodId: string | null;
  statCd: string;
}): string {
  return `statCd ${s.statCd}, methodId ${s.methodId ?? 'none'} (${s.methodDescription ?? 'no description'})`;
}

/** A single value record in the series output. */
const ValueRecordSchema = z.object({
  dateTime: z.string().describe('ISO 8601 date or date-time of this observation.'),
  value: z
    .string()
    .describe(
      'Measured value as a string. Empty string when NWIS reported no value for that interval — qualifiers then give the reason (e.g. "Ssn" seasonal, "Dis" discontinued, "Dry", "Eqp" equipment malfunction). A staged canvas table holds NULL for these.',
    ),
  qualifiers: z
    .array(
      z.string().describe('A USGS data qualifier code (e.g. "P" = provisional, "A" = approved).'),
    )
    .describe('Data qualifier codes for this value.'),
});

export const waterGetSeries = tool('water_get_series', {
  description:
    'Get a daily or instantaneous time series for one USGS site and parameter over a date range, as time-ordered value records. NWIS can hold several series for one query — one per daily statistic (mean, maximum, minimum) and one per sensor (method); this returns one, reporting its statCd and methodId, and lists the rest in otherSeries so any can be re-requested with the statCd and methodId inputs. By default it returns the daily mean when NWIS returns one with values, and the method with the most records. Large sets (>500 records) return the most recent records inline with truncated=true — the last 500 without DataCanvas, and with DataCanvas enabled the complete series also spills to a canvas (canvas_id/table_name): inspect the staged table with water_dataframe_describe, then read the full series with water_dataframe_query. Use water_find_sites and water_list_parameters to resolve inputs.',
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
    statCd: z
      .string()
      .optional()
      .describe(
        'Daily statistic to return, as a 5-digit NWIS code: "00003" mean, "00001" maximum, "00002" minimum. Omit for the mean when NWIS returns one with values, otherwise the first statistic that has values; the response names the one returned and lists the others in otherSeries. Daily series only — instantaneous values carry just "00000".',
      ),
    methodId: z
      .string()
      .optional()
      .describe(
        'NWIS method ID of the sensor series to return — the methodId or an otherSeries[].methodId from a prior response for the same site, parameter, and seriesType. Omit for the method with the most records. IDs differ between daily and instantaneous series and between daily statistics.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID from a prior call to add this series as a table on an existing canvas rather than creating a new one. Each distinct site, parameter code, series type, date range, and selected statistic and method gets its own table name, so re-running the identical query replaces its own table while a different query adds another alongside it. Applies only when the series spills to a canvas. Omit to start a fresh canvas.',
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
    statCd: z
      .string()
      .describe(
        'NWIS statistic code of the returned series: "00003" daily mean, "00001" daily maximum, "00002" daily minimum, "00000" for instantaneous values.',
      ),
    statName: z
      .string()
      .nullable()
      .describe(
        'Statistic name NWIS attaches to statCd (e.g. "Mean", "Maximum"). Null when NWIS gives none, as for instantaneous values.',
      ),
    methodId: z
      .string()
      .nullable()
      .describe(
        'NWIS method ID of the sensor series returned. Pass it back as the methodId input to request this series again. Null only when NWIS returned the series with no method block.',
      ),
    methodDescription: z
      .string()
      .nullable()
      .describe(
        'NWIS description of that method (e.g. "From multiparameter sonde", "7.1 ft from riverbed (top), [Discontinued]"). Null when NWIS leaves it blank, as it does for the default series at most single-sensor sites.',
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
    otherSeries: z
      .array(
        z
          .object({
            statCd: z.string().describe('NWIS statistic code of this series (e.g. "00001").'),
            statName: z
              .string()
              .nullable()
              .describe('Statistic name for statCd (e.g. "Maximum"); null when NWIS gives none.'),
            methodId: z
              .string()
              .nullable()
              .describe('NWIS method ID of this series — pass as the methodId input.'),
            methodDescription: z
              .string()
              .nullable()
              .describe('NWIS description of the method; null when blank.'),
            recordCount: z
              .number()
              .int()
              .describe('Number of value records this series holds over the requested range.'),
          })
          .describe('One series NWIS returned for this query that was not selected.'),
      )
      .describe(
        'Every other statistic × method series NWIS returned for this query — re-request one with its statCd and methodId. Empty when the query produced a single series. A method block with no values over the range is omitted when another method of the same statistic has values.',
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
        statCd: z.string().optional().describe('Statistic code requested, if any.'),
        methodId: z.string().optional().describe('Method ID requested, if any.'),
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
        const selection = [
          v.statCd ? `, statCd=${v.statCd}` : '',
          v.methodId ? `, methodId=${v.methodId}` : '',
        ].join('');
        return `**Query:** site=${v.site}, parameterCd=${v.parameterCd}, ${v.startDate} to ${v.endDate}, seriesType=${v.seriesType}${selection}`;
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
      reason: 'invalid_stat_cd',
      code: JsonRpcErrorCode.ValidationError,
      when: 'statCd is not a 5-digit NWIS statistic code. Raised before the NWIS request.',
      recovery:
        'Pass a 5-digit statistic code such as "00003" (mean), "00001" (maximum), or "00002" (minimum), or omit statCd.',
    },
    {
      reason: 'stat_cd_for_instantaneous',
      code: JsonRpcErrorCode.ValidationError,
      when: 'statCd names a daily statistic but seriesType is "instantaneous", whose values carry only statistic "00000". Raised before the NWIS request.',
      recovery:
        'Omit statCd for an instantaneous series, or set seriesType to "daily" to select a daily statistic.',
    },
    {
      reason: 'method_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No series NWIS returned for this query carries the requested methodId (within the requested statCd, when one is given), or that method returned no values over the range.',
      recovery:
        'Re-request with a methodId listed in this error, or omit methodId to get the method with the most records.',
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
      when: 'NWIS returned a 5xx error, timed out, or sent a response body that is not valid WaterML-JSON (cut off mid-document), and retrying did not clear it.',
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

    // Selection inputs are checked here rather than in the schema so a malformed value fails with a
    // reason and recovery hint of its own, and so a form client's "" reads as omitted.
    const statCd = optionalText(input.statCd);
    const methodId = optionalText(input.methodId);
    if (statCd && !/^\d{5}$/.test(statCd)) {
      throw ctx.fail(
        'invalid_stat_cd',
        `statCd "${statCd}" is not a 5-digit NWIS statistic code.`,
        ctx.recoveryFor('invalid_stat_cd'),
      );
    }
    // The IV service rejects the statCd keyword outright (HTTP 400), and every IV series is "00000".
    if (statCd && input.seriesType === 'instantaneous' && statCd !== INSTANTANEOUS_STAT_CD) {
      throw ctx.fail(
        'stat_cd_for_instantaneous',
        `statCd "${statCd}" selects a daily statistic, but seriesType is "instantaneous" — instantaneous values carry only statistic "${INSTANTANEOUS_STAT_CD}".`,
        ctx.recoveryFor('stat_cd_for_instantaneous'),
      );
    }

    // A supplied canvas_id is resolved before the upstream call so a stale or never-minted id fails
    // without spending an NWIS round trip. Minting stays lazy — a fresh canvas is acquired further
    // down, only once the series actually has to spill.
    const canvas = getCanvas();
    let instance: CanvasInstance | undefined;
    if (canvas && input.canvas_id) {
      instance = await acquireCanvas(canvas, input.canvas_id, ctx);
    }

    ctx.log.info('Getting series', {
      site: input.site,
      parameterCd: input.parameterCd,
      startDate: input.startDate,
      endDate: input.endDate,
      seriesType: input.seriesType,
      statCd,
      methodId,
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
          ...(statCd ? { statCd } : {}),
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

    const ts = selectSeries(seriesList, { statCd, methodId });
    if (!ts && methodId && seriesList.length > 0) {
      const available = seriesList
        .filter((s) => !statCd || s.statCd === statCd)
        .map(describeSeries)
        .join('; ');
      throw ctx.fail(
        'method_not_found',
        `No series with methodId "${methodId}"${statCd ? ` and statCd ${statCd}` : ''} carries values for site ${input.site} parameter ${input.parameterCd} over ${input.startDate} to ${input.endDate}.`,
        {
          recovery: {
            hint: `Re-request with one of these (pass its statCd and methodId), or omit methodId to get the method with the most records: ${available}.`,
          },
        },
      );
    }
    if (!ts) {
      // NWIS returns an empty timeSeries array for both unknown sites and date ranges with no
      // data — both map here. Use no_data_for_range when the site is plausible but the range
      // may be the issue; callers can retry with a narrower range. A forwarded daily statCd that
      // NWIS publishes no series for comes back the same way.
      const statNote = statCd
        ? ` NWIS may also publish no daily statistic ${statCd} here — omit statCd to see which statistics it returns.`
        : '';
      throw ctx.fail(
        'no_data_for_range',
        `No data returned for site ${input.site} parameter ${input.parameterCd} — site may not exist, or no data in the requested date range (${input.startDate} to ${input.endDate}).${statNote}`,
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
    ctx.log.info('Series records', {
      totalRecords,
      site: ts.siteNumber,
      statCd: ts.statCd,
      methodId: ts.methodId,
      seriesOffered: seriesList.length,
    });

    const selected = {
      siteNumber: ts.siteNumber,
      siteName: ts.siteName,
      parameterCd: ts.parameterCd,
      parameterName: ts.parameterName,
      unitCode: ts.unitCode,
      seriesType: input.seriesType,
      statCd: ts.statCd,
      statName: ts.statName,
      methodId: ts.methodId,
      methodDescription: ts.methodDescription,
    };
    const otherSeries = seriesList
      .filter((s) => s !== ts)
      .map((s) => ({
        statCd: s.statCd,
        statName: s.statName,
        methodId: s.methodId,
        methodDescription: s.methodDescription,
        recordCount: s.values.length,
      }));

    ctx.enrich({
      query: {
        site: input.site,
        parameterCd: input.parameterCd,
        startDate: input.startDate,
        endDate: input.endDate,
        seriesType: input.seriesType,
        ...(statCd ? { statCd } : {}),
        ...(methodId ? { methodId } : {}),
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

      // Build rows suitable for canvas. A record NWIS reported as no data stages as NULL, so SQL
      // aggregates skip it instead of meeting an empty string.
      const rows = ts.values.map((v: NwisValueRecord) => ({
        date_time: v.dateTime,
        value: v.value === '' ? null : v.value,
        qualifiers: v.qualifiers.join(','),
        site_number: ts.siteNumber,
        parameter_cd: ts.parameterCd,
        unit_code: ts.unitCode,
        stat_cd: ts.statCd,
        method_id: ts.methodId,
      }));

      // The name carries every dimension that changes the staged rows. registerTable is DROP +
      // CREATE, so a name that collapsed a site's daily and instantaneous series — different
      // quantities, identical columns — would replace one with the other and still report success.
      // The query dimensions are fixed-width and read off the request: the longest legal input (a
      // 15-digit site number) lands at 55 characters. The statistic and method are a selection
      // among the series NWIS returned, so they are appended as a 7-hex digest of the selected
      // statCd + methodId (63 characters at worst, the identifier cap) whenever a choice was made —
      // the caller named one, or the response offered more than one series. A query answered by a
      // single series keeps the bare name, so re-running it still replaces its own table.
      const selectionMade = statCd !== undefined || methodId !== undefined || seriesList.length > 1;
      const tableName = assertCanvasTableName(
        [
          'water_series',
          sanitizeIdentifierToken(input.site),
          sanitizeIdentifierToken(input.parameterCd),
          input.seriesType === 'daily' ? 'dv' : 'iv',
          sanitizeIdentifierToken(input.startDate.replaceAll('-', '')),
          sanitizeIdentifierToken(input.endDate.replaceAll('-', '')),
          ...(selectionMade ? [shortHash({ statCd: ts.statCd, methodId: ts.methodId }, 7)] : []),
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
        ...selected,
        values,
        totalRecords,
        truncated: spillResult.spilled,
        canvas_id: spillResult.spilled ? instance.canvasId : undefined,
        table_name: spillResult.spilled ? spillResult.handle.tableName : undefined,
        otherSeries,
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
      ...selected,
      values,
      totalRecords,
      truncated,
      canvas_id: undefined,
      table_name: undefined,
      otherSeries,
    };
  },

  format(result) {
    const lines = [
      `### ${result.siteName} (${result.siteNumber})`,
      `**Parameter:** ${result.parameterName} (${result.parameterCd}) | **Unit:** ${result.unitCode}`,
      `**Series type:** ${result.seriesType} | **Total records:** ${result.totalRecords}`,
      `**Statistic:** ${result.statName ?? 'unnamed'} (statCd ${result.statCd}) | **Method:** ${result.methodDescription ?? '(no description)'} | **Method ID:** ${result.methodId ?? 'none'}`,
    ];

    if (result.otherSeries.length > 0) {
      lines.push(
        `**Other series for this query** (re-request with statCd and methodId): ${result.otherSeries
          .map(
            (s) =>
              `${s.statName ?? 'unnamed'} (statCd ${s.statCd}), ${s.methodDescription ?? '(no description)'} (methodId ${s.methodId ?? 'none'}), ${s.recordCount} records`,
          )
          .join('; ')}`,
      );
    }

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
      lines.push(
        v.value === ''
          ? `- ${v.dateTime}: no data${qualifier}`
          : `- ${v.dateTime}: **${v.value}** ${result.unitCode}${qualifier}`,
      );
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

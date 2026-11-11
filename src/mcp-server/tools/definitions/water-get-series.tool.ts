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
import { ParameterCdSchema, SiteNumberSchema } from '@/services/waterdata/input-schemas.js';
import { carriesValues, getSeries } from '@/services/waterdata/observations.js';
import { startDeadline } from '@/services/waterdata/request-deadline.js';
import type { NwisTimeSeries, NwisValueRecord } from '@/services/waterdata/types.js';
import type { WaterDataRequest } from '@/services/waterdata/water-data-client.js';
import { classifyWaterDataFailure } from '@/services/waterdata/water-data-errors.js';

/** Threshold above which results spill to canvas. */
const SPILLOVER_THRESHOLD = 500;

/** Preview character budget — ~25k tokens. */
const PREVIEW_CHARS = 100_000;

/** Daily-mean statistic code — the statistic returned when the caller names none. */
const MEAN_STAT_CD = '00003';

/** The only statistic an instantaneous series carries. */
const INSTANTANEOUS_STAT_CD = '00000';

/**
 * The statistic the OGC time-series metadata, and so water_get_site_data_catalog, lists on
 * instantaneous rows; it names the same series as {@link INSTANTANEOUS_STAT_CD}.
 */
const CATALOG_INSTANTANEOUS_STAT_CD = '00011';

/**
 * A methodId of digits only: the numeric method IDs WaterServices used. Time-series IDs are 32
 * hexadecimal characters, so such an ID matches no series.
 */
const NUMERIC_METHOD_ID = /^\d+$/;

/** True when a YYYY-MM-DD string is a real calendar date; JS rollover (Feb 30 → Mar 1) and NaN both fail. */
function isCalendarDate(date: string): boolean {
  const parsed = new Date(`${date}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, '0')}-${String(parsed.getUTCDate()).padStart(2, '0')}` ===
      date
  );
}

/** A form client submits an untouched optional text field as "" — treat it as omitted. */
function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Pick the one series this tool returns from every statistic × method the service sent back.
 *
 * A requested statCd and methodId narrow the pool first. Among what remains, series carrying a
 * value win over the rest — an empty series, or one whose every record the upstream reported as
 * no data (see {@link carriesValues}) — the daily mean (00003) wins over other statistics, and
 * within the chosen statistic the method with the most records wins. A tie goes to the site's
 * default sensor (methodDescription null) over a labeled one such as an auxiliary gage — the
 * service orders by ID after the first observation, so a base and an auxiliary gage that began
 * together would otherwise tie on an arbitrary ID — and then to the earlier series in the
 * service's order (the one that began first). When no series carries a value, the same order runs
 * over the whole pool.
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
      (best, s) =>
        !best ||
        s.values.length > best.values.length ||
        (s.values.length === best.values.length &&
          s.methodDescription === null &&
          best.methodDescription !== null)
          ? s
          : best,
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
      'Measured value as a string. Empty string when the upstream reported no value for that interval — qualifiers then give the reason (e.g. "Ssn" seasonal, "Dis" discontinued, "Dry", "Eqp" equipment malfunction). A staged canvas table holds NULL for these.',
    ),
  qualifiers: z
    .array(
      z
        .string()
        .describe(
          'A USGS data qualifier code (e.g. "P" = provisional, "A" = approved, "e" = estimated). A qualifier with no code is the upstream word as written (e.g. "OTHERAGENCY").',
        ),
    )
    .describe(
      'Data qualifier codes for this value: the approval code first, then one per qualifier.',
    ),
});

export const waterGetSeries = tool('water_get_series', {
  description:
    'Get a daily or instantaneous time series for one USGS site and parameter over a date range, as time-ordered value records. A site can hold several series for one query — one per daily statistic (mean, maximum, minimum) and one per sensor (method); this returns one, reporting its statCd and methodId (its time-series ID), and lists the rest in otherSeries so any can be re-requested with the statCd and methodId inputs. By default it returns the daily mean when one carries values, and the method with the most records. Large sets (>500 records) return the most recent records inline with truncated=true — the last 500 without DataCanvas, and with DataCanvas enabled the complete series also spills to a canvas (canvas_id/table_name): inspect the staged table with water_dataframe_describe, then read the full series with water_dataframe_query. Use water_find_sites and water_list_parameters to resolve inputs; water_get_site_data_catalog lists a site’s series with their record bounds (beginDate/endDate), and a row’s timeSeriesId works as methodId.',
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
        '"daily" returns one value per day (typically mean/max/min). "instantaneous" returns ~15-minute readings. Default: "daily". Use "instantaneous" for high-resolution analysis.',
      ),
    statCd: z
      .string()
      .optional()
      .describe(
        'Daily statistic to return, as a 5-digit USGS statistic code: "00003" mean, "00001" maximum, "00002" minimum. Omit for the mean when one carries values, otherwise the lowest-numbered statistic that has values; the response names the one returned and lists the others in otherSeries. Daily series only — instantaneous values carry just "00000" ("00011", the statistic water_get_site_data_catalog lists on instantaneous rows, reads the same).',
      ),
    methodId: z
      .string()
      .optional()
      .describe(
        'Time-series ID of the series to return (the OGC time_series_id, 32 hexadecimal characters) — the methodId or an otherSeries[].methodId from a prior response for the same site, parameter, and seriesType, or a timeSeriesId from water_get_site_data_catalog whose seriesType matches this call. Omit for the method with the most records, ties going to the site’s default sensor (methodDescription null) over a labeled one such as an auxiliary gage, then to the series that began first. Each daily statistic and the instantaneous series of one sensor carry different IDs. A numeric NWIS method ID matches no series.',
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
      .describe(
        'Parameter description from the USGS parameter-code catalog, units included (e.g. "Discharge, cubic feet per second").',
      ),
    unitCode: z
      .string()
      .describe('Unit of measure for all values in this series (e.g. "ft3/s", "ft", "deg C").'),
    seriesType: z
      .enum(['daily', 'instantaneous'])
      .describe('"daily" = one value per day; "instantaneous" = ~15-minute readings.'),
    statCd: z
      .string()
      .describe(
        'USGS statistic code of the returned series: "00003" daily mean, "00001" daily maximum, "00002" daily minimum, "00000" for instantaneous values.',
      ),
    statName: z
      .string()
      .nullable()
      .describe(
        'Statistic name for statCd (e.g. "Mean", "Maximum"). Null when the upstream gives none, as for instantaneous values.',
      ),
    methodId: z
      .string()
      .nullable()
      .describe(
        'Time-series ID of the series returned — the OGC time_series_id, the same value water_get_site_data_catalog lists as timeSeriesId. Pass it back as the methodId input to request this series again. Null only when the upstream sent the series without an ID.',
      ),
    methodDescription: z
      .string()
      .nullable()
      .describe(
        'Description of the sensor, built from the series metadata as "<sublocation>, [<web description>]" (e.g. "From multiparameter sonde, [Discontinued]"), or either part alone when the other is blank (e.g. "From multiparameter sonde", "[Radar]"). Null when the metadata leaves both blank, as it does for the default series at most single-sensor sites.',
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
            statCd: z.string().describe('USGS statistic code of this series (e.g. "00001").'),
            statName: z
              .string()
              .nullable()
              .describe(
                'Statistic name for statCd (e.g. "Maximum"); null when the upstream gives none.',
              ),
            methodId: z
              .string()
              .nullable()
              .describe('Time-series ID of this series — pass as the methodId input.'),
            methodDescription: z
              .string()
              .nullable()
              .describe('Description of the sensor; null when blank.'),
            recordCount: z
              .number()
              .int()
              .describe('Number of value records this series holds over the requested range.'),
          })
          .describe('One series returned for this query that was not selected.'),
      )
      .describe(
        'Every other statistic × method series returned for this query, a series with no records in the range included (recordCount 0), ordered by statistic code, then first observation — re-request one with its statCd and methodId. Empty when the query produced a single series.',
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
        'Read the site’s record bounds with water_get_site_data_catalog (beginDate/endDate on each series row) and request a range inside them, or use seriesType="instantaneous" for recent data.',
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
      when: 'statCd is not a 5-digit USGS statistic code. Raised before any upstream request.',
      recovery:
        'Pass a 5-digit statistic code such as "00003" (mean), "00001" (maximum), or "00002" (minimum), or omit statCd.',
    },
    {
      reason: 'stat_cd_for_instantaneous',
      code: JsonRpcErrorCode.ValidationError,
      when: 'statCd names a daily statistic but seriesType is "instantaneous", whose values carry only statistic "00000". Raised before any upstream request.',
      recovery:
        'Omit statCd for an instantaneous series, or set seriesType to "daily" to select a daily statistic.',
    },
    {
      reason: 'method_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No series returned for this query carries the requested methodId (within the requested statCd, when one is given). A numeric NWIS method ID always lands here: methodId is the 32-character OGC time-series ID.',
      recovery:
        'Re-request with a methodId listed in this error, or omit methodId to get the method with the most records.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The USGS Water Data API rejected the request. Input formats are validated before the call, so this surfaces a value that is well-formed but unacceptable upstream.',
      recovery:
        'Read the upstream message in this error — it names what it rejected. Correct that input and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS Water Data API returned a server error or a response it could not read, and retrying did not clear it.',
      recovery:
        'A server error usually clears: retry after a short backoff. An error marked not retryable means the upstream sent a response this server cannot read, and the same request will fail again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The upstream requests, retries included, ran past the 45-second budget for this call.',
      recovery:
        'Retry after a short backoff; request a shorter date range if it repeatedly times out.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied canvas_id names a canvas that never existed or has expired. Raised before any upstream request, so no upstream call is spent on it.',
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
    // The call's one budget starts here, so canvas resolution counts against it too.
    const deadline = startDeadline();

    // Calendar validity: reject dates that pass the YYYY-MM-DD regex but aren't real calendar
    // dates — both NaN cases (month > 12, day > 31) and JS rollover cases (e.g. Feb 30 → Mar 1,
    // Feb 29 on a non-leap year → Mar 1). Round-trip through UTC to catch rollovers.
    for (const field of ['startDate', 'endDate'] as const) {
      if (!isCalendarDate(input[field])) {
        throw ctx.fail(
          'invalid_date_range',
          `Invalid ${field} "${input[field]}" — not a real calendar date. Use YYYY-MM-DD (e.g. month must be 01–12, day must be valid for the month).`,
        );
      }
    }
    // Both are valid YYYY-MM-DD, so string order is calendar order.
    if (input.startDate > input.endDate) {
      throw ctx.fail(
        'invalid_date_range',
        `startDate (${input.startDate}) must be before endDate (${input.endDate}).`,
      );
    }

    // Selection inputs are checked here rather than in the schema so a malformed value fails with a
    // reason and recovery hint of its own, and so a form client's "" reads as omitted.
    const requestedStatCd = optionalText(input.statCd);
    const statCd =
      input.seriesType === 'instantaneous' && requestedStatCd === CATALOG_INSTANTANEOUS_STAT_CD
        ? INSTANTANEOUS_STAT_CD
        : requestedStatCd;
    const methodId = optionalText(input.methodId);
    if (statCd && !/^\d{5}$/.test(statCd)) {
      throw ctx.fail('invalid_stat_cd', `statCd "${statCd}" is not a 5-digit USGS statistic code.`);
    }
    // Every instantaneous series carries statistic "00000", so a daily statCd could select nothing.
    if (statCd && input.seriesType === 'instantaneous' && statCd !== INSTANTANEOUS_STAT_CD) {
      throw ctx.fail(
        'stat_cd_for_instantaneous',
        `statCd "${statCd}" selects a daily statistic, but seriesType is "instantaneous" — instantaneous values carry only statistic "${INSTANTANEOUS_STAT_CD}".`,
      );
    }

    // A supplied canvas_id is resolved before the upstream call so a stale or never-minted id fails
    // without spending an upstream round trip. Minting stays lazy — a fresh canvas is acquired
    // further down, only once the series actually has to spill.
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

    const request: WaterDataRequest = {
      ctx,
      deadline,
      operation: 'water_get_series',
      signal: ctx.signal,
    };
    let seriesList: NwisTimeSeries[];
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
        request,
      );
    } catch (err: unknown) {
      if (ctx.signal?.aborted) throw err;
      const failure = classifyWaterDataFailure(err);
      if (failure) throw ctx.fail(failure.reason, failure.message, failure.data, { cause: err });
      throw err;
    }

    const ts = selectSeries(seriesList, { statCd, methodId });
    if (!ts && methodId && seriesList.length > 0) {
      const available = seriesList
        .filter((s) => !statCd || s.statCd === statCd)
        .map(describeSeries)
        .join('; ');
      const numericNote = NUMERIC_METHOD_ID.test(methodId)
        ? ' Numeric NWIS method IDs match no series: methodId takes a 32-character time-series ID, such as the ones this error lists.'
        : '';
      throw ctx.fail(
        'method_not_found',
        `No series with methodId "${methodId}"${statCd ? ` and statCd ${statCd}` : ''} was returned for site ${input.site} parameter ${input.parameterCd} (${input.seriesType}) over ${input.startDate} to ${input.endDate}.${numericNote}`,
        {
          recovery: {
            hint: `Re-request with one of these (pass its statCd and methodId), or omit methodId to get the method with the most records: ${available}.`,
          },
        },
      );
    }
    if (!ts) {
      // An unknown site and a range with no data both return no series, and both map here: the
      // range is the likelier fix, and the recovery points at the site's record bounds. A daily
      // statCd the site publishes no series for comes back the same way.
      const statNote = statCd
        ? ` The site may also publish no daily statistic ${statCd} — omit statCd to see which statistics it returns.`
        : '';
      throw ctx.fail(
        'no_data_for_range',
        `No data returned for site ${input.site} parameter ${input.parameterCd} — site may not exist, or no data in the requested date range (${input.startDate} to ${input.endDate}).${statNote}`,
      );
    }
    if (ts.values.length === 0) {
      throw ctx.fail(
        'no_data_for_range',
        `No data for site ${input.site} parameter ${input.parameterCd} in the requested date range.`,
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

      // Build rows suitable for canvas. A record the upstream reported as no data stages as NULL,
      // so SQL aggregates skip it instead of meeting an empty string.
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
      // among the series the service returned, so they are appended as a 7-hex digest of the
      // selected statCd + methodId (63 characters at worst, the identifier cap) whenever a choice
      // was made — the caller named one, or the response offered more than one series. A query
      // answered by a single series keeps the bare name, so re-running it still replaces its own
      // table.
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
        ctx.enrich.notice(
          `Staged all ${totalRecords} records to table "${spillResult.handle.tableName}" — use water_dataframe_describe to inspect its columns, then water_dataframe_query to analyze the full series with SQL (canvas_id "${instance.canvasId}"). Showing last ${values.length} of ${totalRecords} records inline.`,
        );
      } else if (nothingStagedNotice) {
        // Past the record threshold but under the character budget: spillover() registered nothing,
        // so a supplied canvas_id went unused here exactly as it does below the threshold.
        ctx.enrich.notice(nothingStagedNotice);
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
      ctx.enrich.notice(
        `Result truncated to the most recent ${SPILLOVER_THRESHOLD} of ${totalRecords} records — narrow the date range or enable DataCanvas for full access.${unusedCanvas}`,
      );
    } else if (nothingStagedNotice) {
      ctx.enrich.notice(nothingStagedNotice);
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

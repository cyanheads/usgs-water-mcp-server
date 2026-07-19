/**
 * @fileoverview Get current hydrologic conditions at a USGS site, ranked against the site's
 * historical percentile record for the same calendar day — a "how unusual is this reading" ranking,
 * not a flood-stage or drought determination.
 * @module mcp-server/tools/definitions/water-get-conditions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/nwis/input-schemas.js';
import { classifyNwisFailure, getReadings, getStats } from '@/services/nwis/nwis-service.js';
import type { PercentileClass } from '@/services/nwis/types.js';

/**
 * Classify a current value against a set of percentile thresholds.
 * Returns 'unknown' if required thresholds are missing.
 */
function classifyPercentile(
  value: number,
  p05: number | null,
  p10: number | null,
  p25: number | null,
  p75: number | null,
  p95: number | null,
): PercentileClass {
  if (p95 !== null && value >= p95) return 'record-high';
  if (p75 !== null && p95 !== null && value >= p75) return 'above-normal';
  if (p25 !== null && p75 !== null && value >= p25) return 'normal';
  if (p10 !== null && p25 !== null && value >= p10) return 'below-normal';
  if (p05 !== null && p10 !== null && value >= p05) return 'low';
  if (p05 !== null && value < p05) return 'record-low';
  return 'unknown';
}

/**
 * Plain-language threshold for each percentile class. The class names 'record-high' and
 * 'record-low' describe percentile-of-record extremes (≥ p95 / < p05), not verified all-time
 * records — the stat table carries the true observed extremes separately in max_va/min_va. The
 * enum value alone is what reaches structuredContent, so the disambiguation travels as its own
 * field rather than as schema description text a downstream reader never sees.
 */
const PERCENTILE_LABELS: Record<PercentileClass, string> = {
  'record-high': '≥ 95th percentile (percentile-of-record extreme, not a verified all-time record)',
  'above-normal': '75th–95th percentile',
  normal: '25th–75th percentile',
  'below-normal': '10th–25th percentile',
  low: '5th–10th percentile',
  'record-low': '< 5th percentile (percentile-of-record extreme, not a verified all-time record)',
  unknown: 'insufficient percentile data',
};

/**
 * Granularity disclosure surfaced on every populated historicalContext. The current value is an
 * instantaneous reading, but the stat percentiles are computed from approved daily-mean values —
 * NWIS publishes no instantaneous percentile product — so an instantaneous peak can rank higher
 * than the same day's daily mean would. Like percentileLabel, it travels as its own field because
 * the raw structuredContent value is read where schema description text is not.
 */
const COMPARISON_BASIS =
  "The current value is an instantaneous reading, but these percentiles are computed from approved daily-mean values for this calendar day, so an instantaneous peak can rank above the same day's daily mean. Treat percentileClass as an approximate ranking, not a like-for-like comparison.";

/**
 * Read the observation's own calendar month and day out of an NWIS timestamp.
 *
 * NWIS IV timestamps carry an explicit UTC offset (e.g. "2026-06-28T00:50:00.000-04:00"), so the
 * date prefix already is the observation's local calendar date. Routing it through `Date` would
 * re-project that instant into the runtime's timezone and select a neighboring stat row for
 * readings near midnight — in either direction, depending on the sign of the offset. The stat
 * table's month_nu/day_nu are plain calendar integers carrying no timezone of their own, so the
 * string prefix is what they have to be matched against.
 *
 * Returns null when the timestamp carries no parseable date prefix.
 */
function parseObservationDate(dateTime: string): { day: number; month: number } | null {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(dateTime);
  if (!match?.[1] || !match[2]) return null;
  return { month: Number.parseInt(match[1], 10), day: Number.parseInt(match[2], 10) };
}

export const waterGetConditions = tool('water_get_conditions', {
  description:
    'Get a USGS site\'s current reading ranked against its full period-of-record daily-mean percentiles for the same calendar day — a "how unusual is this" percentileClass (record-high to record-low), not a flood-stage or drought determination (this tool fetches no authoritative thresholds). The reading is instantaneous but the percentiles are daily-mean, so the ranking is approximate (see historicalContext.comparisonBasis). When the record is too short to rank, returns the reading with historicalContext=null instead of an error. Use water_find_sites and water_list_parameters to resolve inputs.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    site: SiteNumberSchema.describe(
      'USGS site number (8–15 digits, e.g. "01646500" for Potomac River at Little Falls). Use water_find_sites to discover valid site numbers.',
    ),
    parameterCd: ParameterCdSchema.describe(
      '5-digit USGS parameter code (e.g. "00060" for discharge, "00065" for gage height). Use water_list_parameters to discover codes.',
    ),
  }),
  output: z.object({
    siteNumber: z.string().describe('USGS site number (8–15 digits, e.g. "01646500").'),
    siteName: z.string().describe('Human-readable USGS site name.'),
    parameterCd: z
      .string()
      .describe('5-digit USGS parameter code that was queried (e.g. "00060").'),
    parameterName: z
      .string()
      .describe('Human-readable parameter name with units (e.g. "Streamflow, ft³/s").'),
    unitCode: z
      .string()
      .describe(
        'Unit of measure for currentValue and the historical percentiles (e.g. "ft3/s", "ft").',
      ),
    currentValue: z
      .string()
      .describe(
        'Most recent observed value as a string. Empty string when no data is available for the current period.',
      ),
    currentDateTime: z.string().describe('ISO 8601 date-time of the most recent observation.'),
    qualifiers: z
      .array(z.string().describe('A USGS data qualifier code (e.g. "P" = provisional).'))
      .describe('Data qualifier codes for the current reading.'),
    historicalContext: z
      .object({
        percentileClass: z
          .enum([
            'record-high',
            'above-normal',
            'normal',
            'below-normal',
            'low',
            'record-low',
            'unknown',
          ])
          .describe(
            'Classification relative to the full period-of-record: record-high (≥ p95), above-normal (p75–p95), normal (p25–p75), below-normal (p10–p25), low (p05–p10), record-low (< p05). See percentileLabel for the threshold in plain language.',
          ),
        percentileLabel: z
          .string()
          .describe(
            'Plain-language threshold for percentileClass (e.g. "25th–75th percentile"). The record-high and record-low classes mark percentile-of-record extremes (≥ p95 / < p05), not verified all-time records — this field says so where the class name does not.',
          ),
        p05: z
          .number()
          .nullable()
          .describe(
            '5th percentile value in unitCode for this calendar month+day, based on the period of record. Null if that threshold is unavailable.',
          ),
        p10: z
          .number()
          .nullable()
          .describe(
            '10th percentile value in unitCode for this calendar month+day. Null if unavailable.',
          ),
        p25: z
          .number()
          .nullable()
          .describe('25th percentile (lower quartile) in unitCode. Null if unavailable.'),
        p50: z
          .number()
          .nullable()
          .describe(
            'Median (50th percentile) in unitCode for this calendar month+day. Null if unavailable.',
          ),
        p75: z
          .number()
          .nullable()
          .describe('75th percentile (upper quartile) in unitCode. Null if unavailable.'),
        p95: z
          .number()
          .nullable()
          .describe(
            '95th percentile value in unitCode for this calendar month+day. Null if unavailable.',
          ),
        periodOfRecord: z
          .string()
          .describe('Range of years used to compute the percentile statistics (e.g. "1930–2025").'),
        comparisonBasis: z
          .string()
          .describe(
            'Fixed disclosure that percentileClass ranks an instantaneous reading against approved daily-mean percentiles — a cross-granularity approximation, not a flood-stage or drought determination. Present whenever historicalContext is non-null.',
          ),
      })
      .nullable()
      .describe(
        'Historical percentile context for the observation\'s calendar day. Non-null only when historicalContextStatus is "available"; see that field for why it is otherwise absent.',
      ),
    historicalContextStatus: z
      .enum(['available', 'no_matching_day', 'no_record', 'unavailable'])
      .describe(
        "Why historicalContext is or is not populated. 'available': percentiles for the observation's calendar day are present. 'no_matching_day': the stat table has rows but none for that calendar day. 'no_record': the stat table is empty — a new site, or a record too short to compute percentiles. 'unavailable': the statistics service call failed — a transient upstream error, not a statement about the site's record; retry shortly.",
      ),
    note: z
      .string()
      .optional()
      .describe(
        'Informational note explaining why historicalContext is null or incomplete. Absent when full historical context is available.',
      ),
  }),

  errors: [
    {
      reason: 'no_data_for_parameter',
      code: JsonRpcErrorCode.NotFound,
      when: 'NWIS returned no IV data — the site may not exist, or may not measure the requested parameter. NWIS returns the same empty response for both cases.',
      recovery:
        'Use water_find_sites with a parameterCd filter to verify the site exists and measures the parameter.',
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
      when: 'NWIS IV or stat endpoint returned a 5xx error or timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting conditions', { site: input.site, parameterCd: input.parameterCd });

    // Parallel fetch: current IV + stat table. The stat call is captured as a tagged outcome rather
    // than awaited-to-throw, so an operational stat failure stays distinguishable from a genuinely
    // empty stat table. Only the IV call can reject the Promise.all and surface through the catch.
    let ivResult: Awaited<ReturnType<typeof getReadings>>;
    let statOutcome:
      | { ok: true; result: Awaited<ReturnType<typeof getStats>> }
      | { ok: false; error: unknown };
    try {
      [ivResult, statOutcome] = await Promise.all([
        getReadings(
          { sites: [input.site], parameterCds: [input.parameterCd], period: 'PT2H' },
          ctx.signal,
        ),
        getStats(input.site, input.parameterCd, ctx.signal)
          .then((result) => ({ ok: true as const, result }))
          .catch((error: unknown) => ({ ok: false as const, error })),
      ]);
    } catch (err: unknown) {
      const failure = classifyNwisFailure(err);
      if (failure)
        throw ctx.fail(failure.reason, failure.message, ctx.recoveryFor(failure.reason), {
          cause: err,
        });
      throw err;
    }

    const ts = ivResult[0];
    if (!ts) {
      // NWIS returns an empty timeSeries array for both unknown sites and valid sites that have no
      // data for the requested parameter — the two cases are indistinguishable without a separate
      // site-existence check.
      throw ctx.fail(
        'no_data_for_parameter',
        `No data returned for site ${input.site} parameter ${input.parameterCd} — the site may not exist, or may not measure this parameter. Use water_find_sites with a parameterCd filter to verify parameter availability.`,
        ctx.recoveryFor('no_data_for_parameter'),
      );
    }

    // Most recent reading — an empty series carries no current value to report.
    const latest = ts.values[ts.values.length - 1];
    if (!latest) {
      throw ctx.fail(
        'no_data_for_parameter',
        `No current reading for site ${input.site} parameter ${input.parameterCd} in the last 2 hours — the site reports this parameter but returned no value in the current period. Use water_get_series for historical values.`,
        ctx.recoveryFor('no_data_for_parameter'),
      );
    }
    const currentValue = latest.value;
    const currentDateTime = latest.dateTime;
    const qualifiers = latest.qualifiers;

    // Historical context — populated only when the stat call succeeded AND carried a row for the
    // observation's calendar day. historicalContextStatus records which of those conditions failed,
    // so an operational stat failure never reads as a sparse-record site.
    let historicalContext: {
      percentileClass: PercentileClass;
      percentileLabel: string;
      p05: number | null;
      p10: number | null;
      p25: number | null;
      p50: number | null;
      p75: number | null;
      p95: number | null;
      periodOfRecord: string;
      comparisonBasis: string;
    } | null = null;
    let historicalContextStatus: 'available' | 'no_matching_day' | 'no_record' | 'unavailable';
    let note: string | undefined;

    if (!statOutcome.ok) {
      historicalContextStatus = 'unavailable';
      note =
        "Historical percentile context could not be retrieved — the statistics service call failed. This is a transient upstream error, not a statement about the site's record; retry shortly.";
      ctx.log.warning('Stat lookup failed; returning reading without historical context', {
        site: input.site,
        parameterCd: input.parameterCd,
        error:
          statOutcome.error instanceof Error
            ? statOutcome.error.message
            : String(statOutcome.error),
      });
    } else if (statOutcome.result.rows.length === 0) {
      historicalContextStatus = 'no_record';
      note =
        'No historical percentile data available for this site and parameter. NWIS may publish no daily-statistics percentile product for this parameter (common for gage height, 00065), or the record may be too new or too short to compute percentiles.';
    } else {
      // Match on the observation's own calendar day, not the runtime's — see parseObservationDate.
      const observed = parseObservationDate(currentDateTime);
      const statRow = observed
        ? statOutcome.result.rows.find(
            (r) => r.monthNu === observed.month && r.dayNu === observed.day,
          )
        : undefined;

      if (statRow) {
        const numValue = Number.parseFloat(currentValue);
        const percentileClass: PercentileClass = Number.isNaN(numValue)
          ? 'unknown'
          : classifyPercentile(
              numValue,
              statRow.p05,
              statRow.p10,
              statRow.p25,
              statRow.p75,
              statRow.p95,
            );

        historicalContext = {
          percentileClass,
          percentileLabel: PERCENTILE_LABELS[percentileClass],
          p05: statRow.p05,
          p10: statRow.p10,
          p25: statRow.p25,
          p50: statRow.p50,
          p75: statRow.p75,
          p95: statRow.p95,
          periodOfRecord: `${statRow.beginYr}–${statRow.endYr}`,
          comparisonBasis: COMPARISON_BASIS,
        };
        historicalContextStatus = 'available';
      } else {
        historicalContextStatus = 'no_matching_day';
        note = "Stat data is available but contains no entry for today's calendar day.";
      }
    }

    ctx.log.info('Conditions resolved', {
      site: ts.siteNumber,
      currentValue,
      historicalContextStatus,
      percentileClass: historicalContext?.percentileClass ?? 'no-stat',
    });

    return {
      siteNumber: ts.siteNumber,
      siteName: ts.siteName,
      parameterCd: ts.parameterCd,
      parameterName: ts.parameterName,
      unitCode: ts.unitCode,
      currentValue,
      currentDateTime,
      qualifiers,
      historicalContext,
      historicalContextStatus,
      note,
    };
  },

  format(result) {
    const qualifier = result.qualifiers.length > 0 ? ` [${result.qualifiers.join(',')}]` : '';
    const lines = [
      `### ${result.siteName} (${result.siteNumber})`,
      `**Parameter:** ${result.parameterName} (${result.parameterCd}) | **Unit:** ${result.unitCode}`,
      `**Current value:** ${result.currentValue} ${result.unitCode}${qualifier}`,
      `**Observed:** ${result.currentDateTime}`,
      '',
    ];

    if (result.historicalContext) {
      lines.push(
        `**Condition:** ${result.historicalContext.percentileClass} — ${result.historicalContext.percentileLabel} | **Period of record:** ${result.historicalContext.periodOfRecord}`,
        `**Percentiles for today's calendar day:**`,
        `  p05=${result.historicalContext.p05 ?? 'N/A'} | p10=${result.historicalContext.p10 ?? 'N/A'} | p25=${result.historicalContext.p25 ?? 'N/A'} | p50=${result.historicalContext.p50 ?? 'N/A'} | p75=${result.historicalContext.p75 ?? 'N/A'} | p95=${result.historicalContext.p95 ?? 'N/A'}`,
        `*${result.historicalContext.comparisonBasis}*`,
      );
    } else {
      lines.push('**Condition:** No historical context available.');
    }

    lines.push(`**Historical context status:** ${result.historicalContextStatus}`);

    if (result.note) {
      lines.push('', `*${result.note}*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

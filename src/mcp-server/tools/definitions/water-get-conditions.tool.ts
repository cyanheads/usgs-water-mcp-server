/**
 * @fileoverview Get current hydrologic conditions at a USGS site, ranked against historical
 * percentile records. Answers "is this flooding or drought?" rather than just a raw number.
 * @module mcp-server/tools/definitions/water-get-conditions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getReadings, getStats } from '@/services/nwis/nwis-service.js';
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

export const waterGetConditions = tool('water_get_conditions', {
  description:
    'Get current hydrologic conditions at a USGS site, placed in historical context. ' +
    "Returns today's current reading alongside a percentile classification (record-high, above-normal, " +
    'normal, below-normal, low, record-low) derived from the full period-of-record daily statistics. ' +
    'Answers "is this flooding or drought?" — not just a raw number. ' +
    'Use water_find_sites to discover site numbers; use water_list_parameters to find parameter codes. ' +
    'When the site has insufficient record history, returns the current reading with ' +
    'historicalContext=null rather than an error.',
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
          'Use water_list_parameters to discover codes.',
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
            'Classification relative to the full period-of-record: ' +
              'record-high (≥ p95), above-normal (p75–p95), normal (p25–p75), ' +
              'below-normal (p10–p25), low (p05–p10), record-low (< p05).',
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
      })
      .nullable()
      .describe(
        'Historical percentile context. Null when the stat service has no data for this site.',
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
      reason: 'site_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The site number returned no IV data.',
      recovery: 'Verify the site number using water_find_sites.',
    },
    {
      reason: 'no_data_for_parameter',
      code: JsonRpcErrorCode.NotFound,
      when: 'The site has no current reading for the requested parameter code.',
      recovery: 'Check parameter availability via water_find_sites with parameterCd filter.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.InternalError,
      when: 'NWIS IV or stat endpoint returned a 5xx error or timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting conditions', { site: input.site, parameterCd: input.parameterCd });

    // Parallel fetch: current IV + stat table
    let ivResult: Awaited<ReturnType<typeof getReadings>>;
    let statResult: Awaited<ReturnType<typeof getStats>> | null;
    try {
      [ivResult, statResult] = await Promise.all([
        getReadings(
          { sites: [input.site], parameterCds: [input.parameterCd], period: 'PT2H' },
          ctx.signal,
        ),
        getStats(input.site, input.parameterCd, ctx.signal).catch(() => null), // stat failure is non-fatal
      ]);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('unavailable') ||
        msg.includes('ServiceUnavailable') ||
        msg.includes('timed out')
      ) {
        throw ctx.fail('upstream_error', msg);
      }
      throw err;
    }

    if (ivResult.length === 0) {
      throw ctx.fail('site_not_found', `No IV data returned for site ${input.site}.`);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const ts = ivResult[0]!;
    if (ts.values.length === 0) {
      throw ctx.fail(
        'no_data_for_parameter',
        `No current reading for site ${input.site} parameter ${input.parameterCd}.`,
      );
    }

    // Most recent reading — ts.values.length > 0 asserted above
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const latest = ts.values[ts.values.length - 1]!;
    const currentValue = latest.value;
    const currentDateTime = latest.dateTime;
    const qualifiers = latest.qualifiers;

    // Historical context — stat may be null if unavailable
    let historicalContext: {
      percentileClass: PercentileClass;
      p05: number | null;
      p10: number | null;
      p25: number | null;
      p50: number | null;
      p75: number | null;
      p95: number | null;
      periodOfRecord: string;
    } | null = null;
    let note: string | undefined;

    if (statResult && statResult.rows.length > 0) {
      const now = new Date(currentDateTime);
      const month = now.getMonth() + 1;
      const day = now.getDate();

      // Find the stat row for today's month+day
      const statRow = statResult.rows.find((r) => r.monthNu === month && r.dayNu === day);

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
          p05: statRow.p05,
          p10: statRow.p10,
          p25: statRow.p25,
          p50: statRow.p50,
          p75: statRow.p75,
          p95: statRow.p95,
          periodOfRecord: `${statRow.beginYr}–${statRow.endYr}`,
        };
      } else {
        note = "Stat data is available but contains no entry for today's calendar day.";
      }
    } else {
      note =
        'No historical percentile data available for this site and parameter. ' +
        'The site may be new, or the parameter record may be too short to compute percentiles.';
    }

    ctx.log.info('Conditions resolved', {
      site: ts.siteNumber,
      currentValue,
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
        `**Condition:** ${result.historicalContext.percentileClass} (period of record: ${result.historicalContext.periodOfRecord})`,
        `**Percentiles for today's calendar day:**`,
        `  p05=${result.historicalContext.p05 ?? 'N/A'} | p10=${result.historicalContext.p10 ?? 'N/A'} | p25=${result.historicalContext.p25 ?? 'N/A'} | p50=${result.historicalContext.p50 ?? 'N/A'} | p75=${result.historicalContext.p75 ?? 'N/A'} | p95=${result.historicalContext.p95 ?? 'N/A'}`,
      );
    } else {
      lines.push('**Condition:** No historical context available.');
    }

    if (result.note) {
      lines.push('', `*${result.note}*`);
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

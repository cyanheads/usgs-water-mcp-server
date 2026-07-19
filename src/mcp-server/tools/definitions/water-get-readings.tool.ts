/**
 * @fileoverview Get the latest instantaneous values (real-time, ~15 min updates) for one or more
 * USGS monitoring sites. Supports up to 100 sites per call.
 * @module mcp-server/tools/definitions/water-get-readings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ParameterCdSchema,
  PeriodSchema,
  SiteNumberSchema,
} from '@/services/nwis/input-schemas.js';
import { classifyNwisFailure, getReadings } from '@/services/nwis/nwis-service.js';

/**
 * Maximum value records returned per site+parameter series. This tool answers "what is happening
 * now" — a wide period multiplied by up to 100 sites otherwise returns a full time series through
 * structuredContent. water_get_series is the tool for a complete series.
 */
const VALUES_PER_SERIES_CAP = 10;

/** A single value record in the readings output. */
const ValueRecordSchema = z.object({
  dateTime: z.string().describe('ISO 8601 date-time of this observation.'),
  value: z
    .string()
    .describe('Measured value as a string (empty string means no data for that interval).'),
  qualifiers: z
    .array(
      z.string().describe('A USGS data qualifier code (e.g. "P" = provisional, "A" = approved).'),
    )
    .describe('Data qualifier codes for this value.'),
});

/** One time-series result per site+parameter combination. */
const ReadingResultSchema = z.object({
  siteNumber: z.string().describe('USGS site number (8–15 digits, e.g. "01646500").'),
  siteName: z
    .string()
    .describe('Human-readable USGS site name (e.g. "POTOMAC RIVER AT LITTLE FALLS, MD").'),
  parameterCd: z.string().describe('5-digit parameter code (e.g. "00060" for discharge).'),
  parameterName: z
    .string()
    .describe('Human-readable parameter name with units (e.g. "Streamflow, ft³/s").'),
  unitCode: z
    .string()
    .describe('Unit of measure for the values in this series (e.g. "ft3/s", "ft", "°C").'),
  values: z
    .array(
      ValueRecordSchema.describe('A single instantaneous reading for this site and parameter.'),
    )
    .describe(
      `Time-ordered value records for this site and parameter, capped at the most recent ${VALUES_PER_SERIES_CAP}. Compare with totalValues to see whether the period held more; use water_get_series for the full series.`,
    ),
  totalValues: z
    .number()
    .int()
    .describe(
      `Number of value records NWIS returned for this site and parameter over the requested period, before the ${VALUES_PER_SERIES_CAP}-record cap. Equals values.length when nothing was capped.`,
    ),
});

export const waterGetReadings = tool('water_get_readings', {
  description: `Get the latest instantaneous (~15-min, real-time) values for up to 100 USGS sites in one call — per-site, per-parameter records with timestamp, value, unit, and provisional/approved qualifiers. Each series returns only its ${VALUES_PER_SERIES_CAP} most recent records (totalValues reports the true count; truncated=true if any were capped); use water_get_series for a full date-range series. Sites NWIS returns nothing for are listed in missingSites, not dropped silently. Use water_find_sites first to discover site numbers and available parameters.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    sites: z
      .array(SiteNumberSchema.describe('A USGS site number (8–15 digits, e.g. "01646500").'))
      .min(1)
      .max(100)
      .describe('One or more USGS site numbers to query. Maximum 100 per call.'),
    parameterCd: z
      .array(
        ParameterCdSchema.describe('A 5-digit USGS parameter code (e.g. "00060" for discharge).'),
      )
      .optional()
      .describe(
        'Parameter codes to return. Omit to get all parameters available at each site. Use water_list_parameters to discover codes.',
      ),
    period: PeriodSchema.default('PT2H').describe(
      `ISO 8601 duration for the lookback period (e.g. "PT2H" = last 2 hours, "P1D" = last 1 day, "P7D" = last 7 days). Default: "PT2H" (last 2 hours of readings). Widening it raises totalValues, but each series still returns only its ${VALUES_PER_SERIES_CAP} most recent records — use water_get_series to retrieve a full series.`,
    ),
  }),
  output: z.object({
    readings: z
      .array(ReadingResultSchema.describe('Time series result for one site+parameter combination.'))
      .describe('Time series per site+parameter combination.'),
    total: z.number().int().describe('Total number of site+parameter time series returned.'),
    truncated: z
      .boolean()
      .describe(
        `True when at least one series held more than ${VALUES_PER_SERIES_CAP} records and was capped. Per-series counts are in readings[].totalValues; use water_get_series for the full series.`,
      ),
    missingSites: z
      .array(z.string().describe('A requested USGS site number that returned no time series.'))
      .describe(
        'Requested site numbers NWIS returned no series for — the site may not exist, or may not measure the requested parameter(s) in the requested period. Empty when every requested site returned data. Verify these with water_find_sites.',
      ),
  }),

  enrichment: {
    query: z
      .object({
        sites: z.array(z.string()).describe('Site numbers queried.'),
        parameterCd: z
          .array(z.string())
          .optional()
          .describe('Parameter codes requested, if filtered.'),
        period: z.string().describe('Lookback period applied (ISO 8601 duration).'),
      })
      .describe('Query parameters used for this request.'),
  },

  enrichmentTrailer: {
    query: {
      render(v) {
        const parts: string[] = [`sites=[${v.sites.join(', ')}]`, `period=${v.period}`];
        if (v.parameterCd?.length) parts.push(`parameterCd=[${v.parameterCd.join(', ')}]`);
        return `**Query:** ${parts.join(', ')}`;
      },
    },
  },

  errors: [
    {
      reason: 'no_data_for_parameter',
      code: JsonRpcErrorCode.NotFound,
      when: 'NWIS returned no time series — the site(s) may not exist, or may not have data for the requested parameter(s) in the requested period. NWIS returns the same empty response for both cases.',
      recovery:
        'Use water_find_sites with a parameterCd filter to verify the site exists and measures the parameter. Try a longer period if the site is valid.',
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
    ctx.log.info('Getting IV readings', {
      siteCount: input.sites.length,
      parameterCount: input.parameterCd?.length ?? 0,
      period: input.period,
    });

    let series: Awaited<ReturnType<typeof getReadings>>;
    try {
      const readingsParams: Parameters<typeof getReadings>[0] = {
        sites: input.sites,
        period: input.period,
      };
      if (input.parameterCd?.length) readingsParams.parameterCds = input.parameterCd;
      series = await getReadings(readingsParams, ctx.signal);
    } catch (err: unknown) {
      const failure = classifyNwisFailure(err);
      if (failure)
        throw ctx.fail(failure.reason, failure.message, ctx.recoveryFor(failure.reason), {
          cause: err,
        });
      throw err;
    }

    if (series.length === 0) {
      // NWIS returns an empty timeSeries array for both unknown site IDs and valid sites that have
      // no data for the requested parameter — the two cases are indistinguishable from this call.
      throw ctx.fail(
        'no_data_for_parameter',
        'No data returned for the given sites and parameters — the site(s) may not exist, or may not measure the requested parameter(s) in the requested period. Use water_find_sites with a parameterCd filter to verify parameter availability at a site.',
        ctx.recoveryFor('no_data_for_parameter'),
      );
    }

    // Check for series with no values (data gap for parameter)
    const withData = series.filter((s) => s.values.length > 0);
    if (withData.length === 0 && series.length > 0) {
      throw ctx.fail(
        'no_data_for_parameter',
        'Sites found but no data available for the specified parameters in the requested period.',
        ctx.recoveryFor('no_data_for_parameter'),
      );
    }

    const readings = series.map((s) => ({
      siteNumber: s.siteNumber,
      siteName: s.siteName,
      parameterCd: s.parameterCd,
      parameterName: s.parameterName,
      unitCode: s.unitCode,
      values: s.values.slice(-VALUES_PER_SERIES_CAP),
      totalValues: s.values.length,
    }));
    const truncated = readings.some((r) => r.values.length < r.totalValues);

    // NWIS drops unknown or non-matching sites from a batch response without comment — diff the
    // request against what came back so a partial batch is visible rather than inferred.
    const returnedSites = new Set(series.map((s) => s.siteNumber));
    const missingSites = input.sites.filter((s) => !returnedSites.has(s));

    ctx.enrich({
      query: {
        sites: input.sites,
        parameterCd: input.parameterCd,
        period: input.period,
      },
    });

    ctx.log.info('Readings fetched', {
      seriesCount: readings.length,
      truncated,
      missingSiteCount: missingSites.length,
    });
    return { readings, total: readings.length, truncated, missingSites };
  },

  format(result) {
    const lines = [
      result.truncated
        ? `**${result.total} time series** *(truncated — each series shows its latest ${VALUES_PER_SERIES_CAP} records; use water_get_series for full history)*\n`
        : `**${result.total} time series**\n`,
    ];

    if (result.missingSites.length > 0) {
      lines.push(
        `**No data returned for:** ${result.missingSites.join(', ')} — verify with water_find_sites.\n`,
      );
    }

    for (const r of result.readings) {
      lines.push(
        `### ${r.siteName} (${r.siteNumber}) — ${r.parameterName} | code: ${r.parameterCd} | unit: ${r.unitCode}`,
      );
      for (const v of r.values) {
        const qualifier = v.qualifiers.length > 0 ? ` [${v.qualifiers.join(',')}]` : '';
        lines.push(`- ${v.dateTime}: **${v.value}** ${r.unitCode}${qualifier}`);
      }
      lines.push(
        r.values.length < r.totalValues
          ? `  *(showing the latest ${r.values.length} of ${r.totalValues} records in this period)*`
          : `  *(${r.totalValues} records in this period)*`,
        '',
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

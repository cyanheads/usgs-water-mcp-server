/**
 * @fileoverview Get the latest instantaneous values (real-time, ~15 min updates) for one or more
 * USGS monitoring sites. Supports up to 100 sites per call.
 * @module mcp-server/tools/definitions/water-get-readings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getReadings } from '@/services/nwis/nwis-service.js';

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
    .describe('Time-ordered value records for this site and parameter.'),
});

export const waterGetReadings = tool('water_get_readings', {
  description:
    'Get the latest instantaneous values (~15 min real-time updates) for one or more USGS monitoring ' +
    'sites. Returns per-site, per-parameter records including timestamp, value, unit, and ' +
    'provisional/approved qualifiers. Accepts up to 100 site numbers in one call. ' +
    'Use water_find_sites first to discover valid site numbers and available parameter codes. ' +
    'Groundwater depth is available via parameterCd=72019 (Depth to water level, ft below land surface). ' +
    'For a date-range time series, use water_get_series instead.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    sites: z
      .array(z.string().describe('A USGS site number (8–15 digits, e.g. "01646500").'))
      .min(1)
      .max(100)
      .describe('One or more USGS site numbers to query. Maximum 100 per call.'),
    parameterCd: z
      .array(z.string().describe('A 5-digit USGS parameter code (e.g. "00060" for discharge).'))
      .optional()
      .describe(
        'Parameter codes to return. Omit to get all parameters available at each site. ' +
          'Use water_list_parameters to discover codes.',
      ),
    period: z
      .string()
      .default('PT2H')
      .describe(
        'ISO 8601 duration for the lookback period (e.g. "PT2H" = last 2 hours, "P1D" = last 1 day, ' +
          '"P7D" = last 7 days). Default: "PT2H" (last 2 hours of readings).',
      ),
  }),
  output: z.object({
    readings: z
      .array(ReadingResultSchema.describe('Time series result for one site+parameter combination.'))
      .describe('Time series per site+parameter combination.'),
    total: z.number().int().describe('Total number of site+parameter time series returned.'),
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
      reason: 'invalid_site_format',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NWIS rejected the request — site number format is invalid (not 8–15 digits).',
      recovery: 'Correct the site number format. Site numbers are 8–15 digit strings.',
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
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('rejected') ||
        msg.includes('InvalidParams') ||
        msg.includes('ValidationError')
      ) {
        throw ctx.fail('invalid_site_format', msg);
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

    if (series.length === 0) {
      // NWIS returns an empty timeSeries array for both unknown site IDs and valid sites that have
      // no data for the requested parameter — the two cases are indistinguishable from this call.
      throw ctx.fail(
        'no_data_for_parameter',
        'No data returned for the given sites and parameters — the site(s) may not exist, ' +
          'or may not measure the requested parameter(s) in the requested period. ' +
          'Use water_find_sites with a parameterCd filter to verify parameter availability at a site.',
      );
    }

    // Check for series with no values (data gap for parameter)
    const withData = series.filter((s) => s.values.length > 0);
    if (withData.length === 0 && series.length > 0) {
      throw ctx.fail(
        'no_data_for_parameter',
        'Sites found but no data available for the specified parameters in the requested period.',
      );
    }

    const readings = series.map((s) => ({
      siteNumber: s.siteNumber,
      siteName: s.siteName,
      parameterCd: s.parameterCd,
      parameterName: s.parameterName,
      unitCode: s.unitCode,
      values: s.values,
    }));

    ctx.enrich({
      query: {
        sites: input.sites,
        parameterCd: input.parameterCd,
        period: input.period,
      },
    });

    ctx.log.info('Readings fetched', { seriesCount: readings.length });
    return { readings, total: readings.length };
  },

  format(result) {
    const lines = [`**${result.total} time series**\n`];
    for (const r of result.readings) {
      lines.push(
        `### ${r.siteName} (${r.siteNumber}) — ${r.parameterName} | code: ${r.parameterCd} | unit: ${r.unitCode}`,
      );
      const recent = r.values.slice(-5);
      for (const v of recent) {
        const qualifier = v.qualifiers.length > 0 ? ` [${v.qualifiers.join(',')}]` : '';
        lines.push(`- ${v.dateTime}: **${v.value}** ${r.unitCode}${qualifier}`);
      }
      if (r.values.length > 5) {
        lines.push(`  *(showing 5 of ${r.values.length} records)*`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

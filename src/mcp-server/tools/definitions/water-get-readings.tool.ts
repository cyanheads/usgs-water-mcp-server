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
import { carriesValues, classifyNwisFailure, getReadings } from '@/services/nwis/nwis-service.js';
import type { NwisTimeSeries } from '@/services/nwis/types.js';

/**
 * Maximum value records returned per site + parameter + method series. This tool answers "what is happening
 * now" — a wide period multiplied by up to 100 sites otherwise returns a full time series through
 * structuredContent. water_get_series is the tool for a complete series.
 */
const VALUES_PER_SERIES_CAP = 10;

/**
 * Maximum series returned per call. parameterCd is optional, so a full 100-site batch otherwise
 * returns one series per site per published parameter per method — several hundred at
 * instrumented sites. Equal to the site maximum, so every site that returned data keeps a series.
 */
const MAX_SERIES = 100;

/**
 * Keep at most {@link MAX_SERIES} series, round-robin across sites: every site's first series, then
 * every site's second, and so on, with a site's valued series ahead of its empty ones — a series
 * whose every record is no data ranks as empty. The kept series stay in NWIS response order (site,
 * then parameter code, then method).
 */
function capSeries(series: NwisTimeSeries[]): NwisTimeSeries[] {
  if (series.length <= MAX_SERIES) return series;
  const perSite = [...Map.groupBy(series.keys(), (i) => series[i]?.siteNumber).values()].map(
    (indices) => [
      ...indices.filter((i) => carriesValues(series[i])),
      ...indices.filter((i) => !carriesValues(series[i])),
    ],
  );
  const kept = new Set<number>();
  for (let round = 0; kept.size < MAX_SERIES; round++) {
    for (const indices of perSite) {
      const index = indices[round];
      if (index !== undefined) kept.add(index);
      if (kept.size === MAX_SERIES) break;
    }
  }
  return series.filter((_, i) => kept.has(i));
}

/** A single value record in the readings output. */
const ValueRecordSchema = z.object({
  dateTime: z.string().describe('ISO 8601 date-time of this observation.'),
  value: z
    .string()
    .describe(
      'Measured value as a string. Empty string when NWIS reported no value for that interval — qualifiers then give the reason (e.g. "Ssn" seasonal, "Dis" discontinued, "Dry", "Eqp" equipment malfunction).',
    ),
  qualifiers: z
    .array(
      z.string().describe('A USGS data qualifier code (e.g. "P" = provisional, "A" = approved).'),
    )
    .describe('Data qualifier codes for this value.'),
});

/** One time-series result per site + parameter + method combination. */
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
  methodId: z
    .string()
    .nullable()
    .describe(
      'NWIS method ID of this series. A site can measure one parameter with several sensors or at several locations — each is its own method and its own entry in readings. Null only when NWIS returned the series with no method block.',
    ),
  methodDescription: z
    .string()
    .nullable()
    .describe(
      'NWIS description of the method, e.g. "From multiparameter sonde", "[(2)]", or "7.1 ft from riverbed (top), [Discontinued]". Null when NWIS leaves it blank, as it does for the default series at most single-sensor sites.',
    ),
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
  description: `Get the latest instantaneous (~15-min, real-time) values for up to 100 USGS sites in one call — per-site, per-parameter records with timestamp, value, unit, and provisional/approved qualifiers. Omitting parameterCd returns every parameter each site publishes. A site measuring one parameter with several sensors returns one series per method, each named by methodId and methodDescription. At most ${MAX_SERIES} series return per call — every site that returned data keeps at least one, and totalSeries reports how many NWIS returned; pass parameterCd or split the sites across calls to reach the rest. Each series returns only its ${VALUES_PER_SERIES_CAP} most recent records (totalValues reports the true count); truncated=true when either cap applied. Use water_get_series for a full date-range series. Sites NWIS returns nothing for are listed in missingSites, not dropped silently. Use water_find_sites first to discover site numbers and available parameters.`,
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
        `Parameter codes to return. Omit to get every parameter each site publishes — one series per site, parameter, and method, so a large batch can exceed the ${MAX_SERIES}-series cap. Use water_list_parameters to discover codes.`,
      ),
    period: PeriodSchema.default('PT2H').describe(
      `ISO 8601 duration for the lookback period (e.g. "PT2H" = last 2 hours, "P1D" = last 1 day, "P7D" = last 7 days). Default: "PT2H" (last 2 hours of readings). Widening it raises totalValues, but each series still returns only its ${VALUES_PER_SERIES_CAP} most recent records — use water_get_series to retrieve a full series.`,
    ),
  }),
  output: z.object({
    readings: z
      .array(
        ReadingResultSchema.describe(
          'Time series result for one site + parameter + method combination.',
        ),
      )
      .describe(
        `Time series per site + parameter + method combination, in NWIS order (site, then parameter code, then method). A method block NWIS returned empty is omitted when another method of the same site and parameter carries values. At most ${MAX_SERIES}: past that, series are kept round-robin across sites — every site's first series, then every site's second — with a site's series carrying values ahead of its empty ones, a series whose every record is no data counting as empty.`,
      ),
    total: z
      .number()
      .int()
      .describe(
        `Number of site + parameter + method time series returned in readings (at most ${MAX_SERIES}).`,
      ),
    totalSeries: z
      .number()
      .int()
      .describe(
        `Number of site + parameter + method time series before the ${MAX_SERIES}-series cap — an empty method block omitted as described under readings is not counted. Greater than total exactly when the cap dropped series; narrow with parameterCd or split the sites across calls to get the rest.`,
      ),
    truncated: z
      .boolean()
      .describe(
        `True when either cap applied. The series cap: totalSeries > total — pass parameterCd or split the sites across calls. The ${VALUES_PER_SERIES_CAP}-record cap: some readings[].totalValues > values.length — use water_get_series for the full series.`,
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
      series = await getReadings(readingsParams, ctx);
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

    const readings = capSeries(series).map((s) => ({
      siteNumber: s.siteNumber,
      siteName: s.siteName,
      parameterCd: s.parameterCd,
      parameterName: s.parameterName,
      unitCode: s.unitCode,
      methodId: s.methodId,
      methodDescription: s.methodDescription,
      values: s.values.slice(-VALUES_PER_SERIES_CAP),
      totalValues: s.values.length,
    }));
    const truncated =
      readings.length < series.length || readings.some((r) => r.values.length < r.totalValues);

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
      totalSeries: series.length,
      truncated,
      missingSiteCount: missingSites.length,
    });
    return {
      readings,
      total: readings.length,
      totalSeries: series.length,
      truncated,
      missingSites,
    };
  },

  format(result) {
    const seriesCapped = result.totalSeries > result.total;
    const recordsCapped = result.readings.some((r) => r.values.length < r.totalValues);
    const count = seriesCapped
      ? `**${result.total} of ${result.totalSeries} time series**`
      : `**${result.total} time series**`;
    const seriesAdvice =
      'pass parameterCd to choose which parameters return, or split the sites across calls';
    const recordAdvice = 'use water_get_series for full history';
    const recordCap = `each series shows its latest ${VALUES_PER_SERIES_CAP} records`;
    const caption =
      seriesCapped && recordsCapped
        ? ` *(truncated — capped at ${MAX_SERIES} series, and ${recordCap}; ${seriesAdvice}; ${recordAdvice})*`
        : seriesCapped
          ? ` *(truncated — capped at ${MAX_SERIES} series; ${seriesAdvice})*`
          : result.truncated
            ? ` *(truncated — ${recordCap}; ${recordAdvice})*`
            : '';
    const lines = [`${count}${caption}\n`];

    if (result.missingSites.length > 0) {
      lines.push(
        `**No data returned for:** ${result.missingSites.join(', ')} — verify with water_find_sites.\n`,
      );
    }

    for (const r of result.readings) {
      lines.push(
        `### ${r.siteName} (${r.siteNumber}) — ${r.parameterName} | code: ${r.parameterCd} | unit: ${r.unitCode}`,
        `Method: ${r.methodDescription ?? '(no description)'} | method ID: ${r.methodId ?? 'none'}`,
      );
      for (const v of r.values) {
        const qualifier = v.qualifiers.length > 0 ? ` [${v.qualifiers.join(',')}]` : '';
        lines.push(
          v.value === ''
            ? `- ${v.dateTime}: no data${qualifier}`
            : `- ${v.dateTime}: **${v.value}** ${r.unitCode}${qualifier}`,
        );
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

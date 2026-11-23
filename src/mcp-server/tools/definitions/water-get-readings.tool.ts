/**
 * @fileoverview Get the latest instantaneous values (real-time, ~15 min updates) for one or more
 * USGS monitoring sites. Accepts up to 500 site numbers, reads the first 100 distinct, and returns
 * the rest as deferred sites.
 * @module mcp-server/tools/definitions/water-get-readings.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  ParameterCdSchema,
  PeriodSchema,
  SiteNumberSchema,
} from '@/services/waterdata/input-schemas.js';
import { carriesValues, getReadings } from '@/services/waterdata/observations.js';
import {
  formatDeferredSites,
  SITE_BATCH_SIZE,
  SITE_LIST_MAX,
  splitSiteBatch,
} from '@/services/waterdata/site-batch.js';
import type { NwisTimeSeries } from '@/services/waterdata/types.js';
import { startRequest } from '@/services/waterdata/water-data-client.js';
import { classifyWaterDataFailure } from '@/services/waterdata/water-data-errors.js';

/**
 * Maximum value records returned per site + parameter + method series. This tool answers "what is happening
 * now" — a wide period multiplied by up to 100 sites otherwise returns a full time series through
 * structuredContent. water_get_series is the tool for a complete series.
 */
const VALUES_PER_SERIES_CAP = 10;

/**
 * Maximum series returned per call. parameterCd is optional, so a full 100-site batch otherwise
 * returns one series per site per published parameter per method — several hundred at
 * instrumented sites. Equal to the sites one call reads, so every site that returned data keeps a
 * series.
 */
const MAX_SERIES = SITE_BATCH_SIZE;

/**
 * Keep at most {@link MAX_SERIES} series, round-robin across sites: every site's first series, then
 * every site's second, and so on, with a site's valued series ahead of its empty ones — a series
 * whose every record is no data ranks as empty. The kept series stay in the order the service
 * returned them.
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
      'Measured value as a string. Empty string when the upstream reported no value for that interval — qualifiers then give the reason (e.g. "Ssn" seasonal, "Dis" discontinued, "Dry", "Eqp" equipment malfunction).',
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

/** One time-series result per site + parameter + method combination. */
const ReadingResultSchema = z.object({
  siteNumber: z.string().describe('USGS site number (8–15 digits, e.g. "01646500").'),
  siteName: z
    .string()
    .describe('Human-readable USGS site name (e.g. "POTOMAC RIVER AT LITTLE FALLS, MD").'),
  parameterCd: z.string().describe('5-digit parameter code (e.g. "00060" for discharge).'),
  parameterName: z
    .string()
    .describe(
      'Parameter description from the USGS parameter-code catalog, units included (e.g. "Discharge, cubic feet per second").',
    ),
  unitCode: z
    .string()
    .describe('Unit of measure for the values in this series (e.g. "ft3/s", "ft", "deg C").'),
  methodId: z
    .string()
    .nullable()
    .describe(
      'Time-series ID of this sensor series — the OGC time_series_id, the same value water_get_site_data_catalog lists as timeSeriesId. A site can measure one parameter with several sensors or at several locations — each is its own series and its own entry in readings. Null only when the upstream sent the series without an ID.',
    ),
  methodDescription: z
    .string()
    .nullable()
    .describe(
      'Description of the sensor, built from the series metadata as "<sublocation>, [<web description>]" (e.g. "From multiparameter sonde, [Discontinued]"), or either part alone when the other is blank (e.g. "From multiparameter sonde", "[Radar]"). Null when the metadata leaves both blank, as it does for the default series at most single-sensor sites.',
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
      `Number of value records the upstream returned for this sensor over the requested period, before the ${VALUES_PER_SERIES_CAP}-record cap. Equals values.length when nothing was capped. 0 when the sensor reported nothing in the period — the endDate water_get_site_data_catalog lists for its timeSeriesId gives its last report.`,
    ),
});

export const waterGetReadings = tool('water_get_readings', {
  description: `Get the latest instantaneous (~15-min, real-time) values for USGS sites — per-site, per-parameter records with timestamp, value, unit, and provisional/approved qualifiers. Takes up to ${SITE_LIST_MAX} site numbers, a full water_find_sites page, and reads the first ${SITE_BATCH_SIZE} distinct ones; the rest return in deferredSites, in input order, to pass as sites in another call. Omitting parameterCd returns every parameter each site publishes. A site measuring one parameter with several sensors returns one series per sensor, each named by methodId (its time-series ID) and methodDescription; a sensor that reported nothing in the period still returns, with totalValues 0. At most ${MAX_SERIES} series return per call — every site that returned a series keeps at least one, and totalSeries reports how many the upstream returned; pass parameterCd or split the sites across calls to reach the rest. Each series returns only its ${VALUES_PER_SERIES_CAP} most recent records (totalValues reports the true count); truncated=true when either cap applied. Use water_get_series for a full date-range series. Sites read that return no series are listed in missingSites, not dropped silently. Find site numbers with water_find_sites; water_get_site_data_catalog lists the parameters and sensors a site measures and when each last reported.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    sites: z
      .array(SiteNumberSchema.describe('A USGS site number (8–15 digits, e.g. "01646500").'))
      .min(1)
      .max(SITE_LIST_MAX)
      .describe(
        `One or more USGS site numbers, at most ${SITE_LIST_MAX}. The first ${SITE_BATCH_SIZE} distinct numbers are read, in input order; the rest return in deferredSites to pass as sites in another call. A repeated number is read once.`,
      ),
    parameterCd: z
      .array(
        ParameterCdSchema.describe('A 5-digit USGS parameter code (e.g. "00060" for discharge).'),
      )
      .optional()
      .describe(
        `Parameter codes to return. Omit to get every parameter each site publishes — one series per site, parameter, and method, so a large batch can exceed the ${MAX_SERIES}-series cap. Use water_list_parameters to discover codes.`,
      ),
    period: PeriodSchema.default('PT2H').describe(
      `ISO 8601 duration for the lookback period (e.g. "PT2H" = last 2 hours, "P1D" = last 1 day, "P7D" = last 7 days). Default: "PT2H" (last 2 hours of readings). Widening it raises totalValues, but each series still returns only its ${VALUES_PER_SERIES_CAP} most recent records — use water_get_series to retrieve a full series. At most 1,100 days (e.g. "P3Y"); a longer period is refused upstream.`,
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
        `Time series per site + parameter + method combination, ordered by site number, parameter code, then the sensor's first observation. At most ${MAX_SERIES}: past that, series are kept round-robin across sites — every site's first series, then every site's second — with a site's series carrying values ahead of its empty ones, a series whose every record is no data counting as empty.`,
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
        `Number of site + parameter + method time series before the ${MAX_SERIES}-series cap. Greater than total exactly when the cap dropped series; narrow with parameterCd or split the sites across calls to get the rest.`,
      ),
    truncated: z
      .boolean()
      .describe(
        `True when either cap applied. The series cap: totalSeries > total — pass parameterCd or split the sites across calls. The ${VALUES_PER_SERIES_CAP}-record cap: some readings[].totalValues > values.length — use water_get_series for the full series. Sites not read do not set it; they return in deferredSites.`,
      ),
    missingSites: z
      .array(z.string().describe('A USGS site number read in this call that returned no series.'))
      .describe(
        'Site numbers read in this call that returned no series, each listed once — the site does not exist, or has no instantaneous series of the requested parameter(s). A site whose sensor reported nothing in the period is not listed here: it returns a series with totalValues 0. A site not read is not listed here either: it returns in deferredSites. Empty when every site read returned a series. Check a listed site with water_get_site_data_catalog: not_found means no such site, an empty series list means it never measured the parameter, and each row’s endDate gives its last report.',
      ),
    deferredSites: z
      .array(z.string().describe('A USGS site number not read in this call.'))
      .describe(
        `Distinct site numbers past the first ${SITE_BATCH_SIZE} distinct in sites, in input order, each listed once — not read in this call. Pass them as sites in another call to read them. Empty when every site was read.`,
      ),
  }),

  enrichment: {
    query: z
      .object({
        sites: z
          .array(z.string())
          .describe(
            `Site numbers read in this call: the first ${SITE_BATCH_SIZE} distinct numbers of sites, in input order.`,
          ),
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
      when: 'No site read in this call returned a series and no site was deferred — each site either does not exist or has no instantaneous series of the requested parameter(s). A site whose sensor reported nothing in the period returns a series with totalValues 0 instead; when sites were deferred, the call succeeds with empty readings instead.',
      recovery:
        'Check each site with water_get_site_data_catalog: not_found means no such site, an empty series list means it never measured the parameter, and each row’s endDate gives its last report.',
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
        'Retry after a short backoff; request fewer sites or a shorter period if it repeatedly times out.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Getting instantaneous readings', {
      siteCount: input.sites.length,
      parameterCount: input.parameterCd?.length ?? 0,
      period: input.period,
    });

    const { read, deferred } = splitSiteBatch(input.sites);
    const request = startRequest(ctx, 'water_get_readings');
    let series: NwisTimeSeries[];
    try {
      series = await getReadings(
        {
          sites: read,
          period: input.period,
          ...(input.parameterCd?.length ? { parameterCds: input.parameterCd } : {}),
        },
        request,
      );
    } catch (err: unknown) {
      if (ctx.signal?.aborted) throw err;
      const failure = classifyWaterDataFailure(err);
      if (failure) throw ctx.fail(failure.reason, failure.message, failure.data, { cause: err });
      throw err;
    }

    /**
     * A sensor that reported nothing in the period still returns, as a series with no records, so
     * an empty list means no site read has an instantaneous series of these parameters at all.
     * With sites deferred the call still succeeds: failing would drop the list the caller resubmits.
     */
    if (series.length === 0 && deferred.length === 0) {
      throw ctx.fail(
        'no_data_for_parameter',
        `No requested site returned an instantaneous series${input.parameterCd?.length ? ` for parameterCd ${input.parameterCd.join(', ')}` : ''} — each site either does not exist or has no such series.`,
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

    // A site that does not exist or has no matching series returns nothing — diff the sites read
    // against what came back so a partial batch is visible rather than inferred.
    const returnedSites = new Set(series.map((s) => s.siteNumber));
    const missingSites = read.filter((s) => !returnedSites.has(s));

    ctx.enrich({
      query: {
        sites: read,
        parameterCd: input.parameterCd,
        period: input.period,
      },
    });

    ctx.log.info('Readings fetched', {
      seriesCount: readings.length,
      totalSeries: series.length,
      truncated,
      missingSiteCount: missingSites.length,
      deferredSiteCount: deferred.length,
    });
    return {
      readings,
      total: readings.length,
      totalSeries: series.length,
      truncated,
      missingSites,
      deferredSites: deferred,
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
        `**No series returned for:** ${result.missingSites.join(', ')} — check each with water_get_site_data_catalog: not_found means no such site, an empty series list means it never measured the parameter.\n`,
      );
    }
    const deferred = formatDeferredSites(result.deferredSites);
    if (deferred) lines.push(`${deferred}\n`);

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

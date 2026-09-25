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
import type {
  NwisStatRow,
  NwisTimeSeries,
  NwisValueRecord,
  PercentileClass,
} from '@/services/nwis/types.js';

/** The percentile thresholds that bound the classes, in ascending order. */
const THRESHOLDS = [
  { key: 'p05', name: '5th' },
  { key: 'p10', name: '10th' },
  { key: 'p25', name: '25th' },
  { key: 'p75', name: '75th' },
  { key: 'p95', name: '95th' },
] as const;

type Thresholds = Pick<NwisStatRow, (typeof THRESHOLDS)[number]['key']>;

/**
 * Classify a value against the percentile thresholds NWIS published for its calendar day.
 *
 * NWIS leaves the outer thresholds (p05, p10, p95) blank on short records, so each class is decided
 * by the thresholds that are present. A value at or above p75 is above-normal whether or not p95 is
 * published, and a value below p25 or p10 is below-normal or low whether or not the next threshold
 * out is — the label then names the unpublished threshold, since the value may lie past it. normal
 * needs both quartiles. A value no published threshold places — inside a gap left by a blank
 * quartile — is unknown, labeled with the thresholds bounding it and the ones missing between them.
 */
function classifyPercentile(
  value: number,
  t: Thresholds,
): { percentileClass: PercentileClass; percentileLabel: string } {
  const placed = (percentileClass: PercentileClass, openEnded?: string) => ({
    percentileClass,
    percentileLabel: openEnded ?? PERCENTILE_LABELS[percentileClass],
  });
  if (t.p95 !== null && value >= t.p95) return placed('record-high');
  if (t.p75 !== null && value >= t.p75) {
    return placed(
      'above-normal',
      t.p95 === null ? '≥ 75th percentile; 95th not published' : undefined,
    );
  }
  if (t.p05 !== null && value < t.p05) return placed('record-low');
  if (t.p10 !== null && value < t.p10) {
    return placed('low', t.p05 === null ? '< 10th percentile; 5th not published' : undefined);
  }
  if (t.p25 !== null && value < t.p25) {
    return placed(
      'below-normal',
      t.p10 === null ? '< 25th percentile; 10th not published' : undefined,
    );
  }
  if (t.p25 !== null && t.p75 !== null) return placed('normal');
  return { percentileClass: 'unknown', percentileLabel: unplacedLabel(value, t) };
}

/**
 * Label for a value that falls in a gap between published thresholds: the nearest published
 * threshold on each side, and the thresholds between them — every one of which NWIS left blank,
 * since a published one would itself be the nearest on its side.
 */
function unplacedLabel(value: number, t: Thresholds): string {
  const lower = THRESHOLDS.findLastIndex(({ key }) => {
    const threshold = t[key];
    return threshold !== null && value >= threshold;
  });
  const upperIndex = THRESHOLDS.findIndex(({ key }) => {
    const threshold = t[key];
    return threshold !== null && value < threshold;
  });
  const upper = upperIndex === -1 ? THRESHOLDS.length : upperIndex;
  const missing = THRESHOLDS.slice(lower + 1, upper).map(({ name }) => name);
  if (missing.length === THRESHOLDS.length) return 'no percentile thresholds published';

  const lowerName = THRESHOLDS[lower]?.name;
  const upperName = THRESHOLDS[upper]?.name;
  const position =
    lowerName && upperName
      ? `${lowerName}–${upperName} percentile`
      : lowerName
        ? `≥ ${lowerName} percentile`
        : `< ${upperName} percentile`;
  return `${position}; ${missing.join(', ')} not published`;
}

/**
 * Plain-language threshold for each percentile class. The class names 'record-high' and
 * 'record-low' describe percentile-of-record extremes (≥ p95 / < p05), not verified all-time
 * records — the stat table carries the true observed extremes separately in max_va/min_va. The
 * enum value alone is what reaches structuredContent, so the disambiguation travels as its own
 * field rather than as schema description text a downstream reader never sees. These are the
 * labels for a fully published threshold set; classifyPercentile substitutes one naming the
 * missing threshold when a class was decided without it.
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

/**
 * The method series whose latest reading is reported, with that reading. A site can report one
 * parameter from several sensors, and the block NWIS lists first is not necessarily the one that
 * is current. Each method's latest record competes on three keys, in order: it carries a value (a
 * discontinued or seasonal sensor listed beside the live one reports the no-data value); its
 * method is the one a stat series is described as (`isPaired`), so the reading and the percentiles
 * come from the same sensor; it is the most recent. Sensors at one site report minutes apart, so
 * recency alone would swap the sensor behind the answer with whichever reported last. Ties keep
 * the earlier series in NWIS response order. Undefined when no series carries a record.
 */
function currentReading(
  series: NwisTimeSeries[],
  isPaired: (series: NwisTimeSeries) => boolean,
): { reading: NwisValueRecord; series: NwisTimeSeries } | undefined {
  type Candidate = {
    at: number;
    measured: boolean;
    paired: boolean;
    reading: NwisValueRecord;
    series: NwisTimeSeries;
  };
  const outranks = (a: Candidate, b: Candidate) =>
    a.measured !== b.measured ? a.measured : a.paired !== b.paired ? a.paired : a.at > b.at;
  let best: Candidate | undefined;
  for (const s of series) {
    const reading = s.values.at(-1);
    if (!reading) continue;
    const candidate = {
      at: Date.parse(reading.dateTime),
      measured: reading.value !== '',
      paired: isPaired(s),
      reading,
      series: s,
    };
    if (!best || outranks(candidate, best)) best = candidate;
  }
  return best;
}

/** " (qualifiers: P, Ssn)" for a reading that carries qualifier codes, else "". */
function qualifierSuffix(qualifiers: string[]): string {
  return qualifiers.length > 0 ? ` (qualifiers: ${qualifiers.join(', ')})` : '';
}

/** One stat-table time series: the rows sharing a `ts_id`, in table order. */
type StatSeries = NwisStatRow[];

/** "<description> [ts_id <id>]" — how a stat series is named in a note. */
function nameStatSeries(series: StatSeries): string {
  return `${series[0]?.seriesDescription ?? '(no description)'} [ts_id ${series[0]?.tsId ?? 'none'}]`;
}

/**
 * A stat description with its trailing bracketed label set aside: "AUXILIARY GAGE, [AUXILIARY
 * GAGE]" → "AUXILIARY GAGE", "[BASE GAGE]" → "". The stat service appends such a label where the
 * IV method description of the same gage often carries none. "[Discontinued]" is not set aside —
 * it marks a retired series, not the name of a live one. Undefined when there is no label to drop.
 */
function withoutBracketLabel(description: string | null): string | undefined {
  const match = /^(.*?)(?:,\s*)?\[([^\]]*)\]$/.exec(description ?? '');
  if (!match || match[2]?.trim().toLowerCase() === 'discontinued') return;
  return match[1]?.trim();
}

/**
 * The stat series a method's description identifies. The stat service keys its rows by its own
 * `ts_id`, a daily-mean series ID that shares no number with the IV method ID, so the location
 * description (`loc_web_ds` against `methodDescription`) is the only correspondence the two
 * services publish. A series described exactly as the method is `exact`. Failing that, a series
 * whose description equals the method's once its bracketed label is set aside is `label`. Either
 * holds only when exactly one series qualifies — two series sharing a description identify
 * neither.
 */
function pairStatSeries(
  groups: StatSeries[],
  methodDescription: string | null,
): { basis: 'exact' | 'label'; series: StatSeries } | undefined {
  const exact = groups.filter((g) => g[0]?.seriesDescription === methodDescription);
  if (exact.length > 1) return;
  if (exact[0]) return { basis: 'exact', series: exact[0] };
  const labeled = groups.filter(
    (g) => withoutBracketLabel(g[0]?.seriesDescription ?? null) === (methodDescription ?? ''),
  );
  return labeled.length === 1 && labeled[0] ? { basis: 'label', series: labeled[0] } : undefined;
}

/**
 * Choose the stat-table time series to rank the reading against. The series its method is paired
 * with (see {@link pairStatSeries}) is used — marked `methodMatched` only for an exact description
 * match, with a note when the pairing set a bracketed label aside. With no pairing, a table holding
 * a single series is still used, unmatched, with a note; a table holding several yields no ranking
 * rather than one picked arbitrarily.
 */
function selectStatSeries(
  groups: StatSeries[],
  methodDescription: string | null,
):
  | { methodMatched: boolean; note?: string; rows: StatSeries }
  | { unmatchedDescriptions: string[] } {
  const method = methodDescription ?? 'no description';
  const paired = pairStatSeries(groups, methodDescription);
  if (paired?.basis === 'exact') return { methodMatched: true, rows: paired.series };
  if (paired) {
    return {
      methodMatched: false,
      rows: paired.series,
      note: `Percentiles come from the statistics series ${nameStatSeries(paired.series)}, the only one whose description matches the reported method's (${method}) once the bracketed label the statistics service adds is set aside. The two descriptions are not identical, so methodMatched is false.`,
    };
  }
  if (groups.length === 1 && groups[0]) {
    return {
      methodMatched: false,
      rows: groups[0],
      note: `Percentiles come from the only statistics series at this site, ${nameStatSeries(groups[0])}, whose description differs from the reported method's (${method}) — they may come from a different sensor or location than the reading.`,
    };
  }
  return { unmatchedDescriptions: groups.map(nameStatSeries) };
}

export const waterGetConditions = tool('water_get_conditions', {
  description:
    'Get a USGS site\'s current reading ranked against its full period-of-record daily-mean percentiles for the same calendar day — a "how unusual is this" percentileClass (record-high to record-low), not a flood-stage or drought determination (this tool fetches no authoritative thresholds). The reading is instantaneous but the percentiles are daily-mean, so the ranking is approximate (see historicalContext.comparisonBasis). When the record is too short to rank, returns the reading with historicalContext=null instead of an error. A reading NWIS reports as no data (a seasonal, discontinued, dry, or malfunctioning gage) returns an empty currentValue with the qualifiers naming why, and is not ranked. When the site measures the parameter with several sensors (methods), one reading is used and named by methodId/methodDescription — from the sensor its percentile series is described as when one is, otherwise the most recent across them; water_get_readings lists every method. Use water_find_sites and water_list_parameters to resolve inputs.',
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
    methodId: z
      .string()
      .nullable()
      .describe(
        'NWIS method ID of the sensor series the current reading comes from. When the site reports the parameter from several, a method with a measured latest reading is preferred, then one whose description a statistics series carries exactly (so reading and percentiles come from one sensor), then the most recent. Null only when NWIS returned the series with no method block.',
      ),
    methodDescription: z
      .string()
      .nullable()
      .describe(
        'NWIS description of that method (e.g. "From multiparameter sonde", "[(2)]"). Null when NWIS leaves it blank, as it does for the default series at most single-sensor sites.',
      ),
    currentValue: z
      .string()
      .describe(
        'Most recent observed value as a string. Empty string when NWIS reported no value for the reading — qualifiers then give the reason, and historicalContext does not rank it. A method with a measured latest reading is preferred over one whose latest reading has no value.',
      ),
    currentDateTime: z.string().describe('ISO 8601 date-time of the most recent observation.'),
    qualifiers: z
      .array(z.string().describe('A USGS data qualifier code (e.g. "P" = provisional).'))
      .describe(
        'Data qualifier codes for the current reading. When currentValue is empty they name why NWIS has no value (e.g. "Ssn" seasonal, "Dis" discontinued, "Dry", "Eqp" equipment malfunction).',
      ),
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
            'Classification relative to the full period-of-record: record-high (≥ p95), above-normal (p75–p95), normal (p25–p75), below-normal (p10–p25), low (p05–p10), record-low (< p05). Decided by the thresholds NWIS published: with p95 blank a value ≥ p75 is above-normal, and with p10 or p05 blank a value below p25 or p10 is below-normal or low. normal requires both p25 and p75; a value the published thresholds cannot place is unknown, as is a reading NWIS reported as no data (currentValue empty). See percentileLabel for the threshold in plain language.',
          ),
        percentileLabel: z
          .string()
          .describe(
            'Plain-language threshold for percentileClass (e.g. "25th–75th percentile"). When the class was decided without an unpublished threshold, the label names it (e.g. "≥ 75th percentile; 95th not published") — the value may lie past it. An unknown class names the published thresholds either side and the blank ones between (e.g. "25th–95th percentile; 75th not published"), or, for a reading with no value, says so and names its qualifiers. The record-high and record-low classes mark percentile-of-record extremes (≥ p95 / < p05), not verified all-time records — this field says so where the class name does not.',
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
        statSeriesId: z
          .string()
          .nullable()
          .describe(
            'NWIS statistics time-series ID (ts_id) the percentiles were computed from. A daily-mean series ID, numbered independently of the IV methodId. Null when NWIS omits it.',
          ),
        statSeriesDescription: z
          .string()
          .nullable()
          .describe(
            'Location description NWIS gives that statistics series (e.g. "From multiparameter sonde"). Null when blank.',
          ),
        methodMatched: z
          .boolean()
          .describe(
            'True when statSeriesDescription equals the reported methodDescription, which is how the percentiles are matched to the sensor that produced the reading. False when the descriptions differ but the series was still used — it is the only statistics series whose description matches once the bracketed label the statistics service appends (e.g. "[BASE GAGE]") is set aside, or the only statistics series at the site; note says which. The percentiles may then come from a different sensor or location than the reading.',
          ),
      })
      .nullable()
      .describe(
        'Historical percentile context for the observation\'s calendar day. Non-null only when historicalContextStatus is "available"; see that field for why it is otherwise absent.',
      ),
    historicalContextStatus: z
      .enum(['available', 'no_matching_day', 'no_matching_method', 'no_record', 'unavailable'])
      .describe(
        "Why historicalContext is or is not populated. 'available': percentiles for the observation's calendar day are present. 'no_matching_day': the stat table has rows but none for that calendar day. 'no_matching_method': the stat table covers several sensor series at this site and none is identified by the reported method's description — exactly, or apart from a bracketed label — so no series is picked to rank against (note lists them). 'no_record': the stat table is empty — a new site, or a record too short to compute percentiles. 'unavailable': the statistics service call failed — a transient upstream error, not a statement about the site's record; retry shortly.",
      ),
    note: z
      .string()
      .optional()
      .describe(
        'Informational note explaining why historicalContext is null or incomplete, that NWIS reported no value for the current reading, or which statistics series the percentiles came from when methodMatched is false. Absent when the reading is measured and ranked against a statistics series described exactly as its method.',
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
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The NWIS IV endpoint returned a 5xx error, timed out, or sent a response body that is not valid WaterML-JSON (cut off mid-document), and retrying did not clear it. A stat-endpoint failure does not raise this — it is reported as historicalContextStatus "unavailable".',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
      thrownBy: 'service',
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
          ctx,
        ),
        getStats(input.site, input.parameterCd, ctx)
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

    if (ivResult.length === 0) {
      // NWIS returns an empty timeSeries array for both unknown sites and valid sites that have no
      // data for the requested parameter — the two cases are indistinguishable without a separate
      // site-existence check.
      throw ctx.fail(
        'no_data_for_parameter',
        `No data returned for site ${input.site} parameter ${input.parameterCd} — the site may not exist, or may not measure this parameter. Use water_find_sites with a parameterCd filter to verify parameter availability.`,
        ctx.recoveryFor('no_data_for_parameter'),
      );
    }

    // The reading to report — an empty series carries no current value. A stat call that failed or
    // came back empty pairs no method, which leaves the choice to value and recency.
    const statGroups: StatSeries[] = statOutcome.ok
      ? [...Map.groupBy(statOutcome.result.rows, (row) => row.tsId).values()]
      : [];
    const latest = currentReading(
      ivResult,
      (s) => pairStatSeries(statGroups, s.methodDescription)?.basis === 'exact',
    );
    if (!latest) {
      throw ctx.fail(
        'no_data_for_parameter',
        `No current reading for site ${input.site} parameter ${input.parameterCd} in the last 2 hours — the site reports this parameter but returned no value in the current period. Use water_get_series for historical values.`,
        ctx.recoveryFor('no_data_for_parameter'),
      );
    }
    const ts = latest.series;
    const currentValue = latest.reading.value;
    const currentDateTime = latest.reading.dateTime;
    const qualifiers = latest.reading.qualifiers;

    // Historical context — populated only when the stat call succeeded, a stat series could be
    // chosen for the reported method, AND that series carried a row for the observation's calendar
    // day. historicalContextStatus records which of those conditions failed,
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
      statSeriesId: string | null;
      statSeriesDescription: string | null;
      methodMatched: boolean;
    } | null = null;
    let historicalContextStatus:
      | 'available'
      | 'no_matching_day'
      | 'no_matching_method'
      | 'no_record'
      | 'unavailable';
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
      const statSeries = selectStatSeries(statGroups, ts.methodDescription);
      // Match on the observation's own calendar day, not the runtime's — see parseObservationDate.
      const observed = parseObservationDate(currentDateTime);
      const statRow =
        observed && 'rows' in statSeries
          ? statSeries.rows.find((r) => r.monthNu === observed.month && r.dayNu === observed.day)
          : undefined;

      if ('unmatchedDescriptions' in statSeries) {
        historicalContextStatus = 'no_matching_method';
        note = `The statistics cover ${statSeries.unmatchedDescriptions.length} sensor series at this site — ${statSeries.unmatchedDescriptions.join('; ')} — and none is identified by the reported method's description (${ts.methodDescription ?? 'no description'}), so no ranking is made rather than attributing another sensor's percentiles to this reading.`;
      } else if (statRow) {
        note = statSeries.note;
        const numValue = Number.parseFloat(currentValue);
        const { percentileClass, percentileLabel } =
          currentValue === ''
            ? {
                percentileClass: 'unknown' as const,
                percentileLabel: `no value to rank — NWIS reported no data for this reading${qualifierSuffix(qualifiers)}`,
              }
            : Number.isNaN(numValue)
              ? { percentileClass: 'unknown' as const, percentileLabel: PERCENTILE_LABELS.unknown }
              : classifyPercentile(numValue, statRow);

        historicalContext = {
          percentileClass,
          percentileLabel,
          p05: statRow.p05,
          p10: statRow.p10,
          p25: statRow.p25,
          p50: statRow.p50,
          p75: statRow.p75,
          p95: statRow.p95,
          periodOfRecord: `${statRow.beginYr}–${statRow.endYr}`,
          comparisonBasis: COMPARISON_BASIS,
          statSeriesId: statRow.tsId,
          statSeriesDescription: statRow.seriesDescription,
          methodMatched: statSeries.methodMatched,
        };
        historicalContextStatus = 'available';
      } else {
        historicalContextStatus = 'no_matching_day';
        note = "Stat data is available but contains no entry for today's calendar day.";
      }
    }

    if (currentValue === '') {
      const missing = `NWIS reported no value for the current reading${qualifierSuffix(qualifiers)}, so it is not ranked. The qualifiers give the reason, e.g. Ssn seasonal, Dis discontinued, Dry, Eqp equipment malfunction.`;
      note = note ? `${missing} ${note}` : missing;
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
      methodId: ts.methodId,
      methodDescription: ts.methodDescription,
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
      `**Method:** ${result.methodDescription ?? '(no description)'} | **Method ID:** ${result.methodId ?? 'none'}`,
      `**Current value:** ${result.currentValue === '' ? 'no data' : `${result.currentValue} ${result.unitCode}`}${qualifier}`,
      `**Observed:** ${result.currentDateTime}`,
      '',
    ];

    if (result.historicalContext) {
      lines.push(
        `**Condition:** ${result.historicalContext.percentileClass} — ${result.historicalContext.percentileLabel} | **Period of record:** ${result.historicalContext.periodOfRecord}`,
        `**Percentiles for today's calendar day:**`,
        `  p05=${result.historicalContext.p05 ?? 'N/A'} | p10=${result.historicalContext.p10 ?? 'N/A'} | p25=${result.historicalContext.p25 ?? 'N/A'} | p50=${result.historicalContext.p50 ?? 'N/A'} | p75=${result.historicalContext.p75 ?? 'N/A'} | p95=${result.historicalContext.p95 ?? 'N/A'}`,
        `*${result.historicalContext.comparisonBasis}*`,
        `**Percentile series:** ${result.historicalContext.statSeriesDescription ?? '(no description)'} | **Stat series ID:** ${result.historicalContext.statSeriesId ?? 'none'} | ${
          result.historicalContext.methodMatched
            ? 'matched to the reported method by description'
            : 'not matched to the reported method — the descriptions differ, so the percentiles may come from a different sensor (see note)'
        }`,
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

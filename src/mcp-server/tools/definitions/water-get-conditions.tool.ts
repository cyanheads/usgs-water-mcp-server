/**
 * @fileoverview Get current hydrologic conditions at up to 100 USGS sites per call, each reading
 * ranked against its site's historical percentile record for the same calendar day — a "how
 * unusual is this reading" ranking, not a flood-stage or drought determination.
 * @module mcp-server/tools/definitions/water-get-conditions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { DEPTH_BELOW_SURFACE_CODES } from '@/services/waterdata/curated-parameters.js';
import {
  type DayPercentiles,
  type DayStatistics,
  type DayStatisticsQuery,
  getDailyMeanSeries,
  getDayStatistics,
  type SiteDailyMeans,
} from '@/services/waterdata/day-statistics.js';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/waterdata/input-schemas.js';
import { getReadings } from '@/services/waterdata/observations.js';
import {
  formatDeferredSites,
  SITE_BATCH_SIZE,
  SITE_LIST_MAX,
  splitSiteBatch,
} from '@/services/waterdata/site-batch.js';
import type {
  NwisTimeSeries,
  NwisValueRecord,
  PercentileClass,
} from '@/services/waterdata/types.js';
import { startRequest, type WaterDataRequest } from '@/services/waterdata/water-data-client.js';
import { classifyWaterDataFailure } from '@/services/waterdata/water-data-errors.js';

/** The percentile thresholds that bound the classes, in ascending order. */
const THRESHOLDS = [
  { key: 'p05', name: '5th' },
  { key: 'p10', name: '10th' },
  { key: 'p25', name: '25th' },
  { key: 'p75', name: '75th' },
  { key: 'p95', name: '95th' },
] as const;

type Thresholds = Pick<DayPercentiles, (typeof THRESHOLDS)[number]['key']>;

/**
 * Classify a value against the percentile thresholds published for its calendar day, on a scale
 * that rises with the water (see {@link rankReading} for depth codes).
 *
 * Short records leave the outer thresholds (p05, p10, p95) blank, so each class is decided
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
 * threshold on each side, and the thresholds between them — every one of which was left blank,
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
 * records — the statistics publish the observed extremes as separate maximum and minimum
 * computations this tool does not read. The enum value alone is what reaches structuredContent,
 * so the disambiguation travels as its own field rather than as schema description text a
 * downstream reader never sees. These are the labels for a fully published threshold set;
 * classifyPercentile substitutes one naming the missing threshold when a class was decided
 * without it.
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
 * instantaneous reading, but the percentiles are computed from approved daily-mean values — USGS
 * publishes no instantaneous percentile product — so an instantaneous peak can rank higher than
 * the same day's daily mean would. Like percentileLabel, it travels as its own field because the
 * raw structuredContent value is read where schema description text is not.
 */
const COMPARISON_BASIS =
  "The current value is an instantaneous reading, but these percentiles are computed from approved daily-mean values for this calendar day, so an instantaneous peak can rank above the same day's daily mean. Treat percentileClass as an approximate ranking, not a like-for-like comparison.";

/** What a depth code's comparisonBasis adds: the value is a depth, its percentiles water levels. */
const DEPTH_BASIS =
  'This value is a depth below the surface, ranked as a water level: a shallower depth is a higher water level, so p95 is the shallowest of these depths and p05 the deepest. currentValue is the depth as measured.';

/** What a depth code's percentileLabel adds. */
const DEPTH_LABEL = 'depth ranked as a water level (shallower ranks higher)';

/**
 * Rank a reading against its day's thresholds by water level. Percentiles are published in
 * water-level order, so for a depth-below-surface code (DEPTH_BELOW_SURFACE_CODES) p95 is the
 * shallowest depth: a depth at or shallower than p95 is record-high and one deeper than p05
 * record-low. Negating the depth and its thresholds turns it into the rising scale every other
 * code already reads, so one classifier serves both and the blank-threshold rules mirror with it.
 */
function rankReading(
  value: number,
  t: Thresholds,
  byDepth: boolean,
): { percentileClass: PercentileClass; percentileLabel: string } {
  if (!byDepth) return classifyPercentile(value, t);
  const level = (threshold: number | null) => (threshold === null ? null : -threshold);
  const ranked = classifyPercentile(-value, {
    p05: level(t.p05),
    p10: level(t.p10),
    p25: level(t.p25),
    p75: level(t.p75),
    p95: level(t.p95),
  });
  return { ...ranked, percentileLabel: `${ranked.percentileLabel} — ${DEPTH_LABEL}` };
}

/**
 * The observation's own calendar day, `MM-DD`, read out of its site-local timestamp (e.g.
 * "2026-06-28T00:50:00.000-04:00"). The date prefix already is the observation's local calendar
 * date. Routing it through `Date` would re-project that instant into the runtime's timezone and
 * select a neighboring day's percentiles for readings near midnight — in either direction,
 * depending on the sign of the offset. Null when the timestamp carries no date prefix.
 */
function observationDay(dateTime: string): string | null {
  const match = /^\d{4}-(\d{2}-\d{2})/.exec(dateTime);
  return match?.[1] ?? null;
}

/**
 * The method series whose latest reading is reported, with that reading. A site can report one
 * parameter from several sensors, and the series listed first is not necessarily the one that is
 * current. Each series' latest record competes on three keys, in order: it carries a value (a
 * discontinued or seasonal sensor listed beside the live one reports no value); the statistics
 * hold a daily-mean series computed from it (`isPaired`), so the reading and the percentiles come
 * from the same sensor; it is the most recent. Sensors at one site report minutes apart, so
 * recency alone would swap the sensor behind the answer with whichever reported last. Sensors that
 * also read at the same instant (a base and an auxiliary gage) go to the site's default sensor,
 * the series with no description: response order breaks ties by time-series ID, which says nothing
 * about which sensor is primary. Remaining ties keep the earlier series in response order.
 * Undefined when no series carries a record.
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
    a.measured !== b.measured
      ? a.measured
      : a.paired !== b.paired
        ? a.paired
        : a.at !== b.at
          ? a.at > b.at
          : a.series.methodDescription === null && b.series.methodDescription !== null;
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

/** "<description> [series <id>]" — how a daily-mean series is named in a note. */
function nameSeries({ description, id }: { description: string | null; id: string }): string {
  return `${description ?? '(no description)'} [series ${id}]`;
}

/** The historical-context fields of a conditions row. */
interface HistoricalContextFields {
  historicalContext: {
    comparisonBasis: string;
    methodMatched: boolean;
    p05: number | null;
    p10: number | null;
    p25: number | null;
    p50: number | null;
    p75: number | null;
    p95: number | null;
    percentileClass: PercentileClass;
    percentileLabel: string;
    periodOfRecord: string;
    statSeriesDescription: string | null;
    statSeriesId: string | null;
  } | null;
  historicalContextStatus:
    | 'available'
    | 'no_matching_day'
    | 'no_matching_method'
    | 'no_record'
    | 'unavailable';
  note?: string;
}

/** Why the statistics rank nothing for the day, as a status and the note that explains it. */
function unrankedContext(
  outcome: Exclude<DayStatistics, { status: 'available' }>,
  sensor: string,
): HistoricalContextFields {
  switch (outcome.status) {
    case 'no_record':
      return {
        historicalContext: null,
        historicalContextStatus: 'no_record',
        note: 'No historical daily-mean percentiles are published for this site and parameter on this calendar day. The record may be too new or too short to compute them, or this parameter has no daily-mean statistics here (some series carry only daily maximum or minimum statistics).',
      };
    case 'no_matching_day':
      return {
        historicalContext: null,
        historicalContextStatus: 'no_matching_day',
        note: "The reported sensor's daily-mean series has an approved record, but no percentiles for the observation's calendar day.",
      };
    case 'no_matching_method':
      return {
        historicalContext: null,
        historicalContextStatus: 'no_matching_method',
        note: `The statistics cover ${outcome.candidates.length} daily-mean series at this site — ${outcome.candidates.map(nameSeries).join('; ')} — and none is computed from ${sensor}, so no ranking is made rather than attributing another sensor's percentiles to this reading.`,
      };
  }
}

/**
 * The historical-context fields for a reading, from what the statistics held for its day — or why
 * they hold nothing. A statistics failure is reported, never attributed to the site's record.
 */
function historicalContextFor(
  statistics: PromiseSettledResult<DayStatistics>,
  reading: NwisValueRecord,
  series: NwisTimeSeries,
): HistoricalContextFields {
  if (statistics.status === 'rejected') {
    return {
      historicalContext: null,
      historicalContextStatus: 'unavailable',
      note: `Historical percentile context could not be retrieved — the statistics service call failed. ${failureMessage(statistics.reason)} This is an upstream failure, not a statement about the site's record; call again later for the ranking.`,
    };
  }
  const outcome = statistics.value;
  const sensor = `the reported sensor's series (${series.methodId ?? 'no method ID'})`;
  if (outcome.status !== 'available') return unrankedContext(outcome, sensor);

  const { matched, series: ranked } = outcome;
  const byDepth = DEPTH_BELOW_SURFACE_CODES.has(series.parameterCd);
  const value = Number.parseFloat(reading.value);
  const { percentileClass, percentileLabel } =
    reading.value === ''
      ? {
          percentileClass: 'unknown' as const,
          percentileLabel: `no value to rank — USGS reported no data for this reading${qualifierSuffix(reading.qualifiers)}`,
        }
      : Number.isNaN(value)
        ? { percentileClass: 'unknown' as const, percentileLabel: PERCENTILE_LABELS.unknown }
        : rankReading(value, ranked.percentiles, byDepth);
  return {
    historicalContext: {
      percentileClass,
      percentileLabel,
      ...ranked.percentiles,
      periodOfRecord: `${ranked.periodOfRecord.firstWaterYear}–${ranked.periodOfRecord.lastWaterYear}`,
      comparisonBasis: byDepth ? `${COMPARISON_BASIS} ${DEPTH_BASIS}` : COMPARISON_BASIS,
      statSeriesId: ranked.id,
      statSeriesDescription: ranked.description,
      methodMatched: matched,
    },
    historicalContextStatus: 'available',
    ...(matched
      ? {}
      : {
          note: `Percentiles come from the only daily-mean series with percentiles for this day, ${nameSeries(ranked)}, which is not computed from ${sensor} — they may come from a different sensor or location than the reading.`,
        }),
  };
}

/** A rejection's message, as a note or log quotes it. */
function failureMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

/** A promise's outcome as a value, so a statistics failure can degrade instead of throwing. */
function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  );
}

/** Each read site's daily-mean series lookup, settled per site, keyed by number in input order. */
type DailyMeansBySite = ReadonlyMap<string, PromiseSettledResult<SiteDailyMeans>>;

/** A read site's chosen reading, beside its daily-mean series lookup. */
interface RankedReading {
  dailyMeans: PromiseSettledResult<SiteDailyMeans>;
  reading: NwisValueRecord;
  series: NwisTimeSeries;
}

/**
 * Each reading with its day statistics — or why none were read: a failed series lookup is the
 * row's own outcome, and a reading with no date has no day. The rest go to the Statistics API in
 * one batch. Only the caller's cancellation throws.
 */
async function withStatistics(
  ranked: readonly RankedReading[],
  request: WaterDataRequest,
): Promise<(RankedReading & { statistics: PromiseSettledResult<DayStatistics> })[]> {
  const queries: DayStatisticsQuery[] = [];
  const outcomes = ranked.map(({ dailyMeans, reading, series }) => {
    if (dailyMeans.status === 'rejected') return dailyMeans;
    // Percentiles for the observation's own calendar day, never the runtime's (see observationDay).
    const monthDay = observationDay(reading.dateTime);
    if (monthDay === null) {
      return { status: 'fulfilled', value: { status: 'no_matching_day' } } as const;
    }
    return queries.push({ monthDay, site: dailyMeans.value, sourceSeriesId: series.methodId }) - 1;
  });
  const answers = await getDayStatistics(queries, request);
  return ranked.map((row, i) => {
    const outcome = outcomes[i];
    return {
      ...row,
      // getDayStatistics answers every query, in query order.
      statistics: (typeof outcome === 'number'
        ? answers[outcome]
        : outcome) as PromiseSettledResult<DayStatistics>,
    };
  });
}

/**
 * Why no series came back for a one-site call, as precisely as the daily-mean lookup that ran
 * beside the reading can say: it resolves the site, so it knows when no location has the number —
 * and when one does.
 */
function noSeriesMessage(
  site: string,
  parameterCd: string,
  dailyMeans: PromiseSettledResult<unknown> | undefined,
): string {
  if (
    dailyMeans?.status === 'rejected' &&
    dailyMeans.reason instanceof McpError &&
    dailyMeans.reason.data?.reason === 'not_found'
  ) {
    return `No USGS monitoring location has site number ${site}. Check the number: water_get_site_data_catalog answers not_found for a site that does not exist.`;
  }
  const silent =
    'water_get_readings with a longer period returns the latest value of a gage silent only in the last two hours';
  return dailyMeans?.status === 'fulfilled'
    ? `No ${parameterCd} data came back for site ${site} in the last 2 hours — the site may never have measured this parameter, or reported nothing in that window. water_get_site_data_catalog tells them apart (an empty series list: never measured; endDate: the last report), and ${silent}.`
    : `No ${parameterCd} data came back for site ${site} in the last 2 hours — the site may not exist, may never have measured this parameter, or reported nothing in that window. water_get_site_data_catalog tells these apart (not_found: no such site; an empty series list: never measured; endDate: the last report), and ${silent}.`;
}

/**
 * The `no_data_for_parameter` message when no read site has a reading. A one-site call keeps the
 * single-site wording: no series (see {@link noSeriesMessage}), or series with no record in the
 * window.
 */
function noReadingMessage(
  sites: readonly string[],
  parameterCd: string,
  seriesBySite: ReadonlyMap<string, NwisTimeSeries[]>,
  dailyMeans: DailyMeansBySite,
): string {
  const [only] = sites;
  if (only !== undefined && sites.length === 1) {
    return seriesBySite.has(only)
      ? `No reading for site ${only} parameter ${parameterCd} in the last 2 hours — the site reports this parameter but sent no value in that window. Call water_get_readings with a longer period for its latest value; water_get_site_data_catalog gives the series' endDate, its last report.`
      : noSeriesMessage(only, parameterCd, dailyMeans.get(only));
  }
  return `No ${parameterCd} reading came back in the last 2 hours for any of the ${sites.length} sites read (${sites.join(', ')}) — each may not exist, may never have measured this parameter, or reported nothing in that window. water_get_site_data_catalog tells these apart (not_found: no such site; an empty series list: never measured; endDate: the last report), and water_get_readings with a longer period returns the latest value of a gage silent only in the last two hours.`;
}

/** One ranked site's row. */
function conditionsRow(
  reading: NwisValueRecord,
  series: NwisTimeSeries,
  statistics: PromiseSettledResult<DayStatistics>,
) {
  const context = historicalContextFor(statistics, reading, series);
  let note = context.note;
  if (reading.value === '') {
    const missing = `USGS reported no value for the current reading${qualifierSuffix(reading.qualifiers)}, so it is not ranked. The qualifiers give the reason (e.g. seasonal, discontinued, dry, equipment malfunction).`;
    note = note ? `${missing} ${note}` : missing;
  }
  return {
    siteNumber: series.siteNumber,
    siteName: series.siteName,
    parameterCd: series.parameterCd,
    parameterName: series.parameterName,
    unitCode: series.unitCode,
    methodId: series.methodId,
    methodDescription: series.methodDescription,
    currentValue: reading.value,
    currentDateTime: reading.dateTime,
    qualifiers: reading.qualifiers,
    historicalContext: context.historicalContext,
    historicalContextStatus: context.historicalContextStatus,
    note,
  };
}

const ConditionsRowSchema = z.object({
  siteNumber: z.string().describe('USGS site number (8–15 digits, e.g. "01646500").'),
  siteName: z.string().describe('Human-readable USGS site name.'),
  parameterCd: z.string().describe('5-digit USGS parameter code that was queried (e.g. "00060").'),
  parameterName: z
    .string()
    .describe(
      'Parameter description from the USGS parameter-code catalog, with units (e.g. "Discharge, cubic feet per second").',
    ),
  unitCode: z
    .string()
    .describe(
      'Unit of measure for currentValue and the historical percentiles (e.g. "ft3/s", "ft").',
    ),
  methodId: z
    .string()
    .nullable()
    .describe(
      "Time-series ID of the instantaneous sensor series the current reading comes from, as water_get_readings returns it. When the site reports the parameter from several, a series with a measured latest reading is preferred, then one the statistics hold a daily-mean series for (so reading and percentiles come from one sensor), then the most recent, then the site's default sensor (methodDescription null) over a labeled one such as an auxiliary gage. Null only when the series carries no ID.",
    ),
  methodDescription: z
    .string()
    .nullable()
    .describe(
      'Description of that sensor series: its sublocation, with its web description in brackets (e.g. "From multiparameter sonde", "AUXILIARY GAGE"). Null when both are blank, as for the default series at most single-sensor sites.',
    ),
  currentValue: z
    .string()
    .describe(
      'Most recent observed value as a string — for a depth-to-water code, the depth as measured. Empty string when USGS reported no value for the reading — qualifiers then give the reason, and historicalContext does not rank it. A method with a measured latest reading is preferred over one whose latest reading has no value.',
    ),
  currentDateTime: z.string().describe('ISO 8601 date-time of the most recent observation.'),
  qualifiers: z
    .array(z.string().describe('A USGS data qualifier for the reading (e.g. "P" = provisional).'))
    .describe(
      'Data qualifiers for the current reading. When currentValue is empty they name why USGS has no value (e.g. seasonal, discontinued, dry, equipment malfunction).',
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
          'Classification of the water level relative to the full period-of-record: record-high (≥ p95), above-normal (p75–p95), normal (p25–p75), below-normal (p10–p25), low (p05–p10), record-low (< p05). For a depth-below-surface code (72019, 30210, 99019, 72276) a shallower depth is a higher water level, so a depth at or shallower than p95 is record-high and one deeper than p05 is record-low. Decided by the thresholds published: with p95 blank a reading at or past p75 is above-normal, and with p10 or p05 blank a reading short of p25 or p10 is below-normal or low. normal requires both p25 and p75; a value the published thresholds cannot place is unknown, as is a reading USGS reported as no data (currentValue empty). See percentileLabel for the threshold in plain language.',
        ),
      percentileLabel: z
        .string()
        .describe(
          'Plain-language threshold for percentileClass (e.g. "25th–75th percentile"). When the class was decided without an unpublished threshold, the label names it (e.g. "≥ 75th percentile; 95th not published") — the value may lie past it. An unknown class names the published thresholds either side and the blank ones between (e.g. "25th–95th percentile; 75th not published"), or, for a reading with no value, says so and names its qualifiers. The record-high and record-low classes mark percentile-of-record extremes (≥ p95 / < p05), not verified all-time records — this field says so where the class name does not. For a depth-below-surface code the label also says the depth is ranked as a water level.',
        ),
      p05: z
        .number()
        .nullable()
        .describe(
          '5th percentile of water level in unitCode for this calendar month+day, based on the period of record — for a depth-below-surface code, the deepest of these depths. Null if that threshold is unpublished.',
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
          '95th percentile of water level in unitCode for this calendar month+day — for a depth-below-surface code, the shallowest of these depths. Null if unpublished.',
        ),
      periodOfRecord: z
        .string()
        .describe(
          'First and last water year of approved daily means for this calendar day, the years the percentiles are computed from (e.g. "1931–2026").',
        ),
      comparisonBasis: z
        .string()
        .describe(
          'Fixed disclosure that percentileClass ranks an instantaneous reading against approved daily-mean percentiles — a cross-granularity approximation, not a flood-stage or drought determination. For a depth-below-surface code it also says the depth is ranked as a water level. Present whenever historicalContext is non-null.',
        ),
      statSeriesId: z
        .string()
        .nullable()
        .describe(
          'Time-series ID of the daily-mean series the percentiles were computed from. When methodMatched is true, that series is computed from the instantaneous series named by methodId.',
        ),
      statSeriesDescription: z
        .string()
        .nullable()
        .describe(
          'Description of that daily-mean series, composed as methodDescription is (e.g. "From multiparameter sonde", "[BASE GAGE]"). Null when blank.',
        ),
      methodMatched: z
        .boolean()
        .describe(
          "True when the percentiles come from the daily-mean series computed from the reported sensor's own series (methodId), linked by time-series ID. False when that sensor has no daily-mean series in the statistics and the site's only series with percentiles for the day was used instead (note says so) — the percentiles may then come from a different sensor or location than the reading.",
        ),
    })
    .nullable()
    .describe(
      'Historical percentile context for the observation\'s calendar day. Non-null only when historicalContextStatus is "available"; see that field for why it is otherwise absent.',
    ),
  historicalContextStatus: z
    .enum(['available', 'no_matching_day', 'no_matching_method', 'no_record', 'unavailable'])
    .describe(
      "Why historicalContext is or is not populated. 'available': percentiles for the observation's calendar day are present. 'no_matching_day': the reported sensor's daily-mean series has an approved record but no percentiles for that calendar day. 'no_matching_method': several daily-mean series have percentiles for the day and none is computed from the reported sensor's series, so no series is picked to rank against (note lists them). 'no_record': no daily-mean percentiles exist for this site, parameter, and calendar day — a new site, a record too short, or a series with only daily maximum or minimum statistics. 'unavailable': a statistics or series-metadata request behind this row failed (note says why) — an upstream failure, not a statement about the site's record; call again later. Other rows of the call are unaffected.",
    ),
  note: z
    .string()
    .optional()
    .describe(
      "Informational note explaining why historicalContext is null or incomplete, that USGS reported no value for the current reading, or which daily-mean series the percentiles came from when methodMatched is false. Absent when the reading is measured and ranked against its own sensor's daily-mean series.",
    ),
});

/** One conditions row's `content[]` block — the single-site rendering. */
function formatRow(row: z.output<typeof ConditionsRowSchema>): string {
  const qualifier = row.qualifiers.length > 0 ? ` [${row.qualifiers.join(',')}]` : '';
  const lines = [
    `### ${row.siteName} (${row.siteNumber})`,
    `**Parameter:** ${row.parameterName} (${row.parameterCd}) | **Unit:** ${row.unitCode}`,
    `**Method:** ${row.methodDescription ?? '(no description)'} | **Method ID:** ${row.methodId ?? 'none'}`,
    `**Current value:** ${row.currentValue === '' ? 'no data' : `${row.currentValue} ${row.unitCode}`}${qualifier}`,
    `**Observed:** ${row.currentDateTime}`,
    '',
  ];

  const context = row.historicalContext;
  if (context) {
    lines.push(
      `**Condition:** ${context.percentileClass} — ${context.percentileLabel} | **Period of record:** ${context.periodOfRecord}`,
      `**Percentiles for today's calendar day:**`,
      `  p05=${context.p05 ?? 'N/A'} | p10=${context.p10 ?? 'N/A'} | p25=${context.p25 ?? 'N/A'} | p50=${context.p50 ?? 'N/A'} | p75=${context.p75 ?? 'N/A'} | p95=${context.p95 ?? 'N/A'}`,
      `*${context.comparisonBasis}*`,
      `**Percentile series:** ${context.statSeriesDescription ?? '(no description)'} | **Stat series ID:** ${context.statSeriesId ?? 'none'} | ${
        context.methodMatched
          ? "matched to the reported method — the daily mean of the sensor's own series"
          : 'not matched to the reported method — the percentiles may come from a different sensor (see note)'
      }`,
    );
  } else {
    lines.push('**Condition:** No historical context available.');
  }

  lines.push(`**Historical context status:** ${row.historicalContextStatus}`);
  if (row.note) lines.push('', `*${row.note}*`);
  return lines.join('\n');
}

export const waterGetConditions = tool('water_get_conditions', {
  description: `Rank the current reading at up to ${SITE_BATCH_SIZE} USGS sites per call against each site's full period-of-record daily-mean percentiles for the same calendar day — a "how unusual is this" percentileClass (record-high to record-low) per site, not a flood-stage or drought determination (this tool fetches no authoritative thresholds). Pass up to ${SITE_LIST_MAX} site numbers and one parameterCd: the first ${SITE_BATCH_SIZE} distinct sites are read, each with a reading in the last two hours returning one conditions row; the others read are listed in missingSites, and sites past the first ${SITE_BATCH_SIZE} return in deferredSites, in input order, to resubmit. Rankings follow the water level: for a depth-to-water code (72019) a shallower depth ranks higher. The reading is instantaneous but the percentiles are daily-mean, so the ranking is approximate (see historicalContext.comparisonBasis). When a site's record is too short to rank, its row carries historicalContext=null instead of an error, and a failed statistics request marks only the rows it covered unavailable. A reading USGS reports as no data (a seasonal, discontinued, dry, or malfunctioning gage) returns an empty currentValue with the qualifiers naming why, and is not ranked. When a site measures the parameter with several sensors (methods), one reading is used and named by methodId/methodDescription — from a sensor the statistics hold a daily-mean series for when one is, otherwise the most recent across them; water_get_readings lists every method. Use water_find_sites and water_list_parameters to resolve inputs.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    sites: z
      .array(SiteNumberSchema.describe('A USGS site number (8–15 digits, e.g. "01646500").'))
      .min(1)
      .max(SITE_LIST_MAX)
      .describe(
        `USGS site numbers to rank (e.g. ["01646500"] for Potomac River at Little Falls), up to ${SITE_LIST_MAX} — a page of water_find_sites results passes through as is. The first ${SITE_BATCH_SIZE} distinct numbers are read; a repeated number counts once, and the rest return in deferredSites. Use water_find_sites to discover valid site numbers.`,
      ),
    parameterCd: ParameterCdSchema.describe(
      '5-digit USGS parameter code ranked at every site (e.g. "00060" for discharge, "00065" for gage height). Use water_list_parameters to discover codes.',
    ),
  }),
  inputAliases: { site: 'sites' },
  output: z.object({
    conditions: z
      .array(ConditionsRowSchema.describe("One read site's current reading and its ranking."))
      .describe(
        'One row per read site with a reading of the parameter in the last two hours, in input order. Empty only when sites were deferred and none of the sites read had a reading.',
      ),
    missingSites: z
      .array(z.string().describe('A read USGS site number with no reading in the last two hours.'))
      .describe(
        'Site numbers read in this call that returned no reading of the parameter in the last two hours, in input order — the site does not exist, never measured the parameter, or reported nothing in that window. Never lists a deferred site. Check one with water_get_site_data_catalog: not_found means no such site, an empty series list means the parameter was never measured there, and endDate gives the last report; for a gage silent only in the last two hours, water_get_readings with a longer period returns its latest value.',
      ),
    deferredSites: z
      .array(z.string().describe('A USGS site number not read in this call.'))
      .describe(
        `Distinct site numbers past the first ${SITE_BATCH_SIZE}, in input order, not read in this call — resubmit them as sites in another call. Empty when every site was read.`,
      ),
  }),

  errors: [
    {
      reason: 'no_data_for_parameter',
      code: JsonRpcErrorCode.NotFound,
      when: 'No site read in this call has a reading of the parameter in the last two hours and no site was deferred: each does not exist, never measured the parameter, or reported nothing in that window. With sites deferred the call succeeds instead, listing the sites read in missingSites.',
      recovery:
        'Call water_get_site_data_catalog for each site the error names (it takes one site per call): not_found means no such site, an empty series list means the parameter was never measured there, and endDate gives the last report. For a gage silent only in the last two hours, call water_get_readings with a longer period.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The USGS Water Data API rejected the readings request, one for every site read. Inputs are validated before the call, so this surfaces a value that is well-formed but unacceptable upstream.',
      recovery:
        'Read the upstream message in this error — it names what was rejected. Correct that input and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS Water Data API answered the readings request with a 5xx error or a response it could not read, and retrying did not clear it. A statistics failure does not raise this — the rows it covered report historicalContextStatus "unavailable".',
      recovery:
        'A server error usually clears: retry after a short backoff. An error marked not retryable means the upstream sent a response this server cannot read, and the same request will fail again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The readings did not arrive within the budget this call shares across its requests. A statistics timeout marks the rows it covered historicalContextStatus "unavailable".',
      recovery:
        'Retry after a short backoff to retrieve the current readings and their historical context.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const { read, deferred } = splitSiteBatch(input.sites);
    ctx.log.info('Getting conditions', {
      sites: read.length,
      deferredSites: deferred.length,
      parameterCd: input.parameterCd,
    });
    // One budget for the call: the readings and every statistics request draw on it.
    const request = startRequest(ctx, 'water_get_conditions');

    // The readings and the sites' daily-mean series run side by side, sharing the site lookup; the
    // series lookup settles per site, so a statistics-side failure still returns the readings.
    const [readings, dailyMeans] = await Promise.all([
      settle(
        getReadings({ sites: read, parameterCds: [input.parameterCd], period: 'PT2H' }, request),
      ),
      getDailyMeanSeries(read, input.parameterCd, request),
    ]);
    if (readings.status === 'rejected') {
      const err: unknown = readings.reason;
      if (ctx.signal.aborted) throw err;
      const failure = classifyWaterDataFailure(err);
      if (failure) throw ctx.fail(failure.reason, failure.message, failure.data, { cause: err });
      throw err;
    }

    const seriesBySite = Map.groupBy(readings.value, (series) => series.siteNumber);
    const ranked: RankedReading[] = [];
    const missingSites: string[] = [];
    for (const [site, outcome] of dailyMeans) {
      // A failed series lookup pairs no sensor, which leaves the choice to value and recency.
      const ownSeries = new Set(
        outcome.status === 'fulfilled'
          ? outcome.value.series.map((series) => series.sourceSeriesId)
          : [],
      );
      // The reading to report — an empty series carries no current value.
      const latest = currentReading(
        seriesBySite.get(site) ?? [],
        (series) => series.methodId !== null && ownSeries.has(series.methodId),
      );
      if (latest) ranked.push({ dailyMeans: outcome, ...latest });
      else missingSites.push(site);
    }
    if (ranked.length === 0 && deferred.length === 0) {
      throw ctx.fail(
        'no_data_for_parameter',
        noReadingMessage(read, input.parameterCd, seriesBySite, dailyMeans),
      );
    }

    const rows = await withStatistics(ranked, request);
    const failed = rows.flatMap(({ series, statistics }) =>
      statistics.status === 'rejected'
        ? [{ site: series.siteNumber, reason: statistics.reason }]
        : [],
    );
    const [firstFailure] = failed;
    if (firstFailure) {
      if (ctx.signal.aborted) throw firstFailure.reason;
      ctx.log.warning('Statistics lookup failed; returning readings without historical context', {
        sites: failed.map((f) => f.site),
        parameterCd: input.parameterCd,
        error: failureMessage(firstFailure.reason),
      });
    }

    const conditions = rows.map(({ reading, series, statistics }) =>
      conditionsRow(reading, series, statistics),
    );
    ctx.log.info('Conditions resolved', {
      ranked: conditions.length,
      missingSites: missingSites.length,
      deferredSites: deferred.length,
    });
    return { conditions, missingSites, deferredSites: deferred };
  },

  format(result) {
    const blocks = result.conditions.map(formatRow);
    if (result.conditions.length === 0) {
      blocks.push('No site read in this call has a reading of the parameter in the last 2 hours.');
    }
    if (result.missingSites.length > 0) {
      blocks.push(
        `**No reading in the last 2 hours:** ${result.missingSites.join(', ')} — check each with water_get_site_data_catalog: not_found means no such site, an empty series list means it never measured the parameter, and endDate gives its last report. water_get_readings with a longer period returns the latest value of a gage silent only in the last two hours.`,
      );
    }
    const deferredLine = formatDeferredSites(result.deferredSites);
    if (deferredLine) blocks.push(deferredLine);
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});

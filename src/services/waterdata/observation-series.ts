/**
 * @fileoverview Assemble `continuous` or `daily` observation rows and their `time-series-metadata`
 * into the {@link NwisTimeSeries} shape WaterServices produced: one series per time series (a
 * statistic × method), listed whether or not it holds values in the window, with WaterServices'
 * timestamps, units, method labels, and qualifier codes.
 * @module services/waterdata/observation-series
 */

import type { NwisTimeSeries, NwisValueRecord } from '@/services/waterdata/types.js';
import type { CatalogParameter } from './parameter-catalog.js';
import { toSiteLocalTimestamp } from './site-local-time.js';
import type { ResolvedSite } from './site-resolver.js';

/** One time series from `time-series-metadata`. */
export interface SeriesMetadata {
  /** Earliest observation, UTC. */
  begin: string | null;
  /** The OGC `time_series_id`. */
  id: string;
  monitoringLocationId: string;
  parameterCd: string;
  /** The series' own parameter name, for a code the parameter catalog lacks. */
  parameterName: string | null;
  statCd: string | null;
  sublocation: string | null;
  /** The series' own unit (`ft^3/s`), for a code the parameter catalog lacks. */
  unit: string | null;
  webDescription: string | null;
}

/** One `continuous` or `daily` row. */
export interface Observation {
  approvalStatus: string | null;
  monitoringLocationId: string;
  parameterCd: string;
  qualifiers: readonly string[];
  seriesId: string;
  statCd: string | null;
  /** A UTC instant (`continuous`) or a calendar date, `YYYY-MM-DD` (`daily`). */
  time: string;
  /** Null when the upstream holds no value for the time. */
  value: string | null;
}

/** What turns rows into series beyond the rows themselves. */
export interface SeriesContext {
  /** Parameter code → catalog record, the source of `unitCode` and `parameterName`. */
  parameters: ReadonlyMap<string, CatalogParameter>;
  seriesType: 'daily' | 'instantaneous';
  /** Monitoring-location ID → site, for the number, name, and clock. */
  sites: ReadonlyMap<string, ResolvedSite>;
  /** Statistic code → name, for a daily series; unused for instantaneous values. */
  statisticNames: ReadonlyMap<string, string>;
}

/** The code WaterServices wrote for an approval status. */
const APPROVAL_CODES: ReadonlyMap<string, string> = new Map([
  ['Approved', 'A'],
  ['Provisional', 'P'],
]);

/**
 * The code WaterServices wrote for each qualifier word, matched record by record between the two
 * services: ESTIMATED ↔ `e` and REVISED ↔ `R` over every record of 01646500/00060; the rest on
 * live gages reporting each word, whose WaterServices descriptions confirm the pairing. `>` is the
 * counterpart of `<` in the same code table. A word missing here has no WaterServices code and
 * passes through as written.
 */
const QUALIFIER_CODES: ReadonlyMap<string, string> = new Map([
  ['BACKWATER', 'Bkw'],
  ['DISCONTINUED', 'Dis'],
  ['DRY', 'Dry'],
  ['EQUIP', 'Eqp'],
  ['ESTIMATED', 'e'],
  ['FLOOD', 'Fld'],
  ['GREATERTHAN', '>'],
  ['ICE', 'Ice'],
  ['LESSTHAN', '<'],
  ['MAINT', 'Mnt'],
  ['RATINGDEV', 'Rat'],
  ['REVISED', 'R'],
  ['SEASONAL', 'Ssn'],
  ['UNAVAIL', '***'],
  ['ZEROFLOW', 'ZFL'],
]);

/** Approval code first, then each qualifier, as WaterServices listed them. */
function qualifierCodes(row: Observation): string[] {
  const codes = row.approvalStatus
    ? [APPROVAL_CODES.get(row.approvalStatus) ?? row.approvalStatus]
    : [];
  for (const word of row.qualifiers) codes.push(QUALIFIER_CODES.get(word) ?? word);
  return codes;
}

/**
 * WaterServices' method label: the sublocation, then the description in brackets —
 * `From multiparameter sonde, [Discontinued]`, `[Radar]`, `Met station`. Null when the series has
 * neither, as WaterServices' empty label for a site's default sensor read.
 */
export function methodLabel(
  sublocation: string | null | undefined,
  webDescription: string | null | undefined,
): string | null {
  if (!webDescription) return sublocation || null;
  return sublocation ? `${sublocation}, [${webDescription}]` : `[${webDescription}]`;
}

/** A series being built: its identity — from metadata, or from its first row — and records by time. */
interface SeriesDraft {
  identity: Pick<SeriesMetadata, 'id' | 'monitoringLocationId' | 'parameterCd' | 'statCd'>;
  metadata: SeriesMetadata | undefined;
  records: Map<number, NwisValueRecord>;
}

function record(row: Observation, context: SeriesContext, site: ResolvedSite): NwisValueRecord {
  return {
    dateTime:
      context.seriesType === 'daily'
        ? `${row.time}T00:00:00.000`
        : toSiteLocalTimestamp(row.time, site.timeZone),
    value: row.value ?? '',
    qualifiers: qualifierCodes(row),
  };
}

/**
 * One series per metadata entry — a sensor with no rows in the window stays, with no values — plus
 * one per time series that has rows but no metadata yet (the metadata refreshes at most daily).
 * Records run oldest first, one per time, so rows read twice across query chunks count once.
 * Series run by site number, parameter code, statistic code, and first observation.
 */
export function assembleSeries(
  metadata: readonly SeriesMetadata[],
  rows: readonly Observation[],
  context: SeriesContext,
): NwisTimeSeries[] {
  const drafts = new Map<string, SeriesDraft>();
  for (const m of metadata) drafts.set(m.id, { identity: m, metadata: m, records: new Map() });
  for (const row of rows) {
    const site = context.sites.get(row.monitoringLocationId);
    if (!site) continue;
    let draft = drafts.get(row.seriesId);
    if (!draft) {
      const { seriesId: id, monitoringLocationId, parameterCd, statCd } = row;
      draft = {
        identity: { id, monitoringLocationId, parameterCd, statCd },
        metadata: undefined,
        records: new Map(),
      };
      drafts.set(id, draft);
    }
    const timeMs = Date.parse(row.time);
    if (!draft.records.has(timeMs)) draft.records.set(timeMs, record(row, context, site));
  }

  const daily = context.seriesType === 'daily';
  const built: { begin: string | null; id: string; series: NwisTimeSeries }[] = [];
  for (const { identity, metadata: m, records } of drafts.values()) {
    const site = context.sites.get(identity.monitoringLocationId);
    if (!site) continue;
    const parameter = context.parameters.get(identity.parameterCd);
    const statCd = daily ? (identity.statCd ?? '') : '00000';
    built.push({
      begin: m?.begin ?? null,
      id: identity.id,
      series: {
        siteNumber: site.siteNumber,
        siteName: site.siteName ?? '',
        parameterCd: identity.parameterCd,
        parameterName: parameter?.description ?? m?.parameterName ?? '',
        unitCode: parameter?.unit ?? m?.unit ?? '',
        statCd,
        statName: daily ? (context.statisticNames.get(statCd) ?? null) : null,
        methodId: identity.id,
        methodDescription: methodLabel(m?.sublocation ?? null, m?.webDescription ?? null),
        values: [...records.entries()].sort(([a], [b]) => a - b).map(([, value]) => value),
      },
    });
  }
  return built
    .sort(
      (a, b) =>
        compare(a.series.siteNumber, b.series.siteNumber) ||
        compare(a.series.parameterCd, b.series.parameterCd) ||
        compare(a.series.statCd, b.series.statCd) ||
        compareBegin(a.begin, b.begin) ||
        compare(a.id, b.id),
    )
    .map(({ series }) => series);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A series known only from its rows began inside the window, after every listed one. */
function compareBegin(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return compare(a, b);
}

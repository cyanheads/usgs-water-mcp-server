/**
 * @fileoverview Site discovery on the USGS Water Data OGC collections, replacing the WaterServices
 * site service. Site metadata comes from `monitoring-locations`; each site's newest observation
 * comes from the latest-value collections (`latest-continuous`, `latest-daily`,
 * `latest-field-measurements`) or `peaks`, each read once with the same geographic scope — the
 * request count follows the collections a call names, never the number of sites it returns.
 * @module services/waterdata/site-discovery
 */

import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { NwisSite } from '@/services/waterdata/types.js';
import { cqlIn, cqlString } from './cql2-text.js';
import { resolveSites } from './site-resolver.js';
import { stateFipsCode } from './state-fips-codes.js';
import { failFast, fetchOgcItems, type WaterDataRequest } from './water-data-client.js';

/** A site from {@link findSites}: its metadata plus the newest observation among the series that matched. */
export interface DiscoveredSite extends NwisSite {
  /**
   * UTC instant (ISO 8601) of the newest observation among the site's matching series. A daily
   * value, field measurement, or peak carries a date only and counts from 00:00 UTC on it. Null
   * when the site has no matching series, or none with a recorded time.
   */
  lastObservedAt: string | null;
}

/** One discovery query. The calling tool supplies exactly one of bbox, stateCd, countyCd, or huc. */
export interface FindSitesParams {
  bbox?: string;
  /** 5-digit FIPS county codes, comma-separated. */
  countyCd?: string;
  /** WaterServices data-type codes, comma-separated; see {@link DATA_TYPE_CODES}. */
  hasDataTypeCd?: string;
  huc?: string;
  /** ISO 8601 duration, sent to every series collection as its `time` filter. */
  observedWithin?: string;
  /** 5-digit parameter codes, comma-separated. */
  parameterCd?: string;
  siteOutput: 'basic' | 'expanded';
  /** Site type codes, comma-separated. A major type (`ST`) includes its subtypes (`ST-CA`, …). */
  siteType?: string;
  /** Postal code, any case. */
  stateCd?: string;
}

/** The series a site's observations are read from. */
type SeriesSource = 'continuous' | 'daily' | 'fieldMeasurements' | 'groundwaterLevels' | 'peaks';

const SERIES_COLLECTIONS: Record<SeriesSource, { clause?: string; collection: string }> = {
  continuous: { collection: 'latest-continuous' },
  daily: { collection: 'latest-daily' },
  fieldMeasurements: { collection: 'latest-field-measurements' },
  // Every groundwater-level procedure the collection lists reads "GW level, <method>" (steel tape,
  // electric tape, logs, airline, …); discharge and gage-height measurements carry other names.
  groundwaterLevels: {
    collection: 'latest-field-measurements',
    clause: "observing_procedure LIKE 'GW level%'",
  },
  peaks: { collection: 'peaks' },
};

/**
 * The `hasDataTypeCd` codes with a source on the Water Data APIs, WaterServices' aliases for `iv`
 * included. The others WaterServices took have none: `qw` moved to the samples API, `sv` site
 * visits carry no period of record, and `ad`, `aw`, `id` have no counterpart.
 */
const DATA_TYPE_SOURCES: ReadonlyMap<string, SeriesSource> = new Map([
  ['iv', 'continuous'],
  ['uv', 'continuous'],
  ['rt', 'continuous'],
  ['dv', 'daily'],
  ['gw', 'groundwaterLevels'],
  ['pk', 'peaks'],
]);

/** The accepted `hasDataTypeCd` codes as messages and descriptions name them. */
export const DATA_TYPE_CODES = '"iv" (aliases "uv", "rt"), "dv", "gw", "pk"';

/**
 * Series read when `hasDataTypeCd` is omitted. Peaks are left out: every peak is also a
 * continuous, daily, or field-measured value at its site, and the collection holds one row per
 * peak, not one per series.
 */
const DEFAULT_SOURCES: readonly SeriesSource[] = ['continuous', 'daily', 'fieldMeasurements'];

/** `limit` per page; the collections honor 50 000 although their OpenAPI documents advertise 10 000. */
const PAGE_SIZE = '50000';

const BASIC_PROPERTIES = [
  'monitoring_location_number',
  'monitoring_location_name',
  'site_type_code',
  'altitude',
  'hydrologic_unit_code',
];
const EXPANDED_PROPERTIES = [
  ...BASIC_PROPERTIES,
  'state_code',
  'county_code',
  'drainage_area',
  'contributing_drainage_area',
];

/** A site type code, after uppercasing: a major type (`ST`) or a subtype (`ST-CA`). */
const SITE_TYPE_CODE = /^[A-Z]{2}(-[A-Z]+)?$/;

const NullableText = z.string().nullish();
const NullableNumber = z.number().nullish();

const LocationSchema = z.object({
  id: z.string().min(1),
  geometry: z.object({ coordinates: z.array(z.number()).min(2) }).nullish(),
  properties: z.object({
    monitoring_location_number: z.string(),
    monitoring_location_name: NullableText,
    site_type_code: NullableText,
    altitude: NullableNumber,
    hydrologic_unit_code: NullableText,
    state_code: NullableText,
    county_code: NullableText,
    drainage_area: NullableNumber,
    contributing_drainage_area: NullableNumber,
  }),
});
type Location = z.infer<typeof LocationSchema>;

const ObservationSchema = z.object({
  properties: z.object({
    monitoring_location_id: z.string().min(1),
    // Instants on latest-continuous; dates on latest-daily, latest-field-measurements, and peaks.
    time: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).nullish(),
  }),
});

/** The geographic and site-type scope every collection a call reads shares. */
interface Scope {
  clauses: string[];
  pairs: [string, string][];
}

function invalid(message: string) {
  return validationError(message, { reason: 'invalid_request' });
}

/** `site_type_code` terms: a major type takes its subtypes, as WaterServices did; a subtype only itself. */
function siteTypeClause(siteType: string): string {
  return siteType
    .split(',')
    .map((raw) => {
      const code = raw.trim().toUpperCase();
      if (!SITE_TYPE_CODE.test(code)) {
        throw invalid(
          `siteType "${raw.trim()}" is not a site type code — two letters (e.g. "ST"), optionally with a subtype (e.g. "ST-CA").`,
        );
      }
      return code.includes('-')
        ? `site_type_code=${cqlString(code)}`
        : `site_type_code=${cqlString(code)} OR site_type_code LIKE ${cqlString(`${code}-%`)}`;
    })
    .join(' OR ');
}

/** Translate the WaterServices-shaped filters onto OGC queryables; rejects a value with no translation. */
function scopeOf(params: FindSitesParams): Scope {
  const pairs: [string, string][] = [];
  const clauses: string[] = [];
  if (params.bbox) pairs.push(['bbox', params.bbox]);
  if (params.stateCd) {
    const fips = stateFipsCode(params.stateCd);
    if (!fips) {
      throw invalid(`stateCd "${params.stateCd}" is not a US state or territory postal code.`);
    }
    pairs.push(['state_code', fips]);
  }
  if (params.countyCd) {
    clauses.push(
      params.countyCd
        .split(',')
        .map(
          (fips) =>
            `(state_code=${cqlString(fips.slice(0, 2))} AND county_code=${cqlString(fips.slice(2))})`,
        )
        .join(' OR '),
    );
  }
  // A plain value matches every HUC that starts with it, as the WaterServices filter did.
  if (params.huc) pairs.push(['hydrologic_unit_code', params.huc]);
  if (params.siteType) clauses.push(siteTypeClause(params.siteType));
  return { pairs, clauses };
}

function seriesSources(hasDataTypeCd: string | undefined): readonly SeriesSource[] {
  if (hasDataTypeCd === undefined) return DEFAULT_SOURCES;
  const sources = new Set<SeriesSource>();
  for (const raw of hasDataTypeCd.split(',')) {
    const source = DATA_TYPE_SOURCES.get(raw.trim().toLowerCase());
    if (!source) {
      throw invalid(
        `hasDataTypeCd "${raw.trim()}" has no source in the USGS Water Data APIs. Accepted codes: ${DATA_TYPE_CODES}.`,
      );
    }
    sources.add(source);
  }
  return [...sources];
}

function buildQuery(pairs: [string, string][], clauses: string[], properties: string[]) {
  const query = new URLSearchParams(pairs);
  if (clauses.length > 0) {
    query.set('filter-lang', 'cql2-text');
    query.set('filter', clauses.map((clause) => `(${clause})`).join(' AND '));
  }
  query.set('properties', properties.join(','));
  query.set('limit', PAGE_SIZE);
  return query;
}

/** A date-only time counts from 00:00 UTC on that date. */
function toInstant(time: string): string {
  return new Date(time.length === 10 ? `${time}T00:00:00Z` : time).toISOString();
}

/**
 * Each site's newest observation across `sources`, keyed by monitoring location id. A site with a
 * matching series but no recorded time maps to null; a site without one is absent.
 */
async function newestObservations(
  scope: Scope,
  sources: readonly SeriesSource[],
  parameterCds: string[] | undefined,
  observedWithin: string | undefined,
  request: WaterDataRequest,
): Promise<Map<string, string | null>> {
  const pages = await Promise.all(
    sources.map((source) => {
      const { collection, clause } = SERIES_COLLECTIONS[source];
      const pairs = [...scope.pairs];
      const clauses = [...scope.clauses];
      if (clause) clauses.push(clause);
      if (parameterCds) {
        const [only, ...more] = parameterCds;
        if (only !== undefined && more.length === 0) pairs.push(['parameter_code', only]);
        else clauses.push(cqlIn('parameter_code', parameterCds));
      }
      if (observedWithin) pairs.push(['time', observedWithin]);
      pairs.push(['skipGeometry', 'true']);
      const query = buildQuery(pairs, clauses, ['monitoring_location_id', 'time']);
      return fetchOgcItems(collection, query, ObservationSchema, request);
    }),
  );
  const newest = new Map<string, string | null>();
  for (const { properties } of pages.flat()) {
    const id = properties.monitoring_location_id;
    const instant = properties.time ? toInstant(properties.time) : null;
    const prior = newest.get(id);
    // ISO instants in UTC compare correctly as strings.
    if (prior === undefined || (instant !== null && (prior === null || instant > prior))) {
      newest.set(id, instant);
    }
  }
  return newest;
}

/** Map a location to the site shape, in the key order the WaterServices reader produced. */
function toSite(location: Location, siteOutput: 'basic' | 'expanded'): NwisSite {
  const p = location.properties;
  const expanded = siteOutput === 'expanded';
  // The output requires coordinates; a location without geometry reports 0, 0, as WaterServices
  // did for a blank dec_lat_va/dec_long_va.
  const [longitude = 0, latitude = 0] = location.geometry?.coordinates ?? [];
  return {
    siteNumber: p.monitoring_location_number,
    siteName: p.monitoring_location_name ?? '',
    siteType: p.site_type_code ?? '',
    latitude,
    longitude,
    ...(expanded && p.state_code ? { stateCd: p.state_code } : {}),
    ...(expanded && p.county_code ? { countyCd: p.county_code } : {}),
    ...(expanded && p.drainage_area != null ? { drainageArea: p.drainage_area } : {}),
    ...(p.altitude != null ? { altitude: p.altitude } : {}),
    ...(expanded && p.contributing_drainage_area != null
      ? { contributingArea: p.contributing_drainage_area }
      : {}),
    ...(p.hydrologic_unit_code ? { hucCd: p.hydrologic_unit_code } : {}),
  };
}

/** Site number first, then location id, so two agencies' records of one number keep a fixed order. */
function byNumberThenId(a: Location, b: Location): number {
  const an = a.properties.monitoring_location_number;
  const bn = b.properties.monitoring_location_number;
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Find monitoring locations in one geographic scope, every agency's included. `monitoring-locations`
 * lists the sites; each series collection the call needs (by `hasDataTypeCd`, or continuous, daily,
 * and field measurements when it is omitted) is read once in parallel for `lastObservedAt`. When
 * `parameterCd`, `hasDataTypeCd`, or `observedWithin` is set, only sites with a matching series
 * remain. Filter values with no translation fail before any request is sent, and the first
 * failing read stops the call's other page walks.
 *
 * @throws {McpError} `ValidationError` (`invalid_request`) for an unknown stateCd, a malformed
 * siteType, or a hasDataTypeCd with no source; otherwise whatever the Water Data client raises.
 */
export function findSites(
  params: FindSitesParams,
  request: WaterDataRequest,
): Promise<DiscoveredSite[]> {
  return failFast(request, async (scoped) => {
    const scope = scopeOf(params);
    const sources = seriesSources(params.hasDataTypeCd);
    const properties = params.siteOutput === 'expanded' ? EXPANDED_PROPERTIES : BASIC_PROPERTIES;
    const [locations, newest] = await Promise.all([
      fetchOgcItems(
        'monitoring-locations',
        buildQuery(scope.pairs, scope.clauses, properties),
        LocationSchema,
        scoped,
      ),
      newestObservations(
        scope,
        sources,
        params.parameterCd?.split(','),
        params.observedWithin,
        scoped,
      ),
    ]);
    const narrowed =
      params.parameterCd !== undefined ||
      params.hasDataTypeCd !== undefined ||
      params.observedWithin !== undefined;
    const sites: DiscoveredSite[] = [];
    for (const location of locations.sort(byNumberThenId)) {
      const lastObservedAt = newest.get(location.id);
      if (narrowed && lastObservedAt === undefined) continue;
      sites.push({
        ...toSite(location, params.siteOutput),
        lastObservedAt: lastObservedAt ?? null,
      });
    }
    return sites;
  });
}

/**
 * Expanded metadata for one site number, whichever agency holds it (the resolver's choice when
 * several do). Null when no monitoring location has the number.
 */
export async function getSite(
  siteNumber: string,
  request: WaterDataRequest,
): Promise<NwisSite | null> {
  const resolved = (await resolveSites([siteNumber], request)).get(siteNumber);
  if (!resolved) return null;
  const locations = await fetchOgcItems(
    'monitoring-locations',
    buildQuery([['monitoring_location_number', siteNumber]], [], EXPANDED_PROPERTIES),
    LocationSchema,
    request,
  );
  const location = locations.find((l) => l.id === resolved.monitoringLocationId);
  return location ? toSite(location, 'expanded') : null;
}

/**
 * @fileoverview Domain types the USGS Water Data service layer hands to the tools: sites, time
 * series, and percentile classes. The `Nwis` prefix names the data system, NWIS, that the Water
 * Data APIs serve.
 * @module services/waterdata/types
 */

/** A single USGS monitoring site, from the OGC `monitoring-locations` collection. */
export interface NwisSite {
  /** Altitude of the gage datum in feet above sea level. Present in both basic and expanded modes when USGS records an altitude for the site. */
  altitude?: number;
  /** Contributing drainage area in square miles. Present only when fetched with siteOutput=expanded. */
  contributingArea?: number;
  /** County FIPS code (3 digits). Present only when fetched with siteOutput=expanded. */
  countyCd?: string;
  /** Drainage area in square miles. Present only when fetched with siteOutput=expanded. */
  drainageArea?: number;
  /**
   * Hydrologic Unit Code of the watershed containing the site. Length varies by the level USGS
   * assigned — 8-digit (HUC8) and 12-digit (HUC12) values are both common, so no fixed width can
   * be assumed. Not directly reusable as a `huc` query filter, which accepts 2 or 8 digits only.
   * Omitted when the site has no HUC (present in both basic and expanded modes otherwise).
   */
  hucCd?: string;
  /** Decimal latitude. */
  latitude: number;
  /** Decimal longitude. */
  longitude: number;
  /** Human-readable site name. */
  siteName: string;
  /** USGS site number (8–15 digits). */
  siteNumber: string;
  /** Site type code (e.g. ST, GW, LK). */
  siteType: string;
  /** State FIPS code (2 digits). Present only when fetched with siteOutput=expanded. */
  stateCd?: string;
}

/** A single time-series value record. */
export interface NwisValueRecord {
  /**
   * Instantaneous values: the site's local time with milliseconds and offset
   * (`2026-11-11T02:50:00.000-05:00`, daylight time included), or UTC (`+00:00`) for a site with
   * no known time zone. Daily values: the calendar day, `YYYY-MM-DDT00:00:00.000`.
   */
  dateTime: string;
  /**
   * Approval code first — `A` approved, `P` provisional — then a code per qualifier: `e`
   * estimated, `R` revised, `Ssn` seasonal, `Dis` discontinued, `Eqp` equipment, `Ice`, `Bkw`
   * backwater, `Fld` flood, `Dry`, `Mnt` maintenance, `Rat` rating being developed, `ZFL` zero
   * flow, `***` unavailable, `<` / `>` less / greater than the value. A qualifier with no such code
   * keeps the upstream word (`OTHERAGENCY`, `FORCEINTERPOLATION`, …).
   */
  qualifiers: string[];
  /**
   * Measured value as a string, as the upstream writes it. Empty when the upstream holds no value
   * for the time — a seasonal, discontinued, dry, or malfunctioning gage — whose qualifiers then
   * name the reason.
   */
  value: string;
}

/**
 * One time series for a site + parameter + statistic + method (sensor), instantaneous or daily.
 *
 * A site can measure one parameter with several sensors or at several sublocations, and a daily
 * series exists per statistic, so one query can yield several of these. Every series the site's
 * time-series metadata lists for the query is returned, including one with no values in the
 * window.
 */
export interface NwisTimeSeries {
  /**
   * The series' label: its sublocation, then its description in brackets —
   * "From multiparameter sonde, [Discontinued]", "[Radar]", "Met station". Null when the series has
   * neither, as for the default series at most single-sensor sites.
   */
  methodDescription: string | null;
  /**
   * The series' OGC `time_series_id` (32 hex digits), the identifier the site data catalog lists
   * as `timeSeriesId`. An instantaneous series and each daily statistic computed from it have
   * different IDs.
   */
  methodId: string | null;
  /** Parameter code (e.g. "00060"). */
  parameterCd: string;
  /** Parameter description from the USGS parameter-code catalog (e.g. "Discharge, cubic feet per second"). */
  parameterName: string;
  /** Human-readable site name. */
  siteName: string;
  /** Site number, as requested. */
  siteNumber: string;
  /** Statistic code: "00000" for instantaneous values, "00003" for a daily mean, etc. */
  statCd: string;
  /**
   * Name of a daily series' statistic from the USGS statistic-code table, in sentence case
   * ("Mean", "Maximum", "Minimum", "Median", "Sum"); null for instantaneous values and for a code
   * the table lacks.
   */
  statName: string | null;
  /** Unit from the USGS parameter-code catalog (e.g. "ft3/s", "deg C"). */
  unitCode: string;
  /** Value records, oldest first. */
  values: NwisValueRecord[];
}

/** Condition classification based on percentile comparison. */
export type PercentileClass =
  | 'record-high'
  | 'above-normal'
  | 'normal'
  | 'below-normal'
  | 'low'
  | 'record-low'
  | 'unknown';

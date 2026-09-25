/**
 * @fileoverview Domain types for the USGS NWIS service layer.
 * @module services/nwis/types
 */

/** A single USGS monitoring site returned from the site service. */
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
   * Hydrologic Unit Code of the watershed containing the site. Length varies by the level NWIS
   * assigned — 8-digit (HUC8) and 12-digit (HUC12) values are both common, so no fixed width can
   * be assumed. Not directly reusable as a `huc` query filter, which accepts 2 or 8 digits only.
   * Omitted when NWIS assigns the site no HUC (present in both basic and expanded modes otherwise).
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
  /** ISO 8601 date-time string. */
  dateTime: string;
  /** Data qualifier codes (e.g. ["P"] for provisional, ["A"] for approved). */
  qualifiers: string[];
  /**
   * Measured value as a string (NWIS returns strings). Empty when NWIS reported no value — a blank
   * record, or one holding the series' no-data value (`-999999`), whose qualifiers then name the
   * reason (e.g. `Ssn` seasonal, `Dis` discontinued, `Dry`, `Eqp` equipment).
   */
  value: string;
}

/**
 * One method's time series for a site + parameter + statistic (IV or DV).
 *
 * A WaterML `timeSeries` carries one `values[]` block per method — a distinct sensor or
 * measurement location for the same parameter — so one upstream `timeSeries` can yield several of
 * these. The daily-values service also returns one `timeSeries` per statistic code.
 */
export interface NwisTimeSeries {
  /**
   * NWIS method description for this block (HTML entities decoded), e.g. "From multiparameter
   * sonde" or "[(2)]". Null when NWIS labels the method with an empty string, which it does for
   * the default series at most single-sensor sites.
   */
  methodDescription: string | null;
  /**
   * NWIS method ID of this block, as a string. Scoped to the service that returned it: an IV
   * method ID, a DV method ID, and the stat service's `ts_id` for the same sensor are different
   * numbers. Null only when the upstream `timeSeries` carried no method block at all.
   */
  methodId: string | null;
  /** Parameter code (e.g. "00060"). */
  parameterCd: string;
  /** Human-readable parameter name. */
  parameterName: string;
  /** Human-readable site name. */
  siteName: string;
  /** USGS site number. */
  siteNumber: string;
  /** NWIS statistic code: "00000" for instantaneous values, "00003" for a daily mean, etc. */
  statCd: string;
  /** Statistic name NWIS attaches to the code (e.g. "Mean", "Maximum"); null when it gives none, as for instantaneous values. */
  statName: string | null;
  /** Unit code (e.g. "ft3/s"). */
  unitCode: string;
  /** Value records. */
  values: NwisValueRecord[];
}

/** A single row from the NWIS stat (percentile) service. */
export interface NwisStatRow {
  /** Start year of the period of record. */
  beginYr: number;
  /** Count of observations. */
  countNu: number;
  /** Day number (1–31). */
  dayNu: number;
  /** End year of the period of record. */
  endYr: number;
  /** Maximum value. */
  maxVa: number | null;
  /** Mean value. */
  meanVa: number | null;
  /** Minimum value. */
  minVa: number | null;
  /** Month number (1–12). */
  monthNu: number;
  /** 5th percentile. */
  p05: number | null;
  /** 10th percentile. */
  p10: number | null;
  /** 25th percentile. */
  p25: number | null;
  /** 50th percentile (median). */
  p50: number | null;
  /** 75th percentile. */
  p75: number | null;
  /** 95th percentile. */
  p95: number | null;
  /**
   * Location description of the time series these statistics were computed from (`loc_web_ds`),
   * e.g. "From multiparameter sonde". Null when NWIS leaves it blank.
   */
  seriesDescription: string | null;
  /**
   * Stat-service time-series ID (`ts_id`) — the daily-mean series the percentiles come from. Not
   * the IV method ID of the same sensor; NWIS numbers the two independently. Null when absent.
   */
  tsId: string | null;
}

/** Result from the stats service for a site+parameter. */
export interface NwisStatResult {
  parameterCd: string;
  rows: NwisStatRow[];
  siteNumber: string;
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

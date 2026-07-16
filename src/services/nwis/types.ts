/**
 * @fileoverview Domain types for the USGS NWIS service layer.
 * @module services/nwis/types
 */

/** A single USGS monitoring site returned from the site service. */
export interface NwisSite {
  /** Altitude of the gage datum in feet above sea level. Present only when fetched with siteOutput=expanded. */
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
   */
  hucCd: string;
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
  /** Measured value as a string (NWIS returns strings; may be empty for missing data). */
  value: string;
}

/** A time series for a site+parameter combination (IV or DV). */
export interface NwisTimeSeries {
  /** Parameter code (e.g. "00060"). */
  parameterCd: string;
  /** Human-readable parameter name. */
  parameterName: string;
  /** Human-readable site name. */
  siteName: string;
  /** USGS site number. */
  siteNumber: string;
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

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

/**
 * The series a site publishes per parameter: daily statistics, instantaneous (continuous) values,
 * field measurements (`field-measurements`: hand-measured well levels, discharge and gage-height
 * measurements), and annual peaks (`peaks`).
 */
export const SERIES_TYPES = ['daily', 'instantaneous', 'field', 'peak'] as const;
export type SeriesType = (typeof SERIES_TYPES)[number];

/** A record of a field-measurement or annual-peak series: one dated measurement, not a reading on a clock. */
interface MeasurementRecord extends NwisValueRecord {
  /**
   * The measurement's UTC instant written on the site's clock, like an instantaneous value
   * (`2026-08-05T09:15:00.000-04:00`), when the upstream records a time of day. Otherwise the bare
   * date the upstream records (`2000-09-08`). The upstream's date is the UTC date, so a measurement
   * taken in the site's evening can carry the next day's date beside an earlier local time.
   */
  dateTime: string;
  /**
   * The coarsest part of the date the upstream does not know, which `dateTime` fills with 01:
   * `month` (the year alone is known — `1958-01-01`), `day` (the year and month — `1964-03-01`).
   * Null when the whole date is known.
   */
  unknownDatePart: 'month' | 'day' | null;
}

/** One field measurement. */
export interface FieldValueRecord extends MeasurementRecord {
  /** Stream-channel control condition at a gage visit (`Clear`, `Debris - Light`, `Ice - Cover`, …); null when unrecorded, as at wells. */
  controlCondition: string | null;
  /**
   * Rating of the discharge measurement the record comes from — its discharge or mean gage height
   * (`Excellent`, `Good`, `Fair`, `Poor`, `Unspecified`); null otherwise.
   */
  measurementRated: string | null;
  /** How the value was measured, as the upstream writes it (`GW level, calib electric tape`); null when unstated. */
  observingProcedure: string | null;
  /**
   * Approval code first (`A`, `P`), then each qualifier — coded as for instantaneous values where
   * a code exists, otherwise the upstream word as written (`Static`, `Pumping`).
   */
  qualifiers: string[];
}

/** One annual peak. Peaks carry no approval status. */
export interface PeakValueRecord extends MeasurementRecord {
  /** Year since which this is the highest peak, when the upstream states one (`1889`); null otherwise. */
  peakSince: number | null;
  /**
   * The peak's qualifiers, coded as for instantaneous values where a code exists (`<` less than,
   * `R` revised) and otherwise the upstream word (`MONTHUNKNOWN`, `DIFFDATUM`, `BLWMIN`,
   * `UNKNOWNREGULATION`). No approval code.
   */
  qualifiers: string[];
  /** Water year of the peak (October through September, named for the year it ends in); null when unstated. */
  waterYear: number | null;
}

/** The fields a field-measurement or annual-peak series shares with {@link NwisTimeSeries}. */
type MeasurementSeriesBase = Omit<NwisTimeSeries, 'methodId' | 'statCd' | 'statName' | 'values'>;

/**
 * One field-measurement series: a site, parameter, and reading type. One site and parameter can
 * hold several — at a stream gage, gage height read off the reference gage (`ReferencePrimary`)
 * and the mean gage height of each discharge measurement (`MeanGageHeight`) are two.
 */
export interface FieldSeries extends MeasurementSeriesBase {
  /**
   * The series' label: its sublocation, then its reading type in brackets, as
   * {@link NwisTimeSeries.methodDescription} composes one (`[ReferencePrimary]`).
   */
  methodDescription: string | null;
  /** The `field-measurements-metadata` series ID (a UUID), the catalog's `timeSeriesId` for the series. */
  methodId: string;
  /** Reading type as the upstream writes it (`ReferencePrimary`, `MeanGageHeight`, `Discharge`); null when unstated. */
  readingType: string | null;
  seriesType: 'field';
  statCd: null;
  statName: null;
  /** Records oldest first. */
  values: FieldValueRecord[];
}

/** One annual-peak series: the `time-series-metadata` series computed `Max At Event Time`. */
export interface PeakSeries extends MeasurementSeriesBase {
  /** The OGC `time_series_id` (32 hex digits), the catalog's `timeSeriesId` for the series. */
  methodId: string;
  seriesType: 'peak';
  statCd: null;
  statName: null;
  /** Records oldest first. */
  values: PeakValueRecord[];
}

/** Any series {@link SeriesType} names; field and peak series carry `seriesType`, the others none. */
export type ObservedSeries = NwisTimeSeries | FieldSeries | PeakSeries;

/** Condition classification based on percentile comparison. */
export type PercentileClass =
  | 'record-high'
  | 'above-normal'
  | 'normal'
  | 'below-normal'
  | 'low'
  | 'record-low'
  | 'unknown';

---
name: usgs-water-guide
description: Gates and workflows for the water_* tools over USGS stream gages and groundwater wells. Covers whether a river or aquifer is high or low right now, telling live gages from discontinued ones, reading depth-to-water rankings (a shallower depth ranks higher), finding the parameter code a site actually reports, time zones and data lag, and SQL over staged series. Use when answering questions about USGS streamflow, gage height, groundwater levels, or water-quality sensors.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

Keyless USGS data from stream gages, lakes, springs, and wells: real-time instantaneous values, daily statistics, field measurements (values measured by hand on a site visit, such as a well's groundwater level), annual peaks, site and series metadata, and daily percentiles computed over each site's record.

Not covered:

- **Place names and radius search.** Geocode elsewhere, then build a `bbox` around the point.
- **Flood stage, flood categories, forecasts.** water_get_conditions ranks a reading against the site's own history only. Pair with a National Weather Service source for flood thresholds.
- **Lab water-quality samples.** Only a site's continuous sensors, field measurements, and annual peaks return values here.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| Site number (8–15 digits, a string with leading zeros; wells are usually 15) | water_find_sites | every site tool |
| `countyCd` (5-digit FIPS) | expanded water_find_sites rows: `stateCd` (2-digit FIPS) followed by `countyCd` (3 digits), e.g. `24` + `047` → `24047`; or a FIPS lookup outside this server | water_find_sites |
| `stateCd` input (2 letters, `MD`) | the user | water_find_sites. The output `stateCd` is the FIPS number and is not accepted back |
| `huc` (2 or 8 digits) | first 8 digits of a site's `hucCd` | water_find_sites |
| Parameter code (5 digits) | water_list_parameters; better, the site's own rows in water_get_site_data_catalog | every data tool |
| `methodId` (a 32-character time-series ID; a field series' is a 36-character hyphenated UUID) | `methodId` / `otherSeries[].methodId` in water_get_readings or water_get_series, or `timeSeriesId` on a water_get_site_data_catalog row of the same `seriesType`. Daily and instantaneous IDs differ for the same sensor, and a site holds one field series per `readingType` | water_get_series |
| `canvas_id` + table name | a truncated water_get_series or water_find_sites response | water_dataframe_describe, water_dataframe_query |

## Gates

**A listed site is not a live site.** `parameterCd` and `hasDataTypeCd` on water_find_sites match every site that has ever reported that data, so `hasDataTypeCd: "iv"` matches a gage whose record ended in 1996 or 2019 as readily as a live one. Dormant sites are often a large share of a result. Every row carries `lastObservedAt`, the UTC time of the site's newest observation among the series the filters select (null when it has none, or none with a recorded time), and `observedWithin`, an ISO 8601 duration such as `"P7D"`, keeps only sites whose `lastObservedAt` falls inside it. Set `observedWithin` when the question is about now. Daily values carry a date only, as does a field measurement or peak with no recorded time of day, and daily values publish a day or two late, so a window under `"P3D"` can drop a site that reports daily values only. A site last observed by a field measurement or peak is kept by its date, so its `lastObservedAt` can fall up to a day before the window starts. `parameterCd` does not match discrete water-quality samples. Before reporting current conditions for an area, keep only sites that report now:

- A water_get_readings call accepts up to 500 site numbers but reads only the first 100 distinct ones, in input order; the rest come back in `deferredSites`, and resubmitting them as `sites` reads the next batch. A deferred site was not checked: it is in neither the readings nor `missingSites`.
- In a water_get_readings batch, a site whose sensor reported nothing in the period comes back as a series with `totalValues: 0`, even when every site read is dormant, and a site read with no series at all (a nonexistent number, or a real well with no continuous series of the parameter) is listed once in `missingSites`. The call fails with `no_data_for_parameter` only when no site read returns a series and none was deferred.
- water_get_site_data_catalog shows when each series ended (`endDate`), and the row's `webDescription` or a `methodDescription` such as `[Discontinued 10/30/2019]` names a retired sensor.

**water_get_conditions looks back two hours.** It takes up to 500 site numbers and one parameter, ranks the first 100 distinct ones, and returns the rest in `deferredSites`. A site read with no reading in the last two hours is listed in `missingSites`, whether it reported this morning, is dormant, never measured the parameter, or does not exist; the call fails with `no_data_for_parameter` only when no site read has a reading and none was deferred. With one site the message tells the cases apart: a silent gage's says the site reports the parameter but sent no value in the window and points to water_get_readings with a longer period, a nonexistent site's says no monitoring location has the number; with several sites one message names every site. To tell a listed site's case apart, call water_get_readings with `period: "P1D"` or `"P7D"`, or read water_get_site_data_catalog: `not_found` means no such site, an empty `series` list means the parameter was never measured, and `endDate` is the last report.

**Unknown site or no data?** water_get_series answers a nonexistent site number with the same `no_data_for_range` reason a real site with no data gets, and water_get_conditions lists it in `missingSites` beside the real sites with no recent reading (a call that finds none fails with `no_data_for_parameter`; for one site only that message says no monitoring location has the number). water_get_site_data_catalog returns `not_found` for a site that doesn't exist.

**A well has continuous-sensor values, hand-measured values, or both.** With only `siteType: "GW"` and `parameterCd: "72019"`, water_find_sites returns every well that ever reported, and the wells measured by hand usually far outnumber the instrumented ones. For a live sensor, add `hasDataTypeCd: "iv"` and `observedWithin`, or confirm each well has recent values; water_get_readings and water_get_conditions read continuous sensors only, so a hand-measured well returns nothing from them. For hand-measured levels, filter with `hasDataTypeCd: "gw"` and call water_get_series with `seriesType: "field"`; the well's water_get_site_data_catalog rows with `seriesType` `field` give the date range, and each reading type (`readingType`) is its own series with its own `methodId`. A field series has no statistic: omit `statCd`. A field measurement is one value on one visit, so a series is sparse and carries no daily percentile ranking.

**Depth to water (72019) ranks as a water level.** The value is feet below land surface, so a larger number means a lower water table, and `currentValue` stays the depth as measured. water_get_conditions ranks the water level, not the depth: a shallower depth ranks higher, `p95` is the day's shallowest depth and `p05` the deepest, and `percentileClass` reads as it does for discharge. `record-high` or `above-normal` means the water table is unusually high (shallow), and `below-normal`, `low`, or `record-low` means it is unusually low (deep). `percentileLabel` and `comparisonBasis` say the depth is ranked as a water level. The same holds for the other depth-below-surface codes (30210, 99019, 72276); elevation codes (62610, 72020, 72150) rise with the water and rank as they are. The ranking is water_get_conditions' alone: water_get_series returns every depth as measured, a hand-measured one included, so there a larger number is a deeper water table and nothing is inverted.

**Percentile classes are not floods or droughts.** `record-high` means at or above the 95th percentile of daily means for that calendar day, not a record and not flood stage. For "is the river high", rank discharge (00060); gage height (00065) often has no percentile record (`historicalContextStatus: "no_record"`).

**Provisional values can change.** Recent values carry `P` and older reviewed values carry `A`; other codes such as `e` (estimated) can ride alongside (`A,e`). Say a recent value is provisional when it drives a conclusion, especially a claim about a record.

**Find the parameter code at the site.** A water_list_parameters search for a property returns many codes; "turbidity" matches dozens across units and methods (JTU, NTU, FNU, lab, field). Read the site's unfiltered water_get_site_data_catalog page to see which code it actually reports (the Potomac at Little Falls reports turbidity as 63680, FNU). Then filter by that code. A search returns 25 entries a page: pass the response's `nextOffset` as `offset`, with the same query and limit, for the next page, or add words to narrow it.

**A bounding box has no area limit.** A large box returns its matches 25 per response, or up to 500 with `limit` (`truncated`, `upstreamTotal`, `offset`); past 500, with DataCanvas enabled, the full set also stages as a table. Narrow with `siteType`, `parameterCd`, or `observedWithin` rather than by shrinking the box.

## Time and record conventions

- **Instantaneous timestamps carry each site's own UTC offset.** Sites in one state can differ: New Mexico wells in one response read `-06:00` and `-07:00`. Compare instants, not clock strings. A site with no known time zone reports in UTC, offset `+00:00`. Daily `dateTime` is a bare date at midnight with no offset. A field or peak `dateTime` is the instant on the site's clock when a time of day was recorded, and a bare `YYYY-MM-DD` when not; `unknownDatePart` (`month` or `day`) marks a date USGS filled in to the 1st, and the site-local date can be a day before the upstream's UTC date.
- **water_get_series dates are site-local calendar days, and `endDate` is inclusive.** An instantaneous request for one date returns 00:00 through the last reading before midnight, local time.
- **Daily values lag.** The newest daily value is from yesterday at best; today has no daily mean yet. Today's level comes from water_get_readings or an instantaneous series.
- **Reporting intervals vary by site,** from every minute to hourly. A 5-minute gage produces 288 records a day and a 1-minute gage 1,440, so a few days of instantaneous data is usually staged rather than returned whole inline; check `truncated`.
- **Catalog bounds are UTC and lag.** A current series' `endDate` can trail the latest reading by most of a day. A parameter can have several rows over time when a sensor was replaced: a discontinued row followed by a current one. "Since when" is the earliest `beginDate` across that parameter's rows, and gaps between rows are real gaps.

## Workflows

**Is the river near a place running high right now?**
1. Get coordinates elsewhere. Call water_find_sites with a small `bbox`, `siteType: "ST"`, `parameterCd: "00060"`, `hasDataTypeCd: "iv"`, `observedWithin: "P1D"`.
2. Pass the candidate site numbers (up to 500, of which the first 100 distinct are read; resubmit `deferredSites` for the rest) to water_get_readings with `parameterCd: ["00060"]`. Keep the series with values.
3. Pass the gages with values to water_get_conditions with 00060, in one call for up to 100 (`conditions` has one row per gage with a reading in the last two hours; `missingSites` and `deferredSites` name the rest). Report each value, `percentileClass`, the period of record, and the provisional flag.

**Groundwater levels in a county.**
1. Call water_find_sites with `countyCd`, `siteType: "GW"`, `parameterCd: "72019"`, `hasDataTypeCd: "iv"`, `observedWithin: "P1D"`.
2. Pass the well numbers to water_get_readings with `parameterCd: ["72019"]`. Drop wells with `totalValues: 0` and wells listed in `missingSites`; a `no_data_for_parameter` error means none of the wells read has a 72019 series. Resubmit `deferredSites` past the first 100.
3. Pass the remaining wells to water_get_conditions with 72019 (up to 100 per call) and report each water level as the depth gate above reads it: a shallower depth ranks higher.

**Levels measured by hand in a well.** Call water_find_sites with `siteType: "GW"`, `parameterCd: "72019"`, `hasDataTypeCd: "gw"`, then water_get_series per well with `seriesType: "field"` over the dates the site's catalog rows of `seriesType` `field` give. The values are depths as measured, one per site visit.

**Is a property measured at a site, and since when?**
1. Call water_get_site_data_catalog for the site with no `parameterCd`, and follow `nextCursor` until it is null.
2. Pick the code from the rows, then filter the catalog by it to read the bounds per sensor and statistic.
3. Hand the dates to water_get_series.

**Long series and SQL.** Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `water_dataframe_describe` with it for the staged table and column names before writing SQL, then `water_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

On a staged series, `value` is a number (DOUBLE, NULL for a no-data record) and `date_time` is the site-local text (VARCHAR):
- Aggregate `value` directly: `MAX(value)`, `AVG(value)`. Group by period with `substr(date_time, 1, 7)` for months.
- Every table but a daily one ends with `time_utc`, the UTC instant as fixed-width text ending in `Z` (NULL on a field or peak record with no time of day). It sorts chronologically as text. Compare it with the clock as `WHERE CAST(time_utc AS TIMESTAMPTZ) > now() - INTERVAL 6 HOUR`; cast to TIMESTAMPTZ, since a plain TIMESTAMP compared with `now()` is off by the host's UTC offset without an error. Don't compare `date_time` with `now()`: its offset varies by site.
- Field tables add `observing_procedure`, `measurement_rated`, `control_condition`, and `unknown_date_part`; peak tables add `water_year`, `peak_since`, and `unknown_date_part`. Table names mark the series type: `dv` daily, `iv` instantaneous, `fm` field, `pk` peak.
- `qualifiers` is a comma-joined string.

**Several sensors for one parameter.** When water_get_readings lists more than one method for a site and parameter, choose by `methodDescription` (sonde, depth, `[Discontinued]`). Pass the `methodId` from water_get_series `otherSeries` to fetch a non-default sensor.

---
name: usgs-water-guide
description: Gates and workflows for the water_* tools over USGS stream gages and groundwater wells. Covers whether a river or aquifer is high or low right now, telling live gages from discontinued ones, reading depth-to-water rankings (a shallower depth ranks higher), finding the parameter code a site actually reports, time zones and data lag, and SQL over staged series. Use when answering questions about USGS streamflow, gage height, groundwater levels, or water-quality sensors.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Keyless USGS data from continuous sensors at stream gages, lakes, springs, and wells: real-time instantaneous values, daily statistics, site and series metadata, and daily percentiles computed over each site's record.

Not covered:

- **Place names and radius search.** Geocode elsewhere, then build a `bbox` around the point.
- **Flood stage, flood categories, forecasts.** water_get_conditions ranks a reading against the site's own history only. Pair with a National Weather Service source for flood thresholds.
- **Hand-measured well levels and lab water-quality samples.** Only wells and sites with a continuous sensor return data here.

## Identifiers

| Identifier | Comes from | Goes to |
|:--|:--|:--|
| Site number (8–15 digits, a string with leading zeros; wells are usually 15) | water_find_sites | every site tool |
| `countyCd` (5-digit FIPS) | expanded water_find_sites rows: `stateCd` (2-digit FIPS) followed by `countyCd` (3 digits), e.g. `24` + `047` → `24047`; or a FIPS lookup outside this server | water_find_sites |
| `stateCd` input (2 letters, `MD`) | the user | water_find_sites. The output `stateCd` is the FIPS number and is not accepted back |
| `huc` (2 or 8 digits) | first 8 digits of a site's `hucCd` | water_find_sites |
| Parameter code (5 digits) | water_list_parameters; better, the site's own rows in water_get_site_data_catalog | every data tool |
| `methodId` (a 32-character time-series ID) | `methodId` / `otherSeries[].methodId` in water_get_readings or water_get_series, or `timeSeriesId` on a water_get_site_data_catalog row of the same `seriesType`. Daily and instantaneous IDs differ for the same sensor | water_get_series |
| `canvas_id` + table name | a truncated water_get_series or water_find_sites response | water_dataframe_describe, water_dataframe_query |

## Gates

**A listed site is not a live site.** `parameterCd` and `hasDataTypeCd` on water_find_sites match every site that has ever reported that data, so `hasDataTypeCd: "iv"` matches a gage whose record ended in 1996 or 2019 as readily as a live one. Dormant sites are often a large share of a result. Every row carries `lastObservedAt`, the UTC time of the site's newest observation among the series the filters select (null when it has none, or none with a recorded time), and `observedWithin`, an ISO 8601 duration such as `"P7D"`, keeps only sites whose `lastObservedAt` falls inside it. Set `observedWithin` when the question is about now. Daily values and field measurements carry a date only, and daily values publish a day or two late, so a window under `"P3D"` can drop a site that reports daily values only. `parameterCd` does not match discrete water-quality samples. Before reporting current conditions for an area, keep only sites that report now:

- In a water_get_readings batch, a site whose sensor reported nothing in the period comes back as a series with `totalValues: 0`, even when every requested site is dormant, and a site with no series at all (a nonexistent number, or a real well with no continuous series of the parameter) is listed in `missingSites`. The call fails with `no_data_for_parameter` only when no requested site returns a series.
- water_get_site_data_catalog shows when each series ended (`endDate`), and the row's `webDescription` or a `methodDescription` such as `[Discontinued 10/30/2019]` names a retired sensor.

**water_get_conditions looks back two hours.** A gage that reported this morning but not in the last two hours fails with `no_data_for_parameter`, the reason a dormant or wrong site gets too, with a different message: a silent gage's says the site reports the parameter but sent no value in the window and points to water_get_readings with a longer period, a nonexistent site's says no monitoring location has the number. To tell them apart, call water_get_readings with `period: "P1D"` or `"P7D"`, or read water_get_site_data_catalog: `not_found` means no such site, an empty `series` list means the parameter was never measured, and `endDate` is the last report.

**Unknown site or no data?** water_get_series and water_get_conditions answer a nonexistent site number with the same `no_data_for_range` / `no_data_for_parameter` reason a real site with no data gets; only water_get_conditions' message says no monitoring location has the number. water_get_site_data_catalog returns `not_found` for a site that doesn't exist.

**Groundwater wells need `hasDataTypeCd: "iv"`.** With only `siteType: "GW"` and `parameterCd: "72019"`, water_find_sites also returns wells measured by hand, which usually far outnumber the instrumented ones. Those wells have no catalog rows and no series. Even with the filter, add `observedWithin` or confirm each well has recent values.

**Depth to water (72019) ranks as a water level.** The value is feet below land surface, so a larger number means a lower water table, and `currentValue` stays the depth as measured. water_get_conditions ranks the water level, not the depth: a shallower depth ranks higher, `p95` is the day's shallowest depth and `p05` the deepest, and `percentileClass` reads as it does for discharge. `record-high` or `above-normal` means the water table is unusually high (shallow), and `below-normal`, `low`, or `record-low` means it is unusually low (deep). `percentileLabel` and `comparisonBasis` say the depth is ranked as a water level. The same holds for the other depth-below-surface codes (30210, 99019, 72276); elevation codes (62610, 72020, 72150) rise with the water and rank as they are.

**Percentile classes are not floods or droughts.** `record-high` means at or above the 95th percentile of daily means for that calendar day, not a record and not flood stage. For "is the river high", rank discharge (00060); gage height (00065) often has no percentile record (`historicalContextStatus: "no_record"`).

**Provisional values can change.** Recent values carry `P` and older reviewed values carry `A`; other codes such as `e` (estimated) can ride alongside (`A,e`). Say a recent value is provisional when it drives a conclusion, especially a claim about a record.

**Find the parameter code at the site.** A water_list_parameters search for a property returns many codes; "turbidity" matches dozens across units and methods (JTU, NTU, FNU, lab, field). Read the site's unfiltered water_get_site_data_catalog page to see which code it actually reports (the Potomac at Little Falls reports turbidity as 63680, FNU). Then filter by that code.

**A bounding box has no area limit.** A large box returns its matches 500 per response (`truncated`, `upstreamTotal`, `offset`); past 500, with DataCanvas enabled, the full set also stages as a table. Narrow with `siteType`, `parameterCd`, or `observedWithin` rather than by shrinking the box.

## Time and record conventions

- **Instantaneous timestamps carry each site's own UTC offset.** Sites in one state can differ: New Mexico wells in one response read `-06:00` and `-07:00`. Compare instants, not clock strings. A site with no known time zone reports in UTC, offset `+00:00`. Daily `dateTime` is a bare date at midnight with no offset.
- **water_get_series dates are site-local calendar days, and `endDate` is inclusive.** An instantaneous request for one date returns 00:00 through the last reading before midnight, local time.
- **Daily values lag.** The newest daily value is from yesterday at best; today has no daily mean yet. Today's level comes from water_get_readings or an instantaneous series.
- **Reporting intervals vary by site,** from every minute to hourly. A 5-minute gage produces 288 records a day and a 1-minute gage 1,440, so a few days of instantaneous data is usually staged rather than returned whole inline; check `truncated`.
- **Catalog bounds are UTC and lag.** A current series' `endDate` can trail the latest reading by most of a day. A parameter can have several rows over time when a sensor was replaced: a discontinued row followed by a current one. "Since when" is the earliest `beginDate` across that parameter's rows, and gaps between rows are real gaps.

## Workflows

**Is the river near a place running high right now?**
1. Get coordinates elsewhere. Call water_find_sites with a small `bbox`, `siteType: "ST"`, `parameterCd: "00060"`, `hasDataTypeCd: "iv"`, `observedWithin: "P1D"`.
2. Pass the candidate site numbers (up to 100) to water_get_readings with `parameterCd: ["00060"]`. Keep the series with values.
3. Call water_get_conditions on the chosen gage with 00060. Report the value, `percentileClass`, the period of record, and the provisional flag.

**Groundwater levels in a county.**
1. Call water_find_sites with `countyCd`, `siteType: "GW"`, `parameterCd: "72019"`, `hasDataTypeCd: "iv"`, `observedWithin: "P1D"`.
2. Pass the well numbers to water_get_readings with `parameterCd: ["72019"]`. Drop wells with `totalValues: 0` and wells listed in `missingSites`; a `no_data_for_parameter` error means none of them has a 72019 series.
3. Call water_get_conditions per well and report the water level as the depth gate above reads it: a shallower depth ranks higher.

**Is a property measured at a site, and since when?**
1. Call water_get_site_data_catalog for the site with no `parameterCd`, and follow `nextCursor` until it is null.
2. Pick the code from the rows, then filter the catalog by it to read the bounds per sensor and statistic.
3. Hand the dates to water_get_series.

**Long series and SQL.** Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `water_dataframe_describe` with it for the staged table and column names before writing SQL, then `water_dataframe_query` with a read-only query. Pass the same `canvas_id` back to stage further results beside the first; the tables expire with the canvas.

On a staged series, `value` and `date_time` are text columns (VARCHAR):
- Cast before comparing or aggregating: `MAX(CAST(value AS DOUBLE))`. A bare `MAX(value)` compares strings and silently returns the wrong answer (a multi-year Potomac series gave "9980" instead of 136000 cfs); `AVG(value)` fails outright.
- Group by period with `substr(date_time, 1, 7)` for months.
- `qualifiers` is a comma-joined string.

**Several sensors for one parameter.** When water_get_readings lists more than one method for a site and parameter, choose by `methodDescription` (sonde, depth, `[Discontinued]`). Pass the `methodId` from water_get_series `otherSeries` to fetch a non-default sensor.

---
name: usgs-water-guide
description: Gates and workflows for the water_* tools over USGS stream gages and groundwater wells. Covers whether a river or aquifer is high or low right now, telling live gages from discontinued ones, reading depth-to-water rankings (they run inverted), finding the parameter code a site actually reports, time zones and data lag, and SQL over staged series. Use when answering questions about USGS streamflow, gage height, groundwater levels, or water-quality sensors.
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
| `methodId` | `methodId` / `otherSeries[].methodId` in water_get_readings or water_get_series. Daily and instantaneous IDs differ for the same sensor | water_get_series |
| `canvas_id` + table name | a truncated water_get_series or water_find_sites response | water_dataframe_describe, water_dataframe_query |

## Gates

**A listed site is not a live site.** water_find_sites has no active-status filter, and `hasDataTypeCd: "iv"` matches every site that ever reported instantaneous data. Gages whose discharge record ended in 1996 or 2019 come back beside live ones, and dormant sites are often a large share of a result (a majority in some small areas). Before reporting current conditions for an area, keep only sites that produce values:

- In a water_get_readings batch where at least one site returns data, a dormant site comes back as a series with `totalValues: 0`, and a site with no series at all (a nonexistent number, or a real well with no current sensor data) is listed in `missingSites`. When no requested site has data, the call fails with `no_data_for_parameter` instead.
- water_get_site_data_catalog shows when each series ended (`endDate`), and the row's `webDescription` or a `methodDescription` such as `[Discontinued 10/30/2019]` names a retired sensor.

**water_get_conditions looks back two hours.** A gage that reported this morning but not in the last two hours fails with `no_data_for_parameter`, the same error a dormant or wrong site gives. To tell them apart, call water_get_readings with `period: "P1D"` or `"P7D"`, or read the catalog's `endDate`.

**Unknown site or no data?** water_get_series and water_get_conditions answer a nonexistent site number with the same `no_data_for_range` / `no_data_for_parameter` error a real site with no data gets. water_get_site_data_catalog returns `not_found` for a site that doesn't exist.

**Groundwater wells need `hasDataTypeCd: "iv"`.** With only `siteType: "GW"` and `parameterCd: "72019"`, water_find_sites also returns wells measured by hand, which usually far outnumber the instrumented ones. Those wells have no catalog rows and no series. Even with the filter, confirm each well has recent values.

**Depth to water (72019) ranks upside down.** The value is feet below land surface, so a larger number means a lower water table. water_get_conditions ranks the depth itself: `record-high` or `above-normal` on 72019 means the water level is unusually low (deep), and `below-normal`, `low`, or `record-low` means it is unusually high (shallow). Report the water level, not the class name.

**Percentile classes are not floods or droughts.** `record-high` means at or above the 95th percentile of daily means for that calendar day, not a record and not flood stage. For "is the river high", rank discharge (00060); gage height (00065) often has no percentile record (`historicalContextStatus: "no_record"`).

**Provisional values can change.** Recent values carry `P` and older reviewed values carry `A`; other codes such as `e` (estimated) can ride alongside (`A,e`). Say a recent value is provisional when it drives a conclusion, especially a claim about a record.

**Find the parameter code at the site.** A water_list_parameters search for a property returns many codes; "turbidity" matches dozens across units and methods (JTU, NTU, FNU, lab, field). Read the site's unfiltered water_get_site_data_catalog page to see which code it actually reports (the Potomac at Little Falls reports turbidity as 63680, FNU). Then filter by that code.

**Keep a bounding box to about 5 degrees on a side.** The cap is an area that varies with latitude; 5 by 5 passes at 35°N while 7 by 5 fails from 25°N to 40°N. A rejected box comes back as `invalid_request` whose message states the widest box allowed at that height; shrink to it, split the area, or switch to `stateCd` or `huc`.

## Time and record conventions

- **Instantaneous timestamps carry each site's own UTC offset.** Sites in one state can differ: New Mexico wells in one response read `-06:00` and `-07:00`. Compare instants, not clock strings.
- **water_get_series dates are site-local calendar days, and `endDate` is inclusive.** An instantaneous request for one date returns 00:00 through the last reading before midnight, local time.
- **Daily values lag.** The newest daily value is from yesterday at best; today has no daily mean yet. Today's level comes from water_get_readings or an instantaneous series.
- **Reporting intervals vary by site,** from every minute to hourly. A 5-minute gage produces 288 records a day and a 1-minute gage 1,440, so a few days of instantaneous data is usually staged rather than returned whole inline; check `truncated`.
- **Catalog bounds are UTC and lag.** A current series' `endDate` can trail the latest reading by most of a day. A parameter can have several rows over time when a sensor was replaced: a discontinued row followed by a current one. "Since when" is the earliest `beginDate` across that parameter's rows, and gaps between rows are real gaps.

## Workflows

**Is the river near a place running high right now?**
1. Get coordinates elsewhere. Call water_find_sites with a small `bbox`, `siteType: "ST"`, `parameterCd: "00060"`, `hasDataTypeCd: "iv"`.
2. Pass the candidate site numbers (up to 100) to water_get_readings with `parameterCd: ["00060"]`. Keep the series with values.
3. Call water_get_conditions on the chosen gage with 00060. Report the value, `percentileClass`, the period of record, and the provisional flag.

**Groundwater levels in a county.**
1. Call water_find_sites with `countyCd`, `siteType: "GW"`, `parameterCd: "72019"`, `hasDataTypeCd: "iv"`.
2. Pass the well numbers to water_get_readings with `parameterCd: ["72019"]`. Drop wells with `totalValues: 0` and wells listed in `missingSites`; a `no_data_for_parameter` error means none of them has current data.
3. Call water_get_conditions per well, applying the 72019 inversion above.

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

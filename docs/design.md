# USGS Water Data MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `water_find_sites` | Find USGS monitoring sites by bounding box, state, county, or HUC. Filter by site type and parameter availability. Returns site number, name, type, coordinates, the UTC time each site last reported (`lastObservedAt`), and drainage area (expanded mode only) — altitude is included in both modes when recorded. Required discovery step — downstream tools key on site numbers, and parameter availability varies. Exactly one major filter (`bbox` \| `stateCd` \| `countyCd` \| `huc`) is required, enforced in the handler before any request; `siteType`/`parameterCd`/`hasDataTypeCd`/`observedWithin` only narrow within it. `parameterCd` and `hasDataTypeCd` match sites that have ever reported; `observedWithin` (an ISO 8601 duration) keeps only sites whose `lastObservedAt` falls inside it. `limit`/`offset` page the in-memory match set at 500 per page (`truncated` means matches remain after the returned window, `upstreamTotal` holds the full count); the whole match set is held in memory, so with DataCanvas enabled a match set past 500 also stages in full to a canvas for gap-free retrieval via `water_dataframe_describe` then `water_dataframe_query`. | `bbox`, `stateCd`, `countyCd`, `huc`, `siteType`, `parameterCd`, `hasDataTypeCd`, `observedWithin`, `siteOutput`, `limit`, `offset`, `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_readings` | Get the latest instantaneous values (real-time, ~15 min) for one or more sites. Returns per-site results each including the siteNumber, parameter code, timestamp, value, unit, and provisional/approved qualifier. Accepts up to 100 site numbers in one call. A site measuring one parameter with several sensors returns one series per sensor, each named by `methodId` (its time-series ID) and `methodDescription`; a sensor that reported nothing in the period still returns, with `totalValues: 0`. Omitting `parameterCd` returns every parameter each site publishes, so at most 100 series return per call, kept round-robin across sites, with the pre-cap count in `totalSeries`. Each series is capped at its 10 most recent records with the true count in `totalValues`; `truncated` flags either cap — `water_get_series` is the tool for a full series. Requested sites that return no series are named in `missingSites`, so a partial batch is visible rather than inferred. | `sites` (array), `parameterCd` (array), `period` (ISO 8601 duration, e.g. `PT2H`, `P7D`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_series` | Get a time series of daily or instantaneous values for a site and parameter over a date range. Returns `siteNumber`, `parameterCd`, the `statCd`/`methodId` (the series' time-series ID) of the one series selected, value records (date/time, value, qualifiers), and `otherSeries` listing every other statistic × method series the query returned, empty ones included. Defaults to the daily mean (`00003`) when a mean series carries values, and the series with the most records, a tie going to the site's default sensor, then to the series that began first. Large result sets (>500 rows) return the most recent records inline with `truncated: true`; with DataCanvas enabled the complete series also spills to a canvas (`canvas_id`/`table_name`) for gap-free retrieval via `water_dataframe_describe` then `water_dataframe_query`. | `site`, `parameterCd`, `startDate` (YYYY-MM-DD), `endDate` (YYYY-MM-DD), `seriesType` (`daily` \| `instantaneous`), `statCd`, `methodId`, `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_conditions` | Get current conditions at a site placed in historical context: today's value ranked against the site's daily percentile record for the same calendar day. Returns the current reading alongside the percentile class (`record-high` / `above-normal` / `normal` / `below-normal` / `low` / `record-low`), a `percentileLabel` stating that class's threshold in plain language, and a `comparisonBasis` disclosing that an instantaneous reading is ranked against approved daily-mean percentiles. The reading comes from one of the site's sensor series for the parameter, named by `methodId` — the series a daily-mean series is computed from when one is, otherwise the most recent; percentiles come from that daily-mean series (`methodMatched` reports whether it is the reported sensor's own). The ranking follows the water level: for a depth-below-surface code (`72019`, `30210`, `99019`, `72276`) a shallower depth ranks higher. A "how unusual is this reading" ranking — not a flood-stage or drought determination, which need authoritative thresholds this tool does not fetch. | `site`, `parameterCd` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_list_parameters` | Look up USGS parameter codes. Without `query`: the curated table of well-known codes with names, units, and domain — no network call — so an agent learns that `00060` = "Discharge" (cfs), `00065` = "Gage height" (ft), `00010` = "Temperature" (°C), `72019` = "Depth to water, below land surface" (ft). With `query`: a word-prefix search of the full USGS parameter-code catalog (~19,600 codes) by name and description, or a bare 5-digit code lookup; entries carry `source` (`curated` \| `usgs-catalog`), curated matches first, capped at 25 with `total`/`truncated`. | `group` (curated filter: `streamflow` \| `groundwater` \| `temperature` \| `meteorological` \| `water-quality` \| `all`), `query` (catalog search; not combinable with a `group` other than `all`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

`water_get_site_data_catalog` discovers one site's series through OGC v1 monitoring locations and time-series metadata. Inputs are `site`, optional `parameterCd`/`seriesType`, `limit` (1–1000, default 100), and an opaque `cursor`. Output preserves `siteNumber`, nullable `siteName`, distinct `series` rows, and nullable `nextCursor`. A row's `timeSeriesId` is the `methodId` that `water_get_readings` and `water_get_series` report for the same series.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude. Stable URI for a known site number. | No |
| `usgs-water://parameters` | The curated table of well-known parameter codes — the list `water_list_parameters` returns without a query, from the same shared table. Injectable context for clients that support resources. | No |

### Prompts

None — this server is data-oriented; no recurring analysis templates worth structuring as prompts.

---

## Overview

USGS Water Data MCP Server exposes real-time and historical water data from the USGS Water Data APIs: the OGC collections (`api.waterdata.usgs.gov/ogcapi/v1`) and the Statistics API (`api.waterdata.usgs.gov/statistics/v0`). Coverage: ~8,000 active stream gages and thousands of groundwater wells across the US and territories. Data is public and needs no key; an optional `USGS_API_KEY` raises the rate limit.

Primary use cases: see whether a river is running unusually high or low for the date before a trip; pull a streamflow time series for trend analysis; compare current groundwater depth against historical norms; find nearby monitoring sites for a region of interest.

---

## Requirements

- Read-only access to the USGS Water Data APIs (no auth; an optional `USGS_API_KEY`, sent as `X-Api-Key`, raises the anonymous per-IP rate limit)
- Real-time (instantaneous, ~15 min) values from the `continuous` collection
- Historical daily values from the `daily` collection
- Site discovery via `monitoring-locations` (bbox, state, county, HUC, site type), with each site's newest observation from `latest-continuous`, `latest-daily`, `latest-field-measurements`, and `peaks`
- Percentile/conditions context via the Statistics API (`observationNormals`, `observationIntervals`)
- Groundwater levels through parameter code `72019` (depth to water), read like any other parameter from `continuous` and `daily`
- Parameter code discovery: a built-in curated table (no network call), plus search of the full USGS parameter-code catalog
- Multi-site batching: `continuous` takes a filter over up to 100 sites in one request
- Error handling: read each rejection from the API's JSON error body and map it to a typed failure; every tool call runs under one 45-second deadline shared by its requests and retries
- Provisional vs. approved data qualifiers surfaced to callers (not hidden)
- Large result sets spill to DataCanvas for agent SQL analysis (requires `CANVAS_PROVIDER_TYPE=duckdb`): date-range series (>500 records) from `water_get_series`, and site match sets (>500 sites) from `water_find_sites`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `waterdata/water-data-client` | Request core for `api.waterdata.usgs.gov`: the OGC collections and the Statistics API — `X-Api-Key` header, retries under the call's deadline, OGC `next` link and Statistics token paging, per-host 429 cooldown | Every service below |
| `waterdata/site-discovery` | `monitoring-locations` plus `latest-continuous`, `latest-daily`, `latest-field-measurements`, and `peaks` | `water_find_sites`, the site resource |
| `waterdata/observations` | `continuous`, `daily`, and `time-series-metadata`, assembled into one series per statistic × method (`observation-series`) | `water_get_readings`, `water_get_series`, `water_get_conditions` |
| `waterdata/day-statistics` | Statistics API `observationNormals` and `observationIntervals`, with the daily-mean series from `time-series-metadata` | `water_get_conditions` |
| `waterdata/parameter-catalog` | `parameter-codes` — the full parameter-code catalog, read whole and cached | `water_list_parameters` (`query`), series `parameterName` and `unitCode` |
| `waterdata/statistic-codes` | `statistic-codes` — the statistic names, read whole and cached | `water_get_series` (`statName`) |
| `waterdata/site-data-catalog` | `monitoring-locations` identity and `time-series-metadata` pages | `water_get_site_data_catalog` |
| `waterdata/site-resolver`, `waterdata/site-local-time` | Bare site number → agency-prefixed monitoring location with its time-zone code, TTL-cached; the `time-zone-codes` offsets for site-local timestamps and day windows | Every site-keyed service |

OGC location IDs are `<agency>-<site>` (`USGS-01646500`, `MO005-364643089212301`); callers keep the bare site number, and the resolver finds the agency.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | DataCanvas spillover for large result sets (`water_get_series` series, `water_find_sites` match sets). Defaults to `duckdb`; with `none`, both tools return a truncated preview with an overflow signal. |
| `USGS_USER_AGENT` | No | Custom User-Agent string for USGS requests. USGS requests a descriptive User-Agent per their terms; defaults to `usgs-water-mcp-server/0.6.0 (contact: https://github.com/cyanheads/usgs-water-mcp-server)`. |
| `USGS_REQUEST_TIMEOUT_MS` | No | HTTP timeout in milliseconds for each USGS Water Data API request. Default `30000`. Every tool call also runs under one 45-second deadline across its requests and retries. |
| `USGS_API_KEY` | No | api.data.gov key, sent as the `X-Api-Key` header. Without one, requests share the anonymous per-IP hourly limit (1,000 on the OGC collections); a shared or hosted deployment should set one. |
| `WATER_DATAFRAME_DROP_ENABLED` | No | `true` makes `water_dataframe_drop` callable; off (the default), it is registered through `disabledTool()`. Parsed with `z.stringbool()`, so a blank value reads as unset. |
| `MCP_TRANSPORT_TYPE` | No | `stdio` (default) or `http`. Framework-managed. |
| `MCP_HTTP_PORT` | No | HTTP port when transport is `http`. Default `3010`. Framework-managed. |

---

## Implementation Order

1. **Config and service setup** — `src/config/server-config.ts` (USGS user-agent, request timeout, optional API key), `src/services/waterdata/water-data-client.ts` (request core: key header, retries under the call's deadline, paging) and `water-data-errors.ts` (error-body classification)
2. **Parameter lookup tool** — `water_list_parameters`: curated table with no network call; `query` searches the full USGS parameter-code catalog through `services/waterdata/`
3. **Site discovery tool** — `water_find_sites`: reads `monitoring-locations` and the latest-value collections, returns structured site records with `lastObservedAt`
4. **Readings tool** — `water_get_readings`: reads `continuous` and `time-series-metadata`, multi-site batch, returns latest values per site/parameter/sensor
5. **Series tool** — `water_get_series`: reads `daily` or `continuous` depending on `seriesType`, 366-day chunks for instantaneous ranges, DataCanvas spillover for large ranges
6. **Conditions tool** — `water_get_conditions`: reads the current value and the Statistics API percentiles, computes percentile class
7. **Resources** — `usgs-water://site/{siteId}` and `usgs-water://parameters`

Each step independently testable: the service layer can be unit-tested against a fake `fetch` serving captured responses; tools can be tested against fixture payloads; reading + statistics pairing in step 6 is the highest-complexity integration.

---

## Domain Mapping

| Noun | Water Data API source | Format | Notes |
|:-----|:----------------------|:-------|:------|
| Sites (discovery) | OGC `monitoring-locations` | GeoJSON | `skipGeometry` is not used (coordinates come from the geometry); `properties` trimmed per `siteOutput=basic\|expanded`. `bbox` is a plain parameter with no area cap; `stateCd` is translated to the FIPS `state_code` (the queryable takes digits only — a postal code answers 200 with no rows); `huc` is a `hydrologic_unit_code` prefix match; `countyCd` and `siteType` go through cql2-text (`state_code` AND `county_code`; `site_type_code` equals the code, or `LIKE 'ST-%'` for a major type's subtypes) |
| Site recency | OGC `latest-continuous`, `latest-daily`, `latest-field-measurements`, `peaks` | GeoJSON | One request per collection the call names, with the same geographic scope, `parameter_code`, and `time=<observedWithin>`; `hasDataTypeCd` picks the collections (`iv`→`latest-continuous`, `dv`→`latest-daily`, `gw`→`latest-field-measurements` limited to `observing_procedure LIKE 'GW level%'`, `pk`→`peaks`; omitted: continuous, daily, and field measurements). The newest `time` per `monitoring_location_id` is `lastObservedAt`; a date-only `time` counts from 00:00 UTC |
| Instantaneous values | OGC `continuous` | GeoJSON | `monitoring_location_id IN (…)` and `parameter_code IN (…)` through cql2-text, `time=PT2H` (a duration ending now) or an explicit UTC interval, `limit=50000`. Rows carry `time_series_id`, `time` (UTC), `value`, `approval_status`, and `qualifier` (an array of words). The collection rejects a time envelope over 1,100 days |
| Daily values | OGC `daily` | GeoJSON | Same filters, `time=<start>/<end>` as dates, `statistic_id` for one statistic; without it every statistic returns. No range cap |
| Series metadata | OGC `time-series-metadata` | GeoJSON | One row per series (a statistic × sensor): `computation_period_identifier` (`Points` or `Daily`), `statistic_id`, `begin`, `sublocation_identifier`, `web_description`, `parent_time_series_id` (a daily series' source instantaneous series). Supplies every series a query returns, whether or not it holds values in the window |
| Statistics (percentiles) | Statistics API `observationNormals`, `observationIntervals` | GeoJSON | `observationNormals` with `normal_type=DOY`, `computation_type=percentile`, and `start_date`=`end_date`=`MM-DD`, read for the daily-mean series only (`parent_statistic_id` `00003`; the API also publishes daily maximum and minimum normals); `observationIntervals` with `interval_type=M` and `parent_time_series_id` for the period of record. Both key by the daily-mean series' time-series ID and need the agency-prefixed location ID; `"nan"` reads as null; the Statistics API rejects `f=json` |
| Code tables | OGC `statistic-codes`; `time-zone-codes` and `states` as tables in code | GeoJSON | `statistic-codes` is read whole and cached for `statName`; the time-zone offsets (`site-local-time.ts`) and postal→FIPS codes (`state-fips-codes.ts`) are tables copied from their collections, plus FM, MH, and PW (FIPS 64, 68, 70), which `states` omits but `monitoring-locations` uses |
| Parameter codes | OGC `parameter-codes` (curated table built in) | GeoJSON | Curated codes come from `services/waterdata/curated-parameters.ts` with no network call. A `query` reads the whole catalog in one request — `f=json&limit=50000&properties=parameter_name,unit_of_measure,parameter_description` (~19,600 records, ~6 MB uncompressed) — following any `next` link; the record `id` is the code. Upstream `q=` is not used: CQL2 `LIKE` is case-sensitive and `ILIKE` returns HTTP 400 |

### Accepted input formats

Encoded as Zod patterns in `services/waterdata/input-schemas.ts` and shared by every tool that forwards a value into a Water Data query, so a malformed value fails at the edge before any request.

| Input | Accepted | Notes |
|:------|:---------|:------|
| `site` / `sites` | 8–15 digits | Zero-padded (e.g. `01646500`). Resolved across agencies, not by a `USGS-` prefix |
| `parameterCd` | Exactly 5 digits | Comma-separated lists are accepted by `water_find_sites`; `water_get_series` and `water_get_conditions` take a single code because they return a single series |
| `period`, `observedWithin` | ISO 8601 duration | Years, months, weeks, days, hours, minutes, and seconds (a fraction only on seconds), not a fixed subset. The collections reject a negative duration (`P-T2H` → 400 `Invalid ISO 8601 duration`), which the pattern excludes |
| `huc` | **2 digits or 8 digits only** | A major HUC is 2 digits, a minor HUC is 8. It matches every site whose HUC starts with it, 12-digit HUCs included. (Distinct from the `hucCd` *output* field, where site records can carry longer values.) |
| `countyCd` | Bare 5-digit FIPS | State and county digits concatenated (`51013`), comma-separated up to 20; split into the state and county codes for the query |
| `stateCd` | 2 letters, any case | A state or territory postal code, translated to its FIPS code; any other two letters fail as `invalid_request` before a request is sent |
| `bbox` | 4 comma-separated decimal numbers | `west,south,east,north`. The API checks nothing further and applies no area cap |
| `hasDataTypeCd` | `iv` (aliases `uv`, `rt`), `dv`, `gw`, `pk` | The codes with a source on the Water Data APIs. `qw` moved to the samples API, `sv` site visits carry no period of record, and `ad`, `aw`, `id` have no counterpart: they fail as `invalid_request` |
| major filter | **Exactly one** of `bbox`, `stateCd`, `countyCd`, `huc` | A site query scopes by one of the four and no more. The collections would take several at once, or none (a walk of the whole national network); the rule keeps every call bounded and every filter set with one reading. `countyCd`'s 5 FIPS digits already encode the state, so pairing it with `stateCd` is redundant as well as rejected. `water_find_sites` enforces the rule in its handler — see the decision record below |

---

## Workflow Analysis

### `water_get_conditions` (parallel reads, then one statistics step)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1a | `getReadings`: `continuous` for the site and parameter with `time=PT2H`, plus the site's `time-series-metadata` (`Points`) | Current value with qualifier, one series per sensor |
| 1b | `getDailyMeanSeries`: `time-series-metadata` with `computation_period_identifier=Daily` and `statistic_id=00003` | The site's daily-mean series, each naming the instantaneous series it is computed from (`parent_time_series_id`) |
| 2 | Select: one sensor series' latest reading — measured before no-data, then a series a daily-mean series is computed from, then the most recent (an exact time tie goes to the site's default sensor, then the earlier series) — then that daily-mean series to rank it against | One reading, one percentile series |
| 3 | `getDayStatistics`: `observationNormals` for the reading's own `MM-DD`, and in parallel `observationIntervals` for the series' approved months | The day's percentiles and the period of record |
| 4 | Compute: classify the value against the day's bounding percentiles (by water level for a depth-below-surface code) | `record-high`/`above-normal`/`normal`/`below-normal`/`low`/`record-low` |

Calls 1a and 1b run in `Promise.allSettled`. The percentiles are computed from **approved daily-mean** values, while call 1a returns an **instantaneous** reading — the Statistics API publishes no instantaneous percentile product — so `percentileClass` is a cross-granularity approximation ("how unusual is today's reading for this calendar day"), not a flood-stage or drought determination. `historicalContext.comparisonBasis` states this at runtime.

The statistics side is settled, not awaited-to-throw, so an operational failure stays distinct from a genuinely empty result. `historicalContextStatus` reports which case occurred: `available` (percentiles present), `no_matching_day` (the reported sensor's daily-mean series has an approved record but no percentiles for the observation's calendar day), `no_matching_method` (several daily-mean series have percentiles for the day and none is computed from the reported sensor — see the decision record on series pairing), `no_record` (no daily-mean percentiles exist for the site, parameter, and day — a new site, a record too short, or a series with only daily maximum or minimum normals), or `unavailable` (a statistics or series-metadata request failed — transient, retryable, and never attributed to the site's history). Every case still returns the current reading — partial success, not a throw. Only a failure of the reading itself — a 5xx, a timeout, or a body the server cannot read — throws `upstream_error` or `upstream_timeout`.

---

## Error Contracts

Typed failure contracts for the network-calling tools and the `usgs-water://site/{siteId}` resource. `water_list_parameters` reaches the network only for a `query`; its contract follows the other tools'.

**Classification is code-based, not message-based.** `water-data-client` types every failure it raises — a 400 or 422 becomes a `validationError`; a 5xx, or a complete body that is not JSON or fails its schema (never retried), becomes a `serviceUnavailable`, a deterministic one carrying `retryable: false` through to the tool's error; a spent deadline becomes a `Timeout` — and `classifyWaterDataFailure()` maps that code onto the reason vocabulary below. Tools never re-match the error prose to guess a field. Two failures classify to null and reach the caller as their own typed errors with their own recovery hints: a 429 (`RateLimited`, carrying `retryAfter`) and a rejected `USGS_API_KEY` (`ConfigurationError`).

**`invalid_request` names no field on purpose.** The APIs report the offending field only inside the message of their JSON error body (`{ code, description }` from the OGC collections, `{ detail }` from the Statistics API), and not always the field the caller passed. Selecting a reason by pattern-matching that prose is what made a bad `period` surface as a bad site number. The reason states what the server knows — the API refused the request — and the message carries the API's own description for the caller to act on.

### `water_find_sites`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_sites_found` | `NotFound` | No sites match the given filters | No — broaden bbox/state/HUC, widen or drop `observedWithin`, or remove parameterCd/hasDataTypeCd/siteType filters |
| `missing_major_filter` | `ValidationError` | None of `bbox`/`stateCd`/`countyCd`/`huc` was supplied. Raised in the handler before any request | No — add exactly one major filter |
| `conflicting_major_filters` | `ValidationError` | More than one of them was supplied. Raised in the handler before any request; the message names the fields that were sent | No — keep one and drop the others |
| `invalid_request` | `ValidationError` | A well-formed filter value has no translation — a `stateCd` that is no US state or territory, a malformed `siteType`, a `hasDataTypeCd` with no source (all refused before any request) — or the API refused the query | No — read the message in the error for what was refused |
| `upstream_error` | `ServiceUnavailable` | The API returns 5xx, or a response this server cannot read, after the client's retries | Yes — retry after backoff |
| `upstream_timeout` | `Timeout` | The call's requests ran past its 45-second budget | Yes — retry after backoff; narrow the geographic filters if it repeats |
| `canvas_not_found` | `NotFound` | A supplied `canvas_id` names a canvas that never existed or has expired. Resolved before any request, so a bad id costs no upstream round trip | No — omit `canvas_id` for a fresh canvas |
| `canvas_capacity_exhausted` | `RateLimited` | A fresh canvas was needed to stage the match set and the tenant is at its active-canvas cap | Yes — reuse a prior `canvas_id`, or retry once one expires |

**The major-filter rule lives in the handler, not the schema.** A Zod `.superRefine()`/`.refine()` contributes nothing to the advertised JSON Schema and rejects at the SDK edge as the framework's generic `invalid_arguments`, bypassing `errors[]` entirely — so the caller gets a schema-derived diagnostic instead of a typed reason with an authored recovery hint. Cross-field bounds a caller is expected to recover from belong in the handler; the rule is restated in each major filter's `.describe()` so it is still visible before the call.

### `water_get_readings`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_parameter` | `NotFound` | No requested site returned a series: each either does not exist or has no instantaneous series of the requested parameter(s). A site whose sensor reported nothing in the period returns a series with `totalValues: 0` instead | No — check each site with `water_get_site_data_catalog`: `not_found` means no such site, an empty `series` means the parameter was never measured, and `endDate` gives the last report |
| `invalid_request` | `ValidationError` | The API refused a value that passed the input patterns | No — read the message in the error; it names what was refused |
| `upstream_error` | `ServiceUnavailable` | The API returns 5xx, or a response this server cannot read, after the client's retries | Yes — retry after backoff |
| `upstream_timeout` | `Timeout` | The requests, retries included, ran past the call's 45-second budget | Yes — retry after backoff; request fewer sites or a shorter period if it repeats |

A batch where *some* sites return series is a success, not an error: the returned series are in `readings` and the rest are named in `missingSites`. A batch where every site is dormant is a success too, each sensor a series with `totalValues: 0`. A batch past the 100-series cap is a success — `totalSeries` exceeds `total` and `truncated` is set (see the series-cap decision below).

### `water_get_series`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_range` | `NotFound` | Site/parameter combination has no data in the requested date range (also covers an unknown site, which returns no series) | No — read the site's record bounds with `water_get_site_data_catalog` (`beginDate`/`endDate`) and request a range inside them |
| `invalid_date_range` | `ValidationError` | This tool's own date validation: `endDate` before `startDate`, or a date that matches `YYYY-MM-DD` but is not a real calendar date. Never reaches the API | No — correct the date range |
| `invalid_stat_cd` | `ValidationError` | `statCd` is not a 5-digit code. Checked in the handler before any request | No — pass a code such as `00003`, or omit it |
| `stat_cd_for_instantaneous` | `ValidationError` | A `statCd` other than `00000` on an instantaneous series — instantaneous values carry no other statistic. Checked before any request | No — omit `statCd`, or use `seriesType: "daily"` |
| `method_not_found` | `NotFound` | No returned series carries the requested `methodId` (within the requested `statCd`). A numeric method ID always lands here: `methodId` is the 32-character time-series ID. The recovery hint lists every `statCd`/`methodId` that does exist | No — re-request with a listed id, or omit `methodId` |
| `invalid_request` | `ValidationError` | The API refused a value that passed the input patterns | No — read the message in the error; it names what was refused |
| `upstream_error` | `ServiceUnavailable` | The API returns 5xx, or a response this server cannot read, after the client's retries | Yes — retry after backoff |
| `upstream_timeout` | `Timeout` | The requests, retries included, ran past the call's 45-second budget | Yes — retry after backoff; request a shorter date range if it repeats |
| `canvas_not_found` | `NotFound` | A supplied `canvas_id` names a canvas that never existed or has expired. Resolved before any request, so a bad id costs no upstream round trip | No — omit `canvas_id` for a fresh canvas |
| `canvas_capacity_exhausted` | `RateLimited` | A fresh canvas was needed to stage the series and the tenant is at its active-canvas cap | Yes — reuse a prior `canvas_id`, or retry once one expires |

### `water_get_conditions`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_parameter` | `NotFound` | No reading came back for the site and parameter in the last two hours: the site does not exist, never measured the parameter, or reported nothing in that window. The message says which it can: a nonexistent site names the missing monitoring location, a gage that reports the parameter but sent no value says so | No — call `water_get_site_data_catalog`: `not_found` means no such site, an empty `series` means the parameter was never measured, `endDate` gives the last report; for a gage silent only in the last two hours, call `water_get_readings` with a longer `period` |
| `invalid_request` | `ValidationError` | The API refused the reading request for a value that passed the input patterns | No — read the message in the error; it names what was refused |
| `upstream_error` | `ServiceUnavailable` | The API answered the reading request with a 5xx, or a response this server cannot read, after the client's retries. A statistics failure never raises it | Yes — retry after backoff |
| `upstream_timeout` | `Timeout` | The reading did not arrive within the call's 45-second budget. A statistics timeout is reported as `historicalContextStatus: "unavailable"` | Yes — retry after backoff |

Note: absence of percentiles is **not** an error — `water_get_conditions` returns the current reading with `historicalContext: null` and a note. `historicalContextStatus` discriminates *why* it is absent: `no_record` (no daily-mean percentiles for the day — new site, record too short, or maximum/minimum normals only), `no_matching_day` (the reported sensor's daily-mean series has an approved record but no percentiles for the observation's calendar day), `no_matching_method` (several daily-mean series, none computed from the reporting sensor), or `unavailable` (a statistics or series-metadata request failed — transient and retryable, kept distinct from a sparse site). A statistics-side failure is settled inline, so it never turns a reading into a throw; only a failure of the reading itself surfaces as `upstream_error` or `upstream_timeout`. This is partial-success, not a throw.

### `water_list_parameters`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `query_with_group` | `ValidationError` | `query` combined with a `group` other than `all` — `group` has no counterpart in the catalog's own grouping. Raised before any fetch | No — pass `query` alone, or `group` alone |
| `upstream_error` | `ServiceUnavailable` | The catalog request failed, timed out, or returned something other than a catalog page | Yes — retry after backoff |

A 429 and a rejected `USGS_API_KEY` pass through as their own typed errors (`RateLimited` carrying `retryAfter`, `ConfigurationError`) rather than as `upstream_error`. A query that matches nothing is a success with an empty list, `total: 0`, and a `note` suggesting how to broaden it. A failed catalog fetch is never answered from the curated table alone: curated-only results would read as "no catalog code matched".

### `usgs-water://site/{siteId}` (resource)

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `not_found` | `NotFound` | No monitoring location, under any agency, has the given (well-formed) site number | No — check the number with `water_get_site_data_catalog`, whose `not_found` is authoritative for every agency |
| `invalid_request` | `ValidationError` | The API refused a value that passed the 8–15 digit edge schema | No — read the message in the error, then check the site number |
| `upstream_error` | `ServiceUnavailable` | The API failed after retries or sent a response this server cannot read | Yes — retry after backoff |
| `upstream_timeout` | `Timeout` | The site lookup ran past its 45-second budget | Yes — retry after backoff |

The `siteId` param carries the shared 8–15 digit `SiteNumberSchema`, so a malformed site number is rejected at the resource edge before any request — the same edge validation the tools apply.

---

## Design Decisions

### Data source: the USGS Water Data APIs

**Decision:** Every request goes to `api.waterdata.usgs.gov` — the OGC collections (`/ogcapi/v1`) for sites, observations, series metadata, and code tables, and the Statistics API (`/statistics/v0`) for percentiles. No request goes to the retiring WaterServices (`waterservices.usgs.gov/nwis`), which shuts down on 2027-02-22 with slowdowns and outages ahead of it.

**Why:** WaterServices served every site search, reading, series, and percentile table the tools return, so the shutdown ends them all; the Water Data APIs are the USGS replacement and publish the same data as JSON. The tool surface is kept, which is why the services translate the inputs and outputs the tools already carry (state letters to FIPS codes, UTC instants to site-local timestamps, qualifier words to codes) rather than pass the collections' shapes through. The collection-by-collection mapping is under "Domain Mapping".

### Percentiles come from the Statistics API

**Decision:** `water_get_conditions` reads day-of-year percentiles from `observationNormals` and the period of record from `observationIntervals`, only for the daily-mean series (`parent_statistic_id` `00003`).

**Why:** The Statistics API publishes the approved daily-mean percentiles keyed by the same time-series ID as the series metadata, so a reading pairs with its percentiles by ID (see "Percentiles and sensors pair by time-series ID"). Computing them from `daily` would read a site's whole record to rank one reading. The API also publishes daily maximum and minimum normals; ranking a reading against those would compare it with the wrong statistic, so a series with only those is `no_record`.

### Site recency comes from the latest-value collections

**Decision:** `lastObservedAt` and `observedWithin` on `water_find_sites` read `latest-continuous`, `latest-daily`, `latest-field-measurements`, or `peaks` once each, with the call's geographic scope, parameter, and `time` filter; no request is made per returned site.

**Why:** The request count then follows the collections a call names, never the number of sites it returns, which keeps a state-wide search inside the anonymous hourly quota. The collections list a site's dormant series beside its live ones, so the newest `time` per site is the honest answer to "has this site reported lately", and `parameterCd` and `hasDataTypeCd` keep their meaning of "has ever reported".

### Groundwater: continuous series, not a dedicated endpoint

**Decision:** Groundwater levels (depth-to-water, parameter `72019`) are handled by `water_get_readings` and `water_get_series` like any other parameter — not a dedicated `water_get_groundwater_levels` tool. They are read from `continuous` and `daily`, so only wells with a continuous sensor return values; `hasDataTypeCd: "gw"` on `water_find_sites` matches hand-measured wells through `latest-field-measurements` and reports when they were last measured, but no tool returns field-measurement values.

**Why:** A dedicated GW tool would duplicate `water_get_readings` with no added value for the wells that have series. Discovery is handled by `water_find_sites` with `siteType=GW` and `parameterCd=72019`.

### Error handling: the API's JSON error body

**Decision:** The request core reads each non-2xx response's own JSON error body — `{ error: { code, message } }` from the api.data.gov gateway, `{ code, description }` from the OGC collections, `{ detail }` from the Statistics API, plain text otherwise — and raises a typed error from it: a 400 or 422 is `validationError` carrying the API's description, a 429 is `rateLimited` carrying `retryAfter`, a rejected key (`API_KEY_*`) is `configurationError`, a 5xx is `serviceUnavailable`. A complete 200 body that is not JSON or fails its schema is `serviceUnavailable` and is not retried.

**Why:** The API states what it rejected, and a tool that pattern-matched prose instead would misattribute a bad value. A body that parsed wrong once parses wrong again, so retrying it only burns the call's budget.

### DataCanvas: on by default for large result sets

**Decision:** `water_get_series` and `water_find_sites` stage large result sets to DataCanvas, which is on by default (`CANVAS_PROVIDER_TYPE=duckdb`). With `CANVAS_PROVIDER_TYPE=none`, which the portable `.mcpb` bundle sets because it ships without the DuckDB native, each returns a bounded preview with a `truncated` flag: `water_get_series` the most recent 500 rows with a `totalRecords` count, `water_find_sites` the first 500 sites with an `upstreamTotal` count. DuckDB stays optional at runtime, so a deployment without it still answers every non-canvas call.

**`water_find_sites` stages via `registerTable`, not `spillover()`.** `water_get_series` truncates on a character budget (`spillover()`'s `previewChars`), so `spillover()` — which registers to canvas only when the source exceeds that budget — fits it directly. `water_find_sites` truncates on a hard **count** (`SITE_CAP = 500`, shipped in v0.1.4), and the full match set must land on canvas whenever the count exceeds the cap, independent of serialized size. Driving that off a character budget would silently drop the sites just past the cap for match sets that happen to fit under the budget, so the handler registers the full set directly via `CanvasInstance.registerTable`. The inline preview stays the original capped site objects — no lossy round-trip out of the snake_case canvas rows, which also sidesteps re-deriving the optional expanded fields.

**Staging is keyed to `upstreamTotal`, never the requested `limit`.** `limit`/`offset` window the response; the whole match set is already in memory either way, so gating staging on the window would close the SQL path to a caller who asked for ten sites out of four thousand. The two are independent: the window shapes the inline answer, the cap decides whether the full set is also queryable.

**Staged table names carry every content-changing dimension.** `registerTable` is `DROP TABLE IF EXISTS` + `CREATE TABLE`, so a name that omits part of the query lets two different result sets land on one table — the second replacing the first while the response still reports a successful staging with an unchanged `table_name`. Carrying every dimension literally does not fit the 63-character canvas identifier rule (`countyCd` alone accepts 20 comma-separated codes, 119 characters), so the name is a readable prefix plus a digest: `water_sites_<scope>_<siteType>_<8 hex>`, where `scope` is the 2-letter `stateCd` when present and otherwise the literal `county`, `huc`, or `bbox`; `siteType` is the value when it is a single code and otherwise `all`; and the suffix is the first 8 hex characters of a SHA-256 over the canonical JSON of the full filter set. `canvas_id`, `limit`, and `offset` are excluded from the digest — none of them changes what is staged, and including them would give one query a different table per page. Re-running an identical query therefore replaces its own table and nothing else, while any query whose result could differ lands on a different name. The builders live in `services/canvas/canvas-table-name.ts` and are shared with `water_get_series`, which derives its own name from the same primitives.

**A supplied `canvas_id` is resolved before the upstream request.** Resolving it inside the staging branch would let a stale or never-minted id cost a full upstream round trip before failing, and a result fitting inline would never look at the id at all — the response would carry no `canvas_id`, no `table_name`, and no explanation of why nothing was staged. The handler acquires a supplied id up front and keeps *minting* lazy — a fresh canvas is acquired only when a result actually has to stage. When a supplied id goes unused, the `notice` says so.

**One helper resolves every caller-supplied `canvas_id`.** `acquireCanvas()` (`services/canvas/acquire-canvas.ts`) wraps `canvas.acquire(id, ctx)` for `water_find_sites`, `water_get_series`, `water_dataframe_describe`, `water_dataframe_query`, and `water_dataframe_drop`: a registry `canvas_not_found` is re-thrown through the calling tool's `ctx.fail('canvas_not_found', …)`, so the message is `Canvas <id> not found or expired.` and the hint is that tool's own — the producers name omitting `canvas_id` as the fresh-canvas path, which the framework's hint deliberately avoids; the dataframe tools name the producers. Every other rejection (`canvas_capacity_exhausted`, a provider fault) passes through as the same error. `ctx` is typed `HandlerContext<'canvas_not_found'>`, which any context whose contract declares that reason satisfies and one that lacks it fails to compile. Because the throw now sits outside the handlers, all five tools mark `canvas_not_found` `thrownBy: 'service'`. The lazy mint path (`canvas.acquire(undefined, ctx)`) stays in the producing handlers.

**`water_dataframe_drop` is opt-in and fails on a name that is not staged.** Dropping a table discards staged data, so the tool is gated by `WATER_DATAFRAME_DROP_ENABLED`: off by default, it is registered through `disabledTool()` — visible on the landing page with the enable hint, absent from `tools/list` — rather than left out, so the catalog an operator sees matches the README. A missing name fails as `table_not_found` instead of returning `dropped: false`: `CanvasInstance.drop()`'s `false` cannot tell a typo from a table already gone, and a destructive call that succeeds on a name matching nothing hides the typo. The repeat call still changes nothing, so `idempotentHint` stays true. The handler resolves the name against `describe()` before dropping — case-insensitively, as DuckDB resolves identifiers in `water_dataframe_query` — which also supplies the dropped table's `row_count` and the `remaining_tables`.

**`water_get_series` names its table from the query plus the series it selected.** `water_series_<site>_<parameterCd>_<dv|iv>_<YYYYMMDD>_<YYYYMMDD>[_<7 hex>]`. The query dimensions are fixed-width and read off the request, so the longest legal input — a 15-digit site number — lands at 55 characters; the abbreviation is what buys the room (`instantaneous` spelled out pushes the name to 66, past the identifier cap). One query can return several series — one per daily statistic and per sensor method — and which one is staged is a selection among what the query returned, so a request-only name would let the daily mean and the daily maximum of one query replace each other on a single table. The suffix is the first 7 hex characters of a SHA-256 over the selected `{ statCd, methodId }`, which fills the name to exactly 63 characters at the 15-digit worst case. It is appended whenever a choice was made — the caller passed `statCd` or `methodId`, or the response offered more than one series — and omitted for a query that returned a single series, so those names are unchanged and re-running one still replaces its own table. The same selection reached two ways (the default pick, or an explicit `statCd` + `methodId` naming it) stages identical rows and lands on the same name. Staged rows also carry `stat_cd` and `method_id` columns. `canvas_id` is excluded for the same reason it is excluded from the `water_find_sites` digest. The tool resolves a supplied `canvas_id` before any request and reports an unused one in its `notice`, on the reasoning above.

**The canvas preview holds the most recent records, not the oldest.** `spillover()` fills its preview from the head of its source and offers no lever to change that — reversing the source would reverse the staged table along with it. So the handler passes the chronological rows through unchanged and takes its inline slice from the *tail* of the same rows, at the row count the character budget chose: the staged table stays complete and in order, and the inline answer holds the end of the series the way the no-canvas path always has. Without this, two deployments of one server answered "what is the latest value" differently, and the canvas response read as a series that simply ended early. The slice is taken from a computed front index rather than a negative offset, because `slice(-0)` returns the whole array — an empty preview would otherwise inline the full series under a preview caption.

### Series are per statistic × method

**Decision:** `observation-series` assembles one series per `time-series-metadata` entry — a statistic × sensor — from the `continuous` or `daily` rows that share its `time_series_id`. Every series the metadata lists comes back, one with no values in the window included (`totalValues` 0 on readings, `recordCount` 0 in `otherSeries`), and a series with rows but no metadata row yet comes back with `methodDescription: null`. Series run by site number, parameter code, statistic code, first observation, then ID.

**Why:** A site holds a second sensor, a relocated probe, or a discontinued gage kept for its record beside the live one, and `time-series-metadata` lists each. Dropping the empty ones would hide that a sensor exists and would turn a batch of dormant sites into a `no_data_for_parameter` failure, while a mixed batch lists its dormant sites as zero-value series. Returning them makes a mixed batch and an all-dormant batch the same shape: `no_data_for_parameter` fires only when no requested site returns a series, and its recovery is `water_get_site_data_catalog`, which tells a dormant site, a wrong number, and a never-measured parameter apart.

**`methodId` is the OGC `time_series_id`.** `water_get_readings`, `water_get_series`, and `water_get_conditions` report it as `methodId`, and `water_get_site_data_catalog` lists the same value as `timeSeriesId`, so a caller can carry one ID between tools. It is also the Statistics API's `parent_time_series_id`, which is how a reading finds its percentiles. WaterServices' numeric method IDs have no counterpart: a numeric `methodId` fails `method_not_found`, and the error lists the current IDs. `methodDescription` is built from the metadata as `<sublocation>, [<web description>]` (either part alone when the other is blank, null when both are), and a daily and an instantaneous series of one sensor carry different IDs.

**Qualifier words map to the codes callers already know.** The rows carry an approval status (`Approved`, `Provisional`) and an array of qualifier words (`ESTIMATED`, `SEASONAL`, …). The server emits the approval code first (`A`, `P`), then one code per word (`e`, `Ssn`, `Dis`, `Dry`, `Eqp`, `R`, `Ice`, `<`, `>`, …); a word with no code passes through as written (`OTHERAGENCY`). The tool descriptions and the skill speak in those codes, and a word with no code would otherwise vanish; a multi-word record lists every code.

**Selection, per tool:** `water_get_readings` returns every series, up to its 100-series cap. `water_get_conditions` uses one series' latest reading, ranked on three keys in order: it carries a value (a no-data record yields — see "A reading with no value is a missing reading"); a daily-mean series is computed from it (see below); it is the most recent; an exact time tie goes to the site's default sensor (`methodDescription` null), then to the earlier series. `water_get_series` returns one: the daily mean (`00003`) when a mean series carries values, otherwise the first statistic that does — a series whose every record is no data carries none, so it wins only when no series does; within it, the series with the most records, a tie going to the site's default sensor over a labeled one (a base and an auxiliary gage that began together would otherwise tie on an arbitrary ID), then to the series that began first; `statCd` and `methodId` override either choice, and `otherSeries` lists the rest with record counts. `statCd` filters the `daily` query to that statistic. Every instantaneous series is `00000`, so on an instantaneous request `00000` is accepted and any other code is refused in the handler. `methodId` is a string end to end so the value a caller reads back is the value it passes in.

**Percentiles and sensors pair by time-series ID.** `time-series-metadata` names, for each daily-mean series, the instantaneous series it is computed from (`parent_time_series_id`), and the Statistics API keys its normals and intervals by the daily-mean series' ID. `water_get_conditions` therefore ranks a reading against the daily-mean series whose source is the reading's own series (`methodMatched: true`), with no description matching. When the reading's own daily-mean series has no percentiles for the day, the outcome depends on its record. With an approved record the status is `no_matching_day`. With none (no such series, or one with no approved record), a day for which the site has exactly one daily-mean series with percentiles is ranked against it with `methodMatched: false` and a `note` naming the series (there is nothing to choose between); several yield `no_matching_method` with the candidates listed in `note`, rather than ranking against whichever comes first; none is `no_record`. The ID link needs no description to match, so sensors the metadata labels differently still pair.

**The reading follows the pairing, not recency alone.** Sensors at one site report minutes apart, so "the most recent reading across series" picks whichever reported last: at a site whose unlabeled sensor and a water-quality sonde alternate 1.5 °C apart, and whose lone daily-mean series belongs to the unlabeled sensor, recency alone would rank the sonde against the unlabeled sensor's percentiles on some calls and the unlabeled sensor on others, flipping the class between `normal` and `above-normal`. A series a daily-mean series is computed from therefore outranks a more recent unpaired one; recency decides only among equals, and an exact time tie (a base and an auxiliary gage reading at the same instant) goes to the default sensor, since response order by ID says nothing about which sensor is primary. Every candidate reading falls within the two-hour window, and `currentDateTime` shows which one was used.

### `water_get_readings` caps series at 100, round-robin across sites

**Decision:** At most 100 series return per call, counted after the per-sensor split. Past that, series are kept round-robin across sites — every site's first series, then every site's second — with a site's valued series ahead of its empty ones (a series whose every record is no data counts as empty), and the kept series stay in the order the service returned them. `totalSeries` carries the pre-cap count; `truncated` covers both this cap and the 10-record cap, and the `format()` caption names whichever applied.

**Why:** `parameterCd` is optional, so a 100-site batch returns every published parameter at every site, one series per sensor. Measured with `PT2H`: 100 active Washington stream gages returned 267 series and a 280 KB result (162 KB `structuredContent`, 115 KB `content[]`); California's 100 most-instrumented stream gages, 702 series and 627 KB. At the cap both come to about 105 KB. The cap equals the 100-site input maximum, so every site that returned a series keeps one; requiring `parameterCd` would remove the "everything at this gage" call without bounding a site that publishes many parameters. `totalSeries` counts the series the service returned, so it differs from `total` only when this cap dropped series.

### Percentile classes are decided by the thresholds published

**Decision:** A value at or above p75 is `above-normal` whether or not p95 is published; below p25 is `below-normal` whether or not p10 is, and below p10 is `low` whether or not p05 is — the label then names the missing threshold (`≥ 75th percentile; 95th not published`). `normal` needs both p25 and p75. A value the published thresholds cannot place is `unknown`, labeled with the published thresholds either side and the blank ones between (`25th–95th percentile; 75th not published`). A fully published row classifies and labels exactly as the table below.

**Why:** The Statistics API publishes `"nan"` (read as null) for the outer percentiles a short record cannot support. Testing each band only when both of its bounds were present would report a value above p75 as `normal` and one below p25 as `unknown`, and with a blank p75 would put a value above the median in `below-normal`.

### Depth-below-surface codes rank by water level

**Decision:** For `72019` (depth to water below land surface, ft), `30210` and `99019` (the same in meters), and `72276` (tidal water level as the distance from the measuring point) — the codes in `DEPTH_BELOW_SURFACE_CODES` — a shallower depth ranks higher. `p05`–`p95` are water-level percentiles, so `p95` is the day's shallowest depth and `p05` the deepest; a depth at or shallower than `p95` is `record-high` and one deeper than `p05` is `record-low`, and the other classes and the blank-threshold rules mirror. `currentValue` stays the depth as measured; `percentileLabel` and `comparisonBasis` say the depth is ranked as a water level. Elevation codes (`62610`, `72020`, `72150`), sensor depth below the water surface, and discharge rise with the water and rank as they are.

**Why:** Callers read `percentileClass` as the state of the water, and for a depth the raw value runs the other way: `record-high` on the depth itself would describe an unusually low water table with nothing in the response saying so. The Statistics API publishes these codes already in water-level order (the 5th percentile is the deepest depth), so ranking the raw depth against them would invert every class; one classifier over the negated depth and thresholds serves both orderings.

### A reading with no value is a missing reading

**Decision:** A `continuous` or `daily` row with a null `value` maps to `value: ""`, keeping its `dateTime` and `qualifiers`. Every consumer treats it as missing: `water_get_conditions` does not rank it (`percentileClass: unknown`, a `percentileLabel` and `note` naming the qualifiers, `**Current value:** no data [P,Ssn]`) and prefers another series' measured latest reading when one exists; `water_get_readings` and `water_get_series` render it as `no data` with its qualifiers; the staged canvas table holds `NULL`; and the readings series cap and `water_get_series`'s default selection both rank a series whose every record is no data with the empty ones, through one shared test (`carriesValues`).

**Why:** USGS leaves the value null for a reading it cannot provide — a seasonal gage out of season (`Ssn`), a discontinued sensor (`Dis`), a dry channel (`Dry`), a rating in development (`Rat`), failed equipment (`Eqp`) — and names the reason in the qualifiers. A placeholder number would read as a measurement and rank as an extreme. Keeping the record, rather than dropping it, keeps the qualifier — the only statement of why there is no value.

### Site-series metadata discovery

**Decision:** Resolve identity with OGC v1 `monitoring-locations`, then read one `time-series-metadata` page under the same 45-second deadline, retries included. This distinguishes an unknown site from an empty filtered catalog. No cache is needed for a single page. Cursors bind site, parameter, series type, and page size; an absolute offset is reconstructed into a fixed-origin URL. Offset paging preserves position when upstream next links switch between cursor and offset styles.

**Values and continuation:** Keep separate sensors/statistics, raw computation fields, null metadata, and full UTC bounds. Only `Daily` maps to `daily`; only `Points` with `Instantaneous` maps to `instantaneous`. For `water_get_series`, take YYYY-MM-DD from bounds, pass a statistic only for daily data, and pass the row's `timeSeriesId` as `methodId`. Bounds may have gaps and lag observations. `nextCursor` discloses and retrieves the remaining pages, so `devcheck.config.json` exempts this cursor-paged tool from the count/truncation heuristic; no total is invented.

### One 45-second deadline per tool call

**Decision:** Each tool call starts one budget (`startDeadline()`, `request-deadline.ts`) at handler entry. Every request, retry, backoff, page, and chained lookup in the call draws on it, as do the waits on the shared catalog reads; in `getReadings` and `getSeries` the first failure stops the call's other requests. `USGS_REQUEST_TIMEOUT_MS` bounds each request within it.

**Why:** 45 seconds keeps the call under the 60-second default request timeout of MCP SDK clients, so a stalled upstream ends in this server's classified `upstream_timeout` rather than a transport timeout the caller cannot read. A budget per request would let a call with several requests and retries run past that limit.

### Instantaneous ranges run in 366-day chunks

**Decision:** An instantaneous `water_get_series` range is read from `continuous` as site-local-day windows of at most 366 days, sent as explicit UTC instants, four at a time, after the series metadata's earliest `begin` has trimmed the start. The range ends at today on the site's clock; when the metadata lists no series for the query, only the last 366 days to that end are read, in one request. A record repeated at a chunk seam counts once.

**Why:** `continuous` rejects a time envelope over 1,100 days, and a date-only `time` bound reads as the UTC-midnight instant, never a day. One calendar year (leap years included) stays one query, about 105,000 rows for a 5-minute sensor and three pages, and a multi-year range returns whole instead of failing. `daily` has no such cap and is one query. A series the metadata does not list yet is at most about a day old, since the metadata refreshes about daily, so a century-long range for one costs one request instead of ~127.

### Timestamps are site-local

**Decision:** An instantaneous `dateTime` is the site's local time with its UTC offset (`2026-11-01T01:15:00.000-05:00`), from the monitoring location's time-zone code and daylight-saving flag; all 53 `time-zone-codes` are covered, daylight time follows the US federal dates at 2 a.m. on each site's own clock, and a site with no known zone reads `+00:00`. A daily `dateTime` is `YYYY-MM-DDT00:00:00.000`. `water_get_series` dates are site-local calendar days.

**Why:** Sites in one state can differ in offset, and callers compare instants across them. The collections return UTC, so the offset is applied at the edge, and each site-local day is converted to the UTC instants a query needs.

### The optional `USGS_API_KEY`

**Decision:** When `USGS_API_KEY` is set, every request carries it as the `X-Api-Key` header and nowhere else. A 429 reads the limit and `Retry-After` the API states, closes that host's cooldown gate so later requests wait or fail fast inside their deadline, and surfaces as `RateLimited`; a rejected key surfaces as `ConfigurationError` naming `USGS_API_KEY`; with no key set, the same error says the request went without a key and to set one.

**Why:** Anonymous traffic is limited per IP address per hour (1,000 on the OGC collections), which a shared or hosted deployment exhausts; a key moves the limit to the key. A single local user needs none.

### Parameter codes: curated table plus full-catalog search

**Decision:** `water_list_parameters` keeps its curated table as the no-argument answer (no network call) and adds `query`, which searches the full USGS parameter-code catalog (`api.waterdata.usgs.gov/ogcapi/v1/collections/parameter-codes`). The catalog is read whole in one request on the first query, cached in module scope for 24 hours (upstream sends `max-age=86400`), shared by concurrent first callers through one in-flight fetch, and searched locally: every query token must start a word in the name or description, and a bare 5-digit query is a code lookup. Curated matches come first, then name matches, then description-only matches, each by code, capped at 25 with `total`/`truncated`. The curated table lives once in `services/waterdata/curated-parameters.ts`, shared by the tool and `usgs-water://parameters`.

**Why:** Every tool's `parameterCd` sends callers here, and the 11 curated codes cover none of turbidity, nitrate, chlorophyll, suspended sediment, or salinity — 19,617 codes exist. Bundling the catalog means shipping megabytes kept current by hand; a per-query upstream search spends one request per call against the anonymous hourly limit, and CQL2 `LIKE` is case-sensitive while `ILIKE` returns HTTP 400. The cached catalog measures about 4.1 MB of heap under Bun and 4.4 MB under Node (19,617 records, measured as the heap delta across the first read after forced GC); a search over it takes ~4 ms. `query` with a `group` other than `all` is rejected because `group` has no mapping onto the catalog's `parameter_group_code`. A failed fetch throws a retryable `upstream_error` and is never cached — answering from the curated table alone would read as "no catalog code matched".

**Label corrections:** the curated names were checked against the catalog, which corrected two: `62610` is groundwater level above NGVD 1929 (not NAVD 88), and `72150` is groundwater level above local mean sea level (not depth below measuring point).

### No `water_get_groundwater_levels` tool

**Decision:** Not built; see "Groundwater: continuous series, not a dedicated endpoint" above.

---

## Known Limitations

- **No geosearch by radius** — `monitoring-locations` is queried by bbox and state/county/HUC filters, not radius-from-point. Agents wanting "sites near lat/lng" must compute a bbox from the coordinates + desired radius before calling `water_find_sites`.
- **Percentile data gap** — the Statistics API publishes percentiles only for series with a long enough approved record. New gages and sparse-measurement wells return none, and a series with only daily maximum or minimum normals ranks nothing. `water_get_conditions` degrades gracefully.
- **Wells measured by hand** — many GW wells have only periodic field measurements, no continuous series. `water_find_sites` lists them (`hasDataTypeCd: "gw"`, or any search that leaves `hasDataTypeCd` unset) and reports when they were last measured, but `water_get_readings` and `water_get_series` return no values for them; no tool returns field-measurement values, peaks, or discrete water-quality samples.
- **Provisional data** — real-time values carry the `P` (Provisional) qualifier. Provisional data may be revised. The server surfaces qualifiers; callers should not treat provisional values as finalized.
- **Rate limits** — anonymous requests share a per-IP hourly limit (1,000 on the OGC collections). The client sets a descriptive User-Agent, backs off on a 429 within the call's deadline, and surfaces it as `RateLimited` carrying `retryAfter`; a deployment that serves several users sets `USGS_API_KEY`.

---

## API Reference

### URL patterns

```
Instantaneous:  GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items?filter-lang=cql2-text&filter=monitoring_location_id IN ('USGS-01646500') AND parameter_code IN ('00060')&time=PT2H&properties=…&skipGeometry=true&limit=50000
Daily:          GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/daily/items?monitoring_location_id=USGS-01646500&parameter_code=00060&statistic_id=00003&time={YYYY-MM-DD}/{YYYY-MM-DD}&limit=50000
Series:         GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items?monitoring_location_id=USGS-01646500&parameter_code=00060&computation_period_identifier=Points|Daily&limit=10000
Sites:          GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items?bbox={w,s,e,n}&state_code={FIPS}&hydrologic_unit_code={huc}&filter-lang=cql2-text&filter=…&limit=50000
Recency:        GET https://api.waterdata.usgs.gov/ogcapi/v1/collections/{latest-continuous|latest-daily|latest-field-measurements|peaks}/items?…&time={observedWithin}&skipGeometry=true
Percentiles:    GET https://api.waterdata.usgs.gov/statistics/v0/observationNormals?monitoring_location_id=USGS-01646500&parameter_code=00060&normal_type=DOY&computation_type=percentile&start_date=MM-DD&end_date=MM-DD
Months:         GET https://api.waterdata.usgs.gov/statistics/v0/observationIntervals?monitoring_location_id=USGS-01646500&parameter_code=00060&interval_type=M&computation_type=arithmetic_mean&parent_time_series_id={id}
```

### Response shapes

An OGC `continuous` row (a `daily` row has the same properties with a `YYYY-MM-DD` `time`):

```jsonc
{
  "id": "…",                                        // row UUID
  "properties": {
    "time_series_id": "1a2b…",                      // 32 hex characters — the methodId
    "monitoring_location_id": "USGS-01646500",
    "parameter_code": "00060",
    "statistic_id": "00011",
    "time": "2026-11-11T03:35:00+00:00",            // UTC
    "value": "5230",                                // null when USGS holds no value
    "approval_status": "Provisional",               // or "Approved"
    "qualifier": ["ESTIMATED"]                      // words, or null
  }
}
```

A Statistics API `observationNormals` feature (one per site; `data` holds one entry per daily-mean, daily-maximum, and daily-minimum series):

```jsonc
{
  "properties": {
    "data": [{
      "parent_time_series_id": "…",                 // the daily-mean series' ID
      "parent_statistic_id": "00003",
      "values": [{
        "computation": "percentile",
        "time_of_year": "11-11",
        "percentiles": ["5", "10", "25", "50", "75", "90", "95"],
        "values": ["…", "…", "…", "…", "…", "…", "nan"]   // decimal strings, one per percentile; "nan" where unpublished
      }]
    }]
  }
}
```

### Key parameter codes (the curated table, `services/waterdata/curated-parameters.ts`)

| Code | Name | Unit | Domain |
|:-----|:-----|:-----|:-------|
| `00060` | Discharge | ft³/s | streamflow |
| `00065` | Gage height | ft | streamflow |
| `00010` | Temperature, water | °C | temperature |
| `00045` | Precipitation | in | meteorological |
| `00095` | Specific conductance | µS/cm at 25°C | water quality |
| `00300` | Dissolved oxygen | mg/L | water quality |
| `00400` | pH | std units | water quality |
| `72019` | Depth to water level below land surface | ft | groundwater |
| `72020` | Elevation above NGVD 1929 | ft | groundwater |
| `72150` | Groundwater level above LMSL | ft | groundwater |
| `62610` | Groundwater level above NGVD 1929 | ft | groundwater |

### Statistics API fields

`observationNormals` entries carry `parent_time_series_id` (the daily-mean series the percentiles belong to), `parent_statistic_id` (`00003` daily mean; the API also publishes `00001` and `00002` normals), and per day `time_of_year` (`MM-DD`) with parallel `percentiles` and `values`. `observationIntervals` entries carry `parent_time_series_id` and per approved month a `start_date`–`end_date` span, from which `periodOfRecord` — the first and last water year whose span holds the calendar day — is read. February 29 falls inside no common year's February span, and October–December belong to the next water year.

### Percentile classification table

Each class ships with the `percentileLabel` below alongside it. `record-high` and `record-low` name percentile-of-record extremes, not verified all-time records — the API publishes the observed extremes as separate daily maximum and minimum normals, which this tool does not read. Since the raw `percentileClass` value is what reaches `structuredContent`, and schema description text is invisible wherever that value is read, the label has to be its own runtime field.

| Condition (`percentileClass` value) | Percentile range | `percentileLabel` |
|:-------------------------------------|:----------------|:------------------|
| `record-high` | ≥ p95 | ≥ 95th percentile (percentile-of-record extreme, not a verified all-time record) |
| `above-normal` | p75 – p95 | 75th–95th percentile |
| `normal` | p25 – p75 | 25th–75th percentile |
| `below-normal` | p10 – p25 | 10th–25th percentile |
| `low` | p05 – p10 | 5th–10th percentile |
| `record-low` | < p05 | < 5th percentile (percentile-of-record extreme, not a verified all-time record) |
| `unknown` | non-numeric reading | insufficient percentile data |
| `unknown` | reading USGS reported as no data (empty value) | no value to rank — USGS reported no data for this reading (qualifiers: P, Ssn) |

When an outer threshold is blank, the class is decided by the published ones and the label names what is missing:

| Blank | Value | `percentileClass` | `percentileLabel` |
|:------|:------|:------------------|:------------------|
| p95 | ≥ p75 | `above-normal` | ≥ 75th percentile; 95th not published |
| p10 | < p25 (≥ p05 when published) | `below-normal` | < 25th percentile; 10th not published |
| p05 | < p10 | `low` | < 10th percentile; 5th not published |
| p25 or p75 | not placed by any published threshold | `unknown` | the nearest published thresholds and the blank ones between, e.g. 25th–95th percentile; 75th not published |
| all five | any | `unknown` | no percentile thresholds published |

For a depth-below-surface code (`72019`, `30210`, `99019`, `72276`) the same table applies to the water level: a depth at or shallower than `p95` is `record-high`, one deeper than `p05` is `record-low`, the other classes and the blank-threshold rows mirror, and `percentileLabel` ends with ` — depth ranked as a water level (shallower ranks higher)`.

The calendar day is the observation timestamp's own `MM-DD`, read from its site-local `YYYY-MM-DD` prefix. The timestamp carries the site's UTC offset and the Statistics API's `time_of_year` is a plain calendar day, so parsing through `Date` would re-project the instant into the runtime's timezone and select a neighboring day for readings near midnight.

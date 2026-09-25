# USGS Water Data MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `water_find_sites` | Find USGS monitoring sites by bounding box, state, county, or HUC. Filter by site type and parameter availability. Returns site number, name, type, coordinates, and drainage area (expanded mode only) — altitude is included in both modes when recorded. Required discovery step — downstream tools key on site numbers, and parameter availability varies. Exactly one major filter (`bbox` \| `stateCd` \| `countyCd` \| `huc`) is required, enforced in the handler before the upstream call; `siteType`/`parameterCd`/`hasDataTypeCd` only narrow within it. `limit`/`offset` page the in-memory match set at 500 per page (`truncated` means matches remain after the returned window, `upstreamTotal` holds the full count); NWIS has no limit param, so with DataCanvas enabled a match set past 500 also stages in full to a canvas for gap-free retrieval via `water_dataframe_describe` then `water_dataframe_query`. | `bbox`, `stateCd`, `countyCd`, `huc`, `siteType`, `parameterCd`, `hasDataTypeCd`, `siteOutput`, `limit`, `offset`, `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_readings` | Get the latest instantaneous values (real-time, ~15 min) for one or more sites. Returns per-site results each including the siteNumber, parameter code, timestamp, value, unit, and provisional/approved qualifier. Accepts up to 100 site numbers in one call. A site measuring one parameter with several sensors returns one series per NWIS method, each named by `methodId`/`methodDescription`. Omitting `parameterCd` returns every parameter each site publishes, so at most 100 series return per call, kept round-robin across sites, with the pre-cap count in `totalSeries`. Each series is capped at its 10 most recent records with the true count in `totalValues`; `truncated` flags either cap — `water_get_series` is the tool for a full series. Requested sites NWIS returns nothing for are named in `missingSites`, so a partial batch is visible rather than inferred. | `sites` (array), `parameterCd` (array), `period` (ISO 8601 duration, e.g. `PT2H`, `P7D`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_series` | Get a time series of daily or instantaneous values for a site and parameter over a date range. Returns `siteNumber`, `parameterCd`, the `statCd`/`methodId` of the one series selected, value records (date/time, value, qualifiers), and `otherSeries` listing every other statistic × method NWIS returned for the query. Defaults to the daily mean (`00003`) when a mean series carries values, and the method with the most records. Large result sets (>500 rows) return the most recent records inline with `truncated: true`; with DataCanvas enabled the complete series also spills to a canvas (`canvas_id`/`table_name`) for gap-free retrieval via `water_dataframe_describe` then `water_dataframe_query`. | `site`, `parameterCd`, `startDate` (YYYY-MM-DD), `endDate` (YYYY-MM-DD), `seriesType` (`daily` \| `instantaneous`), `statCd`, `methodId`, `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_conditions` | Get current conditions at a site placed in historical context: today's value ranked against the site's daily percentile record for the same calendar day. Returns the current reading alongside the percentile class (`record-high` / `above-normal` / `normal` / `below-normal` / `low` / `record-low`), a `percentileLabel` stating that class's threshold in plain language, and a `comparisonBasis` disclosing that an instantaneous reading is ranked against approved daily-mean percentiles. The reading comes from one of the site's methods for the parameter, named by `methodId` — the method a stat series is described as when one is, otherwise the most recent; percentiles come from the stat series that method's description identifies (`methodMatched` reports whether the two descriptions are identical). A "how unusual is this reading" ranking — not a flood-stage or drought determination, which need authoritative thresholds this tool does not fetch. | `site`, `parameterCd` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_list_parameters` | Look up USGS parameter codes. Without `query`: the curated table of well-known codes with names, units, and domain — no network call — so an agent learns that `00060` = "Discharge" (cfs), `00065` = "Gage height" (ft), `00010` = "Temperature" (°C), `72019` = "Depth to water, below land surface" (ft). With `query`: a word-prefix search of the full USGS parameter-code catalog (~19,600 codes) by name and description, or a bare 5-digit code lookup; entries carry `source` (`curated` \| `usgs-catalog`), curated matches first, capped at 25 with `total`/`truncated`. | `group` (curated filter: `streamflow` \| `groundwater` \| `temperature` \| `meteorological` \| `water-quality` \| `all`), `query` (catalog search; not combinable with a `group` other than `all`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude. Stable URI for a known site number. | No |
| `usgs-water://parameters` | The curated table of well-known parameter codes — the list `water_list_parameters` returns without a query, from the same shared table. Injectable context for clients that support resources. | No |

### Prompts

None — this server is data-oriented; no recurring analysis templates worth structuring as prompts.

---

## Overview

USGS Water Data MCP Server exposes real-time and historical water data from the USGS National Water Information System (NWIS). Coverage: ~8,000 active stream gages and thousands of groundwater wells across the US and territories. Data is keyless and public.

Primary use cases: see whether a river is running unusually high or low for the date before a trip; pull a streamflow time series for trend analysis; compare current groundwater depth against historical norms; find nearby monitoring sites for a region of interest.

---

## Requirements

- Read-only access to USGS NWIS Water Services (no auth, no API key)
- Real-time (instantaneous, ~15 min) values from the IV service
- Historical daily values from the DV service
- Site discovery via the NWIS site service (bbox, state, county, HUC, parameter filter)
- Percentile/conditions context via the NWIS stat service
- Groundwater levels via the IV service with parameter code `72019` (depth to water) — the legacy `gwlevels` endpoint was decommissioned November 2025
- Parameter code discovery: a built-in curated table (no network call), plus search of the full USGS parameter-code catalog
- Multi-site batching: IV/DV accept comma-separated site lists (up to 100) in one call
- Error handling: NWIS returns HTML 400 pages for bad inputs, not JSON — must detect and parse HTML errors
- Provisional vs. approved data qualifiers surfaced to callers (not hidden)
- Large result sets spill to DataCanvas for agent SQL analysis (requires `CANVAS_PROVIDER_TYPE=duckdb`): date-range series (>500 records) from `water_get_series`, and site match sets (>500 sites) from `water_find_sites`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `nwis-service` | USGS NWIS Water Services (`waterservices.usgs.gov`) — IV, DV, site, stat endpoints | Every data tool and the site resource |
| `waterdata/parameter-catalog` | USGS Water Data OGC API `collections/parameter-codes` (`api.waterdata.usgs.gov/ogcapi/v1`) — the full parameter-code catalog, read whole and cached | `water_list_parameters` (`query`) |

No OGC API service at launch. The OGC API (`api.waterdata.usgs.gov/ogcapi/v0`) is the USGS long-term replacement for NWIS, but its geosearch (monitoring-locations bbox) is currently unreliable (returns 0 results in probing), and its IV/DV equivalents (`latest-continuous`, `daily`) require different site ID format (`USGS-01646500` vs `01646500`). NWIS iv/dv/site/stat remain stable, JSON-capable, and well-documented. OGC API adoption is noted as a future path once its search is reliable. The one exception is the parameter-code catalog, which has no NWIS equivalent — see "Parameter codes: curated table plus full-catalog search".

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas spillover for large result sets (`water_get_series` series, `water_find_sites` match sets). Optional — without it, both tools return a truncated preview with an overflow signal. |
| `USGS_USER_AGENT` | No | Custom User-Agent string for USGS requests. USGS requests a descriptive User-Agent per their terms; defaults to `usgs-water-mcp-server/0.2.5 (contact: https://github.com/cyanheads/usgs-water-mcp-server)`. |
| `USGS_REQUEST_TIMEOUT_MS` | No | HTTP timeout in milliseconds for every USGS request — NWIS and the parameter-code catalog. Default `30000`. |
| `MCP_TRANSPORT_TYPE` | No | `stdio` (default) or `http`. Framework-managed. |
| `PORT` | No | HTTP port when transport is `http`. Default `3000`. Framework-managed. |

---

## Implementation Order

1. **Config and service setup** — `src/config/server-config.ts` (USGS user-agent, request timeout), `src/services/nwis/nwis-service.ts` (fetch wrapper, HTML-error detection, retry config, RDB parser for site/stat responses)
2. **Parameter lookup tool** — `water_list_parameters`: curated table with no network call; `query` searches the full USGS parameter-code catalog through `services/waterdata/`
3. **Site discovery tool** — `water_find_sites`: calls NWIS site service (RDB format), parses tab-delimited response, returns structured site records
4. **Readings tool** — `water_get_readings`: calls NWIS IV service (JSON format), multi-site batch, returns latest values per site/parameter
5. **Series tool** — `water_get_series`: calls NWIS DV or IV depending on `seriesType`, date-range pagination, DataCanvas spillover for large ranges
6. **Conditions tool** — `water_get_conditions`: calls NWIS IV (current value) + NWIS stat (percentile table) in parallel, computes percentile class
7. **Resources** — `usgs-water://site/{siteId}` and `usgs-water://parameters`

Each step independently testable: the service layer can be unit-tested with mock fetch; tools can be tested against fixture payloads; stat + IV combination in step 6 is the highest-complexity integration.

---

## Domain Mapping

| Noun | NWIS Endpoint | Format | Notes |
|:-----|:-------------|:-------|:------|
| Sites (discovery) | `/nwis/site` | RDB (tab-delimited) | `format=rdb`, `siteOutput=basic\|expanded`, filter by `bBox`, `stateCd`, `countyCd`, `huc`, `siteType`, `hasDataTypeCd`, `parameterCd` |
| Instantaneous values | `/nwis/iv` | JSON (WaterML-JSON) | `format=json`, multi-site via `sites=a,b,c`, `period=PTnH` or `startDT/endDT`. An unknown site in a multi-site request is dropped from the response without comment — the request/response diff is the only signal. One `timeSeries` per site + parameter (statistic `00000`), carrying one `values[]` block per method; the `statCd` keyword is rejected with HTTP 400 |
| Daily values | `/nwis/dv` | JSON (WaterML-JSON) | `format=json`, same site/param/date params as IV. One `timeSeries` per statistic (`00001` max, `00002` min, `00003` mean, …), each with one `values[]` block per method; `statCd=<code>` returns that statistic alone (an unpublished code returns an empty `timeSeries`, a malformed one HTTP 400) |
| Statistics (percentiles) | `/nwis/stat` | RDB | `format=rdb`, `statReportType=daily`, `statType=all`, returns p05–p95 per calendar day, one row set per time series (`ts_id`, `loc_web_ds`). The `ts_id` is the daily-mean series' DV method ID, never the IV method ID |
| Parameter codes | OGC API `/ogcapi/v1/collections/parameter-codes/items` (curated table built in) | GeoJSON | Curated codes come from `services/waterdata/curated-parameters.ts` with no network call. A `query` reads the whole catalog in one request — `f=json&limit=50000&properties=parameter_name,unit_of_measure,parameter_description` (~19,600 records, ~6 MB uncompressed) — following any `next` link; the record `id` is the code. Upstream `q=` is not used: CQL2 `LIKE` is case-sensitive and `ILIKE` returns HTTP 400 |

### Accepted input formats

Verified against the live service; encoded as Zod patterns in `services/nwis/input-schemas.ts` and shared by every tool that forwards a value into an NWIS query parameter.

| Input | NWIS accepts | Notes |
|:------|:-------------|:------|
| `site` / `sites` | 8–15 digits | Zero-padded (e.g. `01646500`) |
| `parameterCd` | Exactly 5 digits | Comma-separated lists are accepted on the site service and the IV/DV endpoints, so `water_find_sites` allows them; `water_get_series` and `water_get_conditions` take a single code because they return a single series |
| `period` | ISO 8601 duration | Full grammar, not a fixed subset. Negative periods (`P-T2H`) are rejected by NWIS |
| `huc` | **2 digits or 8 digits only** | A major HUC is 2 digits, a minor HUC is 8. 4- and 6-digit values return `invalid huc argument`; 10- and 12-digit values return `Huc: length must be no greater than 8 characters`. (Distinct from the `hucCd` *output* field, where site records can carry longer values.) |
| `countyCd` | Bare 5-digit FIPS | State and county digits concatenated (`51013`), comma-separated up to 20. The colon form `51:013` returns `invalid fips5 county code string argument length` |
| `stateCd` | 2 letters | Longer values return `StateCd length must be no greater than 2 characters` |
| `bbox` | 4 comma-separated decimal numbers | `west,south,east,north`. NWIS validates only that they parse as decimal degrees; no further geographic checking is layered on top |
| major filter | **Exactly one** of `bbox`, `stateCd`, `countyCd`, `huc` | A site query scopes by one of the four and no more. Zero returns `no major-filter pairs supplied by user`; two or more return `Only one Major filter can be supplied. Found [stateCd] and [countyCd]`. `countyCd`'s 5 FIPS digits already encode the state, so pairing it with `stateCd` is redundant as well as rejected. `water_find_sites` enforces the rule in its handler — see the decision record below |

---

## Workflow Analysis

### `water_get_conditions` (2 parallel upstream calls)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1a | `GET /nwis/iv?format=json&sites={siteId}&parameterCd={code}&period=PT2H` | Current value with qualifier |
| 1b | `GET /nwis/stat?format=rdb&sites={siteId}&parameterCd={code}&statReportType=daily&statType=all` | Full daily percentile table |
| 2 | Select: one method's latest reading — measured before no-data, then a method a stat series is described as exactly, then the most recent (ties keep NWIS response order) — then the stat series to rank it against | One reading, one percentile series |
| 3 | Compute: look up the observation's own month+day in that stat series, find the bounding percentiles | Classify into `record-high`/`above-normal`/`normal`/`below-normal`/`low`/`record-low` |

Calls 1a and 1b run in `Promise.all`. The stat percentiles are computed from **approved daily-mean** values, while call 1a returns an **instantaneous** reading — NWIS publishes no instantaneous percentile product — so `percentileClass` is a cross-granularity approximation ("how unusual is today's reading for this calendar day"), not a flood-stage or drought determination. `historicalContext.comparisonBasis` states this at runtime.

The stat call is captured, not awaited-to-throw, so an operational stat failure stays distinct from a genuinely empty table. `historicalContextStatus` reports which case occurred: `available` (percentiles present), `no_matching_day` (rows exist but none for the observation's calendar day), `no_matching_method` (the table covers several sensor series and none is identified by the reporting method's description — see the decision record on method matching), `no_record` (empty table — new site or record too short), or `unavailable` (the stat call failed — transient, retryable, and never attributed to the site's history). Every case still returns the current reading — partial success, not a throw. Only an IV-side failure — a 5xx, a timeout, or a body that is not valid WaterML-JSON — throws `upstream_error`.

---

## Error Contracts

Typed failure contracts for the network-calling tools and the `usgs-water://site/{siteId}` resource. `water_list_parameters` reaches the network only for a `query`; its contract follows the NWIS tools'.

**Classification is code-based, not message-based.** `nwis-service` already types every failure it raises — an HTML 400 becomes a `validationError`; a 5xx, or an IV/DV body that is not valid WaterML-JSON, becomes a `serviceUnavailable` — and `classifyNwisFailure()` maps that code onto the reason vocabulary below. Tools never re-match the error prose to guess a field.

**`invalid_request` names no field on purpose.** NWIS wraps every rejection in identical text (`NWIS rejected the request: …`) and reports the offending field only inside its own message — and not always the field the caller passed (`period=P99999D` comes back as a complaint about `StartDT`). Selecting a reason by pattern-matching that prose is what made a bad `period` surface as a bad site number. The reason states what the server knows — NWIS refused the request — and the message carries NWIS's verbatim text for the caller to act on.

### `water_find_sites`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_sites_found` | `NotFound` | No sites match the given filters | No — broaden bbox/state/HUC or remove parameterCd/siteType filter |
| `missing_major_filter` | `ValidationError` | None of `bbox`/`stateCd`/`countyCd`/`huc` was supplied. Raised in the handler before any NWIS call | No — add exactly one major filter |
| `conflicting_major_filters` | `ValidationError` | More than one of them was supplied. Raised in the handler before any NWIS call; the message names the fields that were sent | No — keep one and drop the others |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400. Filter formats are pattern-validated and the major-filter rule is enforced before the call, so this is a well-formed value NWIS still refused (an unknown state, county, HUC, parameter, or site-type code) | No — read the NWIS message in the error for what it refused |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx or network timeout | Yes — retry after backoff |
| `canvas_not_found` | `NotFound` | A supplied `canvas_id` names a canvas that never existed or has expired. Resolved before the upstream call, so a bad id costs no NWIS round trip | No — omit `canvas_id` for a fresh canvas |
| `canvas_capacity_exhausted` | `RateLimited` | A fresh canvas was needed to stage the match set and the tenant is at its active-canvas cap | Yes — reuse a prior `canvas_id`, or retry once one expires |

**The major-filter rule lives in the handler, not the schema.** A Zod `.superRefine()`/`.refine()` contributes nothing to the advertised JSON Schema and rejects at the SDK edge as the framework's generic `invalid_arguments`, bypassing `errors[]` entirely — so the caller gets a schema-derived diagnostic instead of a typed reason with an authored recovery hint. Cross-field bounds a caller is expected to recover from belong in the handler; the rule is restated in each major filter's `.describe()` so it is still visible before the call.

### `water_get_readings`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_parameter` | `NotFound` | No time series returned, or every series came back empty. NWIS gives the same response for an unknown site and a valid site with no data for the parameter/period, so the two are indistinguishable here | No — check the site and its parameters via `water_find_sites` |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the input patterns | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx, a network timeout, or a body that is not valid WaterML-JSON (cut off mid-document), after the service's own retries | Yes — retry after backoff |

A batch where *some* sites return data is a success, not an error: the returned series are in `readings` and the rest are named in `missingSites`. A batch past the 100-series cap is a success too — `totalSeries` exceeds `total` and `truncated` is set (see the series-cap decision below).

### `water_get_series`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_range` | `NotFound` | Site/parameter combination has no data in the requested date range (also covers an unknown site — NWIS returns the same empty response) | No — narrow the date range or check parameter availability |
| `invalid_date_range` | `ValidationError` | This tool's own date validation: `endDate` before `startDate`, or a date that matches `YYYY-MM-DD` but is not a real calendar date. Never reaches NWIS | No — correct the date range |
| `invalid_stat_cd` | `ValidationError` | `statCd` is not a 5-digit code. Checked in the handler before any NWIS call | No — pass a code such as `00003`, or omit it |
| `stat_cd_for_instantaneous` | `ValidationError` | A `statCd` other than `00000` on an instantaneous series — the IV service carries no other statistic and rejects the keyword. Checked before any NWIS call | No — omit `statCd`, or use `seriesType: "daily"` |
| `method_not_found` | `NotFound` | No returned series carries the requested `methodId` (within the requested `statCd`), or that method had no values over the range. The recovery hint lists every `statCd`/`methodId` that does exist | No — re-request with a listed id, or omit `methodId` |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the input patterns | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx, a network timeout, or a body that is not valid WaterML-JSON (cut off mid-document), after the service's own retries | Yes — retry after backoff |
| `canvas_not_found` | `NotFound` | A supplied `canvas_id` names a canvas that never existed or has expired. Resolved before the upstream call, so a bad id costs no NWIS round trip | No — omit `canvas_id` for a fresh canvas |
| `canvas_capacity_exhausted` | `RateLimited` | A fresh canvas was needed to stage the series and the tenant is at its active-canvas cap | Yes — reuse a prior `canvas_id`, or retry once one expires |

### `water_get_conditions`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_parameter` | `NotFound` | No IV series returned, or the series carries no current reading. Covers an unknown site and a valid site without the parameter alike | No — check parameter availability via `water_find_sites` |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the input patterns | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | The NWIS IV endpoint returns 5xx, a network timeout, or a body that is not valid WaterML-JSON (cut off mid-document), after the service's own retries. A stat-side failure never raises it | Yes — retry after backoff |

Note: absence of stat data is **not** an error — `water_get_conditions` returns the current reading with `historicalContext: null` and a note. `historicalContextStatus` discriminates *why* it is absent: `no_record` (empty table — new site or record too short), `no_matching_day` (rows exist but none for the observation's calendar day), `no_matching_method` (several stat series, none identified as the reporting sensor's), or `unavailable` (the stat call failed — transient and retryable, kept distinct from a sparse site). A stat-side failure is caught inline, so it never turns an IV success into a throw; only an IV-side 5xx, timeout, or malformed body surfaces as `upstream_error`. This is partial-success, not a throw.

### `water_list_parameters`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `query_with_group` | `ValidationError` | `query` combined with a `group` other than `all` — `group` has no counterpart in the catalog's own grouping. Raised before any fetch | No — pass `query` alone, or `group` alone |
| `upstream_error` | `ServiceUnavailable` | The catalog request failed, timed out, or returned something other than a catalog page | Yes — retry after backoff |

A query that matches nothing is a success with an empty list, `total: 0`, and a `note` suggesting how to broaden it. A failed catalog fetch is never answered from the curated table alone: curated-only results would read as "no catalog code matched".

### `usgs-water://site/{siteId}` (resource)

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `not_found` | `NotFound` | No site exists for the given (well-formed) site number | No — verify the site number via `water_find_sites` |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the 8–15 digit edge schema | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx or network timeout | Yes — retry after backoff |

The `siteId` param carries the shared 8–15 digit `SiteNumberSchema`, so a malformed site number is rejected at the resource edge before any NWIS call — the same edge validation the four tools apply.

---

## Design Decisions

### Endpoint selection: NWIS as primary, OGC API deferred

**Decision:** Use NWIS (`waterservices.usgs.gov`) as the sole data source at launch. Do not use `api.waterdata.usgs.gov` OGC API except as a future adoption path.

**Rationale verified by live probing (2026-06-04):**
- NWIS IV (`/nwis/iv?format=json`) is live, returns structured JSON (WaterML-JSON), supports multi-site batching, and is well-documented
- NWIS DV (`/nwis/dv?format=json`) is live with same interface, long historical records (Potomac: 96 years)
- NWIS site service (`/nwis/site?format=rdb`) is live, supports bbox/state/HUC/parameter filters, returns parseable RDB
- NWIS stat (`/nwis/stat?format=rdb`) is live, returns full daily percentile tables
- OGC API `monitoring-locations` bbox search returns 0 results for tested bounding boxes — unreliable for geosearch
- OGC API `daily` and `latest-continuous` collections require `USGS-{siteId}` format (not bare site number) and returned 0 results for the tested site in initial probing; the `latest-continuous` endpoint did return results when unfiltered but with a different feature structure
- OGC API is the USGS long-term replacement, but not yet stable enough to be the primary path

**gwlevels decommission:** The legacy `gwlevels` endpoint was decommissioned November 1, 2025 (confirmed: returns 301 redirect to the decommission blog at `waterdata.usgs.gov/blog/api-decom-fall-2025`). Groundwater depth (`72019`) is accessible via the standard IV service — confirmed working for wells with real-time sensors.

**Forward path:** When OGC API `monitoring-locations` bbox search becomes reliable and `daily`/`continuous` collections stabilize with consistent ID formatting, the NWIS service can be migrated incrementally without changing the tool surface.

### Groundwater: IV-based, not a dedicated endpoint

**Decision:** Groundwater levels (depth-to-water, parameter `72019`) are handled by `water_get_readings` and `water_get_series` like any other parameter — not a dedicated `water_get_groundwater_levels` tool.

**Rationale:** The legacy `gwlevels` endpoint is gone. The IV/DV path handles `72019` correctly (confirmed: returns "Depth to water level, ft below land surface"). The original sketch proposed a separate GW tool because `gwlevels` had different semantics (field measurements vs. continuous), but that distinction collapses when the only live path is IV. A dedicated GW tool would duplicate `water_get_readings` with no added value. Discovery is handled by `water_find_sites` with `siteType=GW` filter and `parameterCd=72019`.

### Error handling: HTML 400 responses

**Decision:** The NWIS service layer must detect and handle HTML error pages. NWIS returns HTTP 400 with an HTML body (not JSON) for invalid inputs (bad site ID format, unsupported parameter combinations). The service layer should: check `Content-Type`, detect HTML error pages, extract the error message from the `<h1>` or `<title>` tag, and throw a `validationError` with that message.

### Error handling: an IV/DV body that is not WaterML-JSON

**Decision:** The IV/DV readers parse the body inside the retry wrapper. A body that fails `JSON.parse` or carries no `value.timeSeries` array is raised as `serviceUnavailable`, so it is retried like a 503 and, if it persists, reaches every calling tool as `upstream_error`.

**Why:** NWIS sometimes answers HTTP 200 with a body cut off mid-document. Parsed after the retry, it escaped as a raw `SyntaxError` that `classifyNwisFailure()` could not type, and the caller got a generic internal error. Every well-formed IV/DV response carries `value.timeSeries` — an empty array when nothing matched — so its absence marks a broken body rather than an empty result.

### DataCanvas: opt-in for large result sets

**Decision:** `water_get_series` and `water_find_sites` stage large result sets to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` is set. Without DuckDB, each returns a bounded preview with a `truncated` flag: `water_get_series` the most recent 500 rows with a `totalRecords` count, `water_find_sites` the first 500 sites with an `upstreamTotal` count. This avoids making DuckDB a hard dependency while still enabling SQL-based analysis for agents that want it.

**`water_find_sites` stages via `registerTable`, not `spillover()`.** `water_get_series` truncates on a character budget (`spillover()`'s `previewChars`), so `spillover()` — which registers to canvas only when the source exceeds that budget — fits it directly. `water_find_sites` truncates on a hard **count** (`SITE_CAP = 500`, shipped in v0.1.4), and the full match set must land on canvas whenever the count exceeds the cap, independent of serialized size. Driving that off a character budget would silently drop the sites just past the cap for match sets that happen to fit under the budget, so the handler registers the full set directly via `CanvasInstance.registerTable`. The inline preview stays the original capped site objects — no lossy round-trip out of the snake_case canvas rows, which also sidesteps re-deriving the optional expanded fields.

**Staging is keyed to `upstreamTotal`, never the requested `limit`.** `limit`/`offset` window the response; the whole match set is already in memory either way, so gating staging on the window would close the SQL path to a caller who asked for ten sites out of four thousand. The two are independent: the window shapes the inline answer, the cap decides whether the full set is also queryable.

**Staged table names carry every content-changing dimension.** `registerTable` is `DROP TABLE IF EXISTS` + `CREATE TABLE`, so a name that omits part of the query lets two different result sets land on one table — the second replacing the first while the response still reports a successful staging with an unchanged `table_name`. Carrying every dimension literally does not fit the 63-character canvas identifier rule (`countyCd` alone accepts 20 comma-separated codes, 119 characters), so the name is a readable prefix plus a digest: `water_sites_<scope>_<siteType>_<8 hex>`, where `scope` is the 2-letter `stateCd` when present and otherwise the literal `county`, `huc`, or `bbox`; `siteType` is the value when it is a single code and otherwise `all`; and the suffix is the first 8 hex characters of a SHA-256 over the canonical JSON of the full filter set. `canvas_id`, `limit`, and `offset` are excluded from the digest — none of them changes what is staged, and including them would give one query a different table per page. Re-running an identical query therefore replaces its own table and nothing else, while any query whose result could differ lands on a different name. The builders live in `services/canvas/canvas-table-name.ts` and are shared with `water_get_series`, which derives its own name from the same primitives.

**A supplied `canvas_id` is resolved before the upstream request.** Resolving it inside the staging branch meant a stale or never-minted id cost a full NWIS round trip before failing, and that a result fitting inline never looked at the id at all — the response then carried no `canvas_id`, no `table_name`, and no explanation of why nothing was staged. The handler now acquires a supplied id up front and keeps *minting* lazy — a fresh canvas is acquired only when a result actually has to stage. When a supplied id goes unused, the `notice` says so.

**One helper resolves every caller-supplied `canvas_id`.** `acquireCanvas()` (`services/canvas/acquire-canvas.ts`) wraps `canvas.acquire(id, ctx)` for `water_find_sites`, `water_get_series`, `water_dataframe_describe`, and `water_dataframe_query`: a registry `canvas_not_found` is re-thrown through the calling tool's `ctx.fail('canvas_not_found', …)`, so the message is `Canvas <id> not found or expired.` and the hint is that tool's own — the producers name omitting `canvas_id` as the fresh-canvas path, which the framework's hint deliberately avoids; the dataframe tools name the producers. Every other rejection (`canvas_capacity_exhausted`, a provider fault) passes through as the same error. `ctx` is typed `HandlerContext<'canvas_not_found'>`, which any context whose contract declares that reason satisfies and one that lacks it fails to compile. Because the throw now sits outside the handlers, all four tools mark `canvas_not_found` `thrownBy: 'service'`. The lazy mint path (`canvas.acquire(undefined, ctx)`) stays in the producing handlers.

**`water_get_series` names its table from the query plus the series it selected.** `water_series_<site>_<parameterCd>_<dv|iv>_<YYYYMMDD>_<YYYYMMDD>[_<7 hex>]`. The query dimensions are fixed-width and read off the request, so the longest legal input — a 15-digit site number — lands at 55 characters; the abbreviation is what buys the room (`instantaneous` spelled out pushes the name to 66, past the identifier cap). One query can return several series — one per daily statistic and per sensor method — and which one is staged is a selection among what NWIS returned, so a request-only name would let the daily mean and the daily maximum of one query replace each other on a single table. The suffix is the first 7 hex characters of a SHA-256 over the selected `{ statCd, methodId }`, which fills the name to exactly 63 characters at the 15-digit worst case. It is appended whenever a choice was made — the caller passed `statCd` or `methodId`, or the response offered more than one series — and omitted for a query NWIS answered with a single series, so those names are unchanged and re-running one still replaces its own table. The same selection reached two ways (the default pick, or an explicit `statCd` + `methodId` naming it) stages identical rows and lands on the same name. Staged rows also carry `stat_cd` and `method_id` columns. `canvas_id` is excluded for the same reason it is excluded from the `water_find_sites` digest. The tool resolves a supplied `canvas_id` before the NWIS request and reports an unused one in its `notice`, on the reasoning above.

**The canvas preview holds the most recent records, not the oldest.** `spillover()` fills its preview from the head of its source and offers no lever to change that — reversing the source would reverse the staged table along with it. So the handler passes the chronological rows through unchanged and takes its inline slice from the *tail* of the same rows, at the row count the character budget chose: the staged table stays complete and in order, and the inline answer holds the end of the series the way the no-canvas path always has. Without this, two deployments of one server answered "what is the latest value" differently, and the canvas response read as a series that simply ended early. The slice is taken from a computed front index rather than a negative offset, because `slice(-0)` returns the whole array — an empty preview would otherwise inline the full series under a preview caption.

### Series are per statistic × method

**Decision:** The WaterML parser emits one series per `timeSeries` × `values[]` block. Each carries `methodId` and `methodDescription` from the block's `method[0]` (description HTML-decoded, `""` read as null) and the statistic from `variable.options.option[name=Statistic].optionCode`, falling back to the fourth segment of the series `name` (`USGS:01646500:00010:00003`). The two agree on every live response checked.

**Why:** A `timeSeries` carries one block per method — a second sensor, a relocated probe, a discontinued gage kept for its record — and the daily-values service returns one `timeSeries` per statistic. Reading only `values[0]` lost every later sensor, reported "0 records" where the data sat in the second block (`12036400`/`00060`: an empty `[(2)]` block precedes the populated one), and made `water_get_series` answer a multi-statistic daily query with the maximum, unlabeled.

**Empty blocks:** a block with no values is dropped when a sibling block of the same `timeSeries` has values — NWIS keeps discontinued methods in current IV responses as empty blocks, four of them at `01646500`/`00010`. When every block is empty, the first one's series remains, so "this site reports the parameter, with no current values" still surfaces as `no_data_for_parameter` / `no_data_for_range` rather than vanishing.

**Selection, per tool:** `water_get_readings` returns every series, up to its 100-series cap. `water_get_conditions` uses one method's latest reading, ranked on three keys in order: it carries a value (a no-data record yields — see "The NWIS no-data value is a missing reading"); a stat series is described exactly as the method (see below); it is the most recent, ties keeping NWIS response order. `water_get_series` returns one: the daily mean (`00003`) when a mean series carries values, otherwise the first statistic that does — a series whose every record is no data carries none, so it wins only when no series does; within it, the method with the most records (ties keep response order); `statCd` and `methodId` override either choice, and `otherSeries` lists the rest with record counts. `statCd` is forwarded to the DV service, which then returns that statistic alone. The IV service rejects the `statCd` keyword with HTTP 400 and every IV series is `00000`, so on an instantaneous request `00000` is accepted without being sent and any other code is refused in the handler. `methodId` is a string end to end so the value a caller reads back is the value it passes in.

**Percentiles and methods do not share an ID.** The stat service keys its rows by `ts_id`, which is the DV daily-mean series' method ID (`01646500`/`00060`: stat `ts_id` 68478 = DV method 68478; IV method 69928). No legacy NWIS field links an IV method to its DV or stat series. The one attribute both publish is the location description — `loc_web_ds` in the stat table, `methodDescription` in WaterML — and it is not reliably identical for the same sensor: `01646500`/`00010` matches exactly (`From multiparameter sonde`), while `12396500`/`00065` labels its gages `""` / `AUXILIARY GAGE` in IV and `[BASE GAGE]` / `AUXILIARY GAGE, [AUXILIARY GAGE]` in the stat table. So `water_get_conditions` pairs a method with a stat series by description, in two steps, each holding only when exactly one series qualifies: an exact match (`methodMatched: true`), else a match once the stat description's trailing bracketed label is set aside — `[BASE GAGE]` → `""`, `AUXILIARY GAGE, [AUXILIARY GAGE]` → `AUXILIARY GAGE` — which ranks with `methodMatched: false` and a `note` naming the series. `[Discontinued]` is never set aside: it marks a retired series, and setting it aside would pair a live sensor with its predecessor's record. With no pairing, a stat table holding a single series is still used with `methodMatched: false` and a `note` (there is nothing to choose between), and a table holding several yields `no_matching_method` with the candidates listed in `note`, rather than ranking against whichever series comes first — which at `01646500`/`00010` is a sensor discontinued in 2019.

**The reading follows the pairing, not recency alone.** Sensors at one site report minutes apart, so "the most recent reading across methods" picks whichever reported last: at `12056500`/`00010` the unlabeled sensor and the QW sonde alternate, 1.5 °C apart, and the lone stat series (blank description) is the unlabeled sensor's — recency alone ranked the sonde against it on some calls and the unlabeled sensor on others, flipping the class between `normal` and `above-normal`. A method a stat series is described as exactly therefore outranks a more recent unpaired one; recency decides only among equals. Every candidate reading falls within the two-hour IV window, and `currentDateTime` shows which one was used.

### `water_get_readings` caps series at 100, round-robin across sites

**Decision:** At most 100 series return per call, counted after the per-method split. Past that, series are kept round-robin across sites — every site's first series, then every site's second — with a site's valued series ahead of its empty ones (a series whose every record is no data counts as empty), and the kept series stay in NWIS order. `totalSeries` carries the pre-cap count; `truncated` covers both this cap and the 10-record cap, and the `format()` caption names whichever applied.

**Why:** `parameterCd` is optional, so a 100-site batch returns every published parameter at every site, one series per method. Measured with `PT2H`: 100 active Washington stream gages returned 267 series and a 280 KB result (162 KB `structuredContent`, 115 KB `content[]`); California's 100 most-instrumented stream gages, 702 series and 627 KB. At the cap both come to about 105 KB. The cap equals the 100-site input maximum, so every site that returned data keeps a series; requiring `parameterCd` would remove the "everything at this gage" call without bounding a site that publishes many parameters. `totalSeries` counts series as the parser emits them, so a method block dropped because a sibling block carries values is not counted — it differs from `total` only when this cap dropped series.

### Percentile classes are decided by the thresholds NWIS published

**Decision:** A value at or above p75 is `above-normal` whether or not p95 is published; below p25 is `below-normal` whether or not p10 is, and below p10 is `low` whether or not p05 is — the label then names the missing threshold (`≥ 75th percentile; 95th not published`). `normal` needs both p25 and p75. A value the published thresholds cannot place is `unknown`, labeled with the published thresholds either side and the blank ones between (`25th–95th percentile; 75th not published`). A fully published row classifies and labels exactly as the table below.

**Why:** NWIS leaves p05, p10, and p95 blank on short records — common for the sensor-level stat series percentiles are now matched to. Testing each band only when both of its bounds were present reported a value above p75 as `normal` and one below p25 as `unknown`, and with a blank p75 put a value above the median in `below-normal`.

### The NWIS no-data value is a missing reading

**Decision:** The WaterML parser reads each series' `variable.noDataValue` (`-999999`) and maps a record holding it to missing — `value: ""`, the convention a blank record already used — keeping its `dateTime` and `qualifiers`. Every consumer treats it as missing: `water_get_conditions` does not rank it (`percentileClass: unknown`, a `percentileLabel` and `note` naming the qualifiers, `**Current value:** no data [P,Ssn]`) and prefers another method's measured latest reading when one exists; `water_get_readings` and `water_get_series` render it as `no data` with its qualifiers; the staged canvas table holds `NULL`; and the readings series cap and `water_get_series`'s default selection both rank a series whose every record is no data with the empty ones, through one shared test (`carriesValues`).

**Why:** NWIS writes `-999999` for a reading it cannot provide — a seasonal gage out of season (`Ssn`), a discontinued sensor (`Dis`), a dry channel (`Dry`), a rating in development (`Rat`), failed equipment (`Eqp`) — and names the reason in the qualifiers. Passed through as a number, it read as a measurement: `12024000`/`00060` in September reported `-999999 ft3/s` ranked `record-low`. Keeping the record, rather than dropping it, keeps the qualifier — the only statement of why there is no value. The comparison is numeric (`Number(value) === noDataValue`), since the value is a string (`"-999999"`) and `noDataValue` a number (`-999999.0`).

### Parameter codes: curated table plus full-catalog search

**Decision:** `water_list_parameters` keeps its curated table as the no-argument answer (no network call) and adds `query`, which searches the full USGS parameter-code catalog (`api.waterdata.usgs.gov/ogcapi/v1/collections/parameter-codes`). The catalog is read whole in one request on the first query, cached in module scope for 24 hours (upstream sends `max-age=86400`), shared by concurrent first callers through one in-flight fetch, and searched locally: every query token must start a word in the name or description, and a bare 5-digit query is a code lookup. Curated matches come first, then name matches, then description-only matches, each by code, capped at 25 with `total`/`truncated`. The curated table lives once in `services/waterdata/curated-parameters.ts`, shared by the tool and `usgs-water://parameters`.

**Why:** Every tool's `parameterCd` sends callers here, and the 11 curated codes cover none of turbidity, nitrate, chlorophyll, suspended sediment, or salinity — 19,617 codes exist. Bundling the catalog means shipping megabytes kept current by hand; a per-query upstream search spends one request per call on a rate-limited API with no published anonymous quota, and CQL2 `LIKE` is case-sensitive while `ILIKE` returns HTTP 400. The cached catalog measures about 4.1 MB of heap under Bun and 4.4 MB under Node (19,617 records, measured as the heap delta across the first read after forced GC); a search over it takes ~4 ms. `query` with a `group` other than `all` is rejected because `group` has no mapping onto the catalog's `parameter_group_code`. A failed fetch throws a retryable `upstream_error` and is never cached — answering from the curated table alone would read as "no catalog code matched".

**Label corrections:** the curated names were checked against the catalog, which corrected two: `62610` is groundwater level above NGVD 1929 (not NAVD 88), and `72150` is groundwater level above local mean sea level (not depth below measuring point).

### No `water_get_groundwater_levels` tool (as originally sketched)

**Superseded by:** the gwlevels decommission finding. See "Groundwater: IV-based" above.

---

## Known Limitations

- **No NWISWeb geosearch by radius** — the NWIS site service supports bbox and state/county/HUC filters but not radius-from-point search. Agents wanting "sites near lat/lng" must compute a bbox from the coordinates + desired radius before calling `water_find_sites`.
- **Stat service data gap** — the stat endpoint (`/nwis/stat`) only returns data for sites with long enough records. New gages and sparse-measurement wells return no percentile data. `water_get_conditions` degrades gracefully.
- **Groundwater wells with no IV sensor** — many GW wells only have periodic field measurements (not continuous real-time). These have no IV data and `water_get_readings` returns an empty result. The gwlevels service that handled field measurements is decommissioned; OGC `field-measurements` collection exists but returned 0 results in probing. Field-measurement GW data is currently inaccessible via public API.
- **Provisional data** — real-time IV values carry `P` (Provisional) qualifier. Provisional data may be revised. The server surfaces qualifiers; callers should not treat provisional values as finalized.
- **RDB parsing** — NWIS site and stat endpoints return tab-delimited RDB format, not JSON. The service layer parses this format; responses with unusual whitespace or extra comment lines must be handled robustly.
- **Rate limits** — USGS does not publish hard rate limits but requests a descriptive User-Agent and discourages aggressive polling. The service should set a meaningful User-Agent and back off on 429 responses.

---

## API Reference

### NWIS URL patterns

```
IV (instantaneous):   GET https://waterservices.usgs.gov/nwis/iv/?format=json&sites={siteIds}&parameterCd={codes}&period=PT{n}H
DV (daily):           GET https://waterservices.usgs.gov/nwis/dv/?format=json&sites={siteIds}&parameterCd={codes}&startDT={YYYY-MM-DD}&endDT={YYYY-MM-DD}[&statCd={code}]
Site search:          GET https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox={w,s,e,n}&siteType={ST|GW|LK|...}&hasDataTypeCd={iv|dv}&parameterCd={code}&siteOutput=basic
Statistics:           GET https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites={siteId}&parameterCd={code}&statReportType=daily&statType=all
```

### WaterML-JSON response shape (IV/DV)

```jsonc
{
  "value": {
    "timeSeries": [{
      "name": "USGS:01646500:00010:00003",         // agency:site:parameter:statistic
      "sourceInfo": {
        "siteName": "POTOMAC RIVER ...",
        "siteCode": [{ "value": "01646500", "agencyCode": "USGS" }],
        "geoLocation": { "geogLocation": { "latitude": 38.95, "longitude": -77.13 } }
      },
      "variable": {
        "variableCode": [{ "value": "00010" }],
        "variableName": "Temperature, water, &#176;C",
        "unit": { "unitCode": "deg C" },
        "options": { "option": [{ "name": "Statistic", "optionCode": "00003", "value": "Mean" }] }
      },
      "values": [                                   // one block per method (sensor)
        {
          "method": [{ "methodID": 68481, "methodDescription": "4.1 ft from riverbed (middle), [Discontinued]" }],
          "value": [{ "value": "26.7", "qualifiers": ["A"], "dateTime": "2019-09-01T00:00:00.000" }]
        },
        {
          "method": [{ "methodID": 300173, "methodDescription": "From multiparameter sonde" }],
          "value": [{ "value": "26.6", "qualifiers": ["A"], "dateTime": "2019-09-01T00:00:00.000" }]
        }
      ]
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

### Stat RDB columns (percentile table)

`ts_id` (the daily-mean series the row set belongs to), `loc_web_ds` (its location description), `month_nu`, `day_nu`, `begin_yr`, `end_yr`, `count_nu`, `p05_va`, `p10_va`, `p20_va`, `p25_va`, `p50_va` (median), `p75_va`, `p80_va`, `p90_va`, `p95_va`, `max_va`, `min_va`, `mean_va`

### Percentile classification table

Each class ships with the `percentileLabel` below alongside it. `record-high` and `record-low` name percentile-of-record extremes, not verified all-time records — the stat row carries the true observed extremes separately in `max_va`/`min_va`. Since the raw `percentileClass` value is what reaches `structuredContent`, and schema description text is invisible wherever that value is read, the label has to be its own runtime field.

| Condition (`percentileClass` value) | Percentile range | `percentileLabel` |
|:-------------------------------------|:----------------|:------------------|
| `record-high` | ≥ p95 | ≥ 95th percentile (percentile-of-record extreme, not a verified all-time record) |
| `above-normal` | p75 – p95 | 75th–95th percentile |
| `normal` | p25 – p75 | 25th–75th percentile |
| `below-normal` | p10 – p25 | 10th–25th percentile |
| `low` | p05 – p10 | 5th–10th percentile |
| `record-low` | < p05 | < 5th percentile (percentile-of-record extreme, not a verified all-time record) |
| `unknown` | non-numeric reading | insufficient percentile data |
| `unknown` | reading NWIS reported as no data (`-999999`) | no value to rank — NWIS reported no data for this reading (qualifiers: P, Ssn) |

When an outer threshold is blank, the class is decided by the published ones and the label names what is missing:

| Blank | Value | `percentileClass` | `percentileLabel` |
|:------|:------|:------------------|:------------------|
| p95 | ≥ p75 | `above-normal` | ≥ 75th percentile; 95th not published |
| p10 | < p25 (≥ p05 when published) | `below-normal` | < 25th percentile; 10th not published |
| p05 | < p10 | `low` | < 10th percentile; 5th not published |
| p25 or p75 | not placed by any published threshold | `unknown` | the nearest published thresholds and the blank ones between, e.g. 25th–95th percentile; 75th not published |
| all five | any | `unknown` | no percentile thresholds published |

The calendar row is matched on the observation timestamp's own `YYYY-MM-DD` prefix. NWIS IV timestamps carry an explicit UTC offset and the stat table's `month_nu`/`day_nu` are plain calendar integers, so parsing through `Date` would re-project the instant into the runtime's timezone and select a neighboring row for readings near midnight.

# USGS Water Data MCP Server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `water_find_sites` | Find USGS monitoring sites by bounding box, state, county, or HUC. Filter by site type and parameter availability. Returns site number, name, type, coordinates, and drainage area (expanded mode only) — altitude is included in both modes when recorded. Required discovery step — downstream tools key on site numbers, and parameter availability varies. Note: NWIS has no limit param; scope results geographically (bbox) or by state/county/HUC. | `bbox`, `stateCd`, `countyCd`, `huc`, `siteType`, `parameterCd`, `hasDataTypeCd`, `siteOutput` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_readings` | Get the latest instantaneous values (real-time, ~15 min) for one or more sites. Returns per-site results each including the siteNumber, parameter code, timestamp, value, unit, and provisional/approved qualifier. Accepts up to 100 site numbers in one call. Each series is capped at its 10 most recent records with the true count in `totalValues` and `truncated` flagging the cap — `water_get_series` is the tool for a full series. Requested sites NWIS returns nothing for are named in `missingSites`, so a partial batch is visible rather than inferred. | `sites` (array), `parameterCd` (array), `period` (ISO 8601 duration, e.g. `PT2H`, `P7D`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_series` | Get a time series of daily or instantaneous values for a site and parameter over a date range. Returns `siteNumber`, `parameterCd`, and value records (date/time, value, qualifiers). Large result sets (>500 rows) spill to DataCanvas — response includes `canvas_id` and `truncated` flag when canvas is available. | `site`, `parameterCd`, `startDate` (YYYY-MM-DD), `endDate` (YYYY-MM-DD), `seriesType` (`daily` \| `instantaneous`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_get_conditions` | Get current conditions at a site placed in historical context: today's value ranked against the site's daily percentile record for the same calendar day. Returns the current reading alongside the percentile class (`record-high` / `above-normal` / `normal` / `below-normal` / `low` / `record-low`), a `percentileLabel` stating that class's threshold in plain language, and a `comparisonBasis` disclosing that an instantaneous reading is ranked against approved daily-mean percentiles. A "how unusual is this reading" ranking — not a flood-stage or drought determination, which need authoritative thresholds this tool does not fetch. | `site`, `parameterCd` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `water_list_parameters` | Static lookup of well-known USGS parameter codes with human-readable names, units, and domain. No network call. Solves the opaque-5-digit-code problem: an agent can call this first to discover that `00060` = "Discharge" (cfs), `00065` = "Gage height" (ft), `00010` = "Temperature" (°C), `72019` = "Depth to water, below land surface" (ft). | `group` (filter by domain: `streamflow` \| `groundwater` \| `temperature` \| `all`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude. Stable URI for a known site number. | No |
| `usgs-water://parameters` | Full parameter code catalog (the same data as `water_list_parameters`). Injectable context for clients that support resources. | No |

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
- Parameter code discovery via a built-in static lookup (no network call)
- Multi-site batching: IV/DV accept comma-separated site lists (up to 100) in one call
- Error handling: NWIS returns HTML 400 pages for bad inputs, not JSON — must detect and parse HTML errors
- Provisional vs. approved data qualifiers surfaced to callers (not hidden)
- Large date-range series (>500 records) spill to DataCanvas for agent SQL analysis (requires `CANVAS_PROVIDER_TYPE=duckdb`)

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `nwis-service` | USGS NWIS Water Services (`waterservices.usgs.gov`) — IV, DV, site, stat endpoints | All tools |

No OGC API service at launch. The OGC API (`api.waterdata.usgs.gov/ogcapi/v0`) is the USGS long-term replacement for NWIS, but its geosearch (monitoring-locations bbox) is currently unreliable (returns 0 results in probing), and its IV/DV equivalents (`latest-continuous`, `daily`) require different site ID format (`USGS-01646500` vs `01646500`). NWIS iv/dv/site/stat remain stable, JSON-capable, and well-documented. OGC API adoption is noted as a future path once its search is reliable.

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No | Set to `duckdb` to enable DataCanvas spillover for large series. Optional — without it, `water_get_series` returns a truncated preview. |
| `USGS_USER_AGENT` | No | Custom User-Agent string for USGS requests. USGS requests a descriptive User-Agent per their terms; defaults to `usgs-water-mcp-server/0.1.11 (contact: https://github.com/cyanheads/usgs-water-mcp-server)`. |
| `MCP_TRANSPORT_TYPE` | No | `stdio` (default) or `http`. Framework-managed. |
| `PORT` | No | HTTP port when transport is `http`. Default `3000`. Framework-managed. |

---

## Implementation Order

1. **Config and service setup** — `src/config/server-config.ts` (USGS user-agent, request timeout), `src/services/nwis/nwis-service.ts` (fetch wrapper, HTML-error detection, retry config, RDB parser for site/stat responses)
2. **Parameter lookup tool** — `water_list_parameters`: pure static handler, no network, validates the parameter-code Zod schema used by other tools
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
| Instantaneous values | `/nwis/iv` | JSON (WaterML-JSON) | `format=json`, multi-site via `sites=a,b,c`, `period=PTnH` or `startDT/endDT`. An unknown site in a multi-site request is dropped from the response without comment — the request/response diff is the only signal |
| Daily values | `/nwis/dv` | JSON (WaterML-JSON) | `format=json`, same site/param/date params as IV |
| Statistics (percentiles) | `/nwis/stat` | RDB | `format=rdb`, `statReportType=daily`, `statType=all`, returns p05–p95 per calendar day |
| Parameter codes | (static table) | — | Baked into `water_list_parameters`; OGC `/parameter-codes` also available but latency not worth it for a bounded lookup |

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

---

## Workflow Analysis

### `water_get_conditions` (2 parallel upstream calls)

| # | Call | Purpose |
|:--|:-----|:--------|
| 1a | `GET /nwis/iv?format=json&sites={siteId}&parameterCd={code}&period=PT2H` | Current value with qualifier |
| 1b | `GET /nwis/stat?format=rdb&sites={siteId}&parameterCd={code}&statReportType=daily&statType=all` | Full daily percentile table |
| 2 | Compute: look up the observation's own month+day in the stat table, find the bounding percentiles | Classify into `record-high`/`above-normal`/`normal`/`below-normal`/`low`/`record-low` |

Calls 1a and 1b run in `Promise.all`. The stat percentiles are computed from **approved daily-mean** values, while call 1a returns an **instantaneous** reading — NWIS publishes no instantaneous percentile product — so `percentileClass` is a cross-granularity approximation ("how unusual is today's reading for this calendar day"), not a flood-stage or drought determination. `historicalContext.comparisonBasis` states this at runtime.

The stat call is captured, not awaited-to-throw, so an operational stat failure stays distinct from a genuinely empty table. `historicalContextStatus` reports which case occurred: `available` (percentiles present), `no_matching_day` (rows exist but none for the observation's calendar day), `no_record` (empty table — new site or record too short), or `unavailable` (the stat call failed — transient, retryable, and never attributed to the site's history). Every case still returns the current reading — partial success, not a throw. Only an IV-side 5xx/timeout throws `upstream_error`.

---

## Error Contracts

Typed failure contracts for the four network-calling tools and the `usgs-water://site/{siteId}` resource. `water_list_parameters` is static — no contract needed.

**Classification is code-based, not message-based.** `nwis-service` already types every failure it raises — an HTML 400 becomes a `validationError`, a 5xx becomes a `serviceUnavailable` — and `classifyNwisFailure()` maps that code onto the reason vocabulary below. Tools never re-match the error prose to guess a field.

**`invalid_request` names no field on purpose.** NWIS wraps every rejection in identical text (`NWIS rejected the request: …`) and reports the offending field only inside its own message — and not always the field the caller passed (`period=P99999D` comes back as a complaint about `StartDT`). Selecting a reason by pattern-matching that prose is what made a bad `period` surface as a bad site number. The reason states what the server knows — NWIS refused the request — and the message carries NWIS's verbatim text for the caller to act on.

### `water_find_sites`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_sites_found` | `NotFound` | No sites match the given filters | No — broaden bbox/state/HUC or remove parameterCd/siteType filter |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400. Filter formats are pattern-validated before the call, so this is a well-formed value NWIS still refused (unknown code, unsupported combination) | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx or network timeout | Yes — retry after backoff |

### `water_get_readings`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_parameter` | `NotFound` | No time series returned, or every series came back empty. NWIS gives the same response for an unknown site and a valid site with no data for the parameter/period, so the two are indistinguishable here | No — check the site and its parameters via `water_find_sites` |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the input patterns | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx or network timeout | Yes — retry after backoff |

A batch where *some* sites return data is a success, not an error: the returned series are in `readings` and the rest are named in `missingSites`.

### `water_get_series`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_range` | `NotFound` | Site/parameter combination has no data in the requested date range (also covers an unknown site — NWIS returns the same empty response) | No — narrow the date range or check parameter availability |
| `invalid_date_range` | `ValidationError` | This tool's own date validation: `endDate` before `startDate`, or a date that matches `YYYY-MM-DD` but is not a real calendar date. Never reaches NWIS | No — correct the date range |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the input patterns | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS returns 5xx or network timeout | Yes — retry after backoff |

### `water_get_conditions`

| reason | code | when | retryable |
|:-------|:-----|:-----|:----------|
| `no_data_for_parameter` | `NotFound` | No IV series returned, or the series carries no current reading. Covers an unknown site and a valid site without the parameter alike | No — check parameter availability via `water_find_sites` |
| `invalid_request` | `ValidationError` | NWIS returned HTML 400 for a value that passed the input patterns | No — read the NWIS message in the error; it names the field |
| `upstream_error` | `ServiceUnavailable` | NWIS IV or stat endpoint returns 5xx or network timeout | Yes — retry after backoff |

Note: absence of stat data is **not** an error — `water_get_conditions` returns the current reading with `historicalContext: null` and a note. `historicalContextStatus` discriminates *why* it is absent: `no_record` (empty table — new site or record too short), `no_matching_day` (rows exist but none for the observation's calendar day), or `unavailable` (the stat call failed — transient and retryable, kept distinct from a sparse site). A stat-side failure is caught inline, so it never turns an IV success into a throw; only an IV-side 5xx/timeout surfaces as `upstream_error`. This is partial-success, not a throw.

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

### DataCanvas: opt-in for series analysis

**Decision:** `water_get_series` spills large result sets (>500 rows) to DataCanvas when `CANVAS_PROVIDER_TYPE=duckdb` is set. Without DuckDB, it returns a preview of the most recent 500 rows with a `truncated` flag and `totalRecords` count. This avoids making DuckDB a hard dependency while still enabling SQL-based analysis for agents that want it.

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
DV (daily):           GET https://waterservices.usgs.gov/nwis/dv/?format=json&sites={siteIds}&parameterCd={codes}&startDT={YYYY-MM-DD}&endDT={YYYY-MM-DD}
Site search:          GET https://waterservices.usgs.gov/nwis/site/?format=rdb&bBox={w,s,e,n}&siteType={ST|GW|LK|...}&hasDataTypeCd={iv|dv}&parameterCd={code}&siteOutput=basic
Statistics:           GET https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites={siteId}&parameterCd={code}&statReportType=daily&statType=all
```

### WaterML-JSON response shape (IV/DV)

```jsonc
{
  "value": {
    "timeSeries": [{
      "sourceInfo": {
        "siteName": "POTOMAC RIVER ...",
        "siteCode": [{ "value": "01646500", "agencyCode": "USGS" }],
        "geoLocation": { "geogLocation": { "latitude": 38.95, "longitude": -77.13 } }
      },
      "variable": {
        "variableCode": [{ "value": "00060" }],
        "variableName": "Streamflow, ft³/s",
        "unit": { "unitCode": "ft3/s" }
      },
      "values": [{
        "value": [{ "value": "7660", "qualifiers": ["P"], "dateTime": "2026-06-04T19:45:00-04:00" }]
      }]
    }]
  }
}
```

### Key parameter codes (built into `water_list_parameters`)

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
| `72150` | Depth to water level below measuring point | ft | groundwater |
| `62610` | Groundwater level above NAVD 88 | ft | groundwater |

### Stat RDB columns (percentile table)

`month_nu`, `day_nu`, `begin_yr`, `end_yr`, `count_nu`, `p05_va`, `p10_va`, `p20_va`, `p25_va`, `p50_va` (median), `p75_va`, `p80_va`, `p90_va`, `p95_va`, `max_va`, `min_va`, `mean_va`

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
| `unknown` | thresholds unavailable | insufficient percentile data |

The calendar row is matched on the observation timestamp's own `YYYY-MM-DD` prefix. NWIS IV timestamps carry an explicit UTC offset and the stat table's `month_nu`/`day_nu` are plain calendar integers, so parsing through `Date` would re-project the instant into the runtime's timezone and select a neighboring row for readings near midnight.

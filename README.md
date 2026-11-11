<div align="center">
  <h1>@cyanheads/usgs-water-mcp-server</h1>
  <p><b>Query real-time and historical water data from ~8,000 USGS stream gages and groundwater wells via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usgs-water-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usgs-water-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usgs-water-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usgs-water-mcp-server/releases/latest/download/usgs-water-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usgs-water-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNncy13YXRlci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usgs-water-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusgs-water-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://usgs-water.caseyjhand.com/mcp](https://usgs-water.caseyjhand.com/mcp)

</div>

---

## Overview

Real-time and historical water data from ~8,000 active USGS stream gages and groundwater wells across the US and territories. Find monitoring sites, pull the latest readings or a historical series, and see how today's flow compares with decades of records.

### Tools

| Tool | Description |
|:-----|:------------|
| `water_list_parameters` | List well-known USGS parameter codes with names, units, and domain (no network call), or search the full ~19,600-code USGS catalog by name or description. |
| `water_find_sites` | Find USGS monitoring sites by bounding box, state, county, or HUC watershed. Filter by site type, parameter availability, and recency; each row reports when the site last reported. Large match sets spill to DataCanvas. |
| `water_get_readings` | Get the latest instantaneous values (~15 min real-time) for up to 100 USGS sites. |
| `water_get_series` | Get a time series of daily or instantaneous values for a site over a date range. Large ranges spill to DataCanvas. |
| `water_get_site_data_catalog` | Discover a site's parameters, sensors, statistics, and full UTC record bounds, with cursor pagination. |
| `water_get_conditions` | Get current hydrologic conditions ranked against the full period-of-record percentile statistics. |
| `water_dataframe_describe` | List tables and columns staged on a DataCanvas by `water_get_series` or `water_find_sites`. |
| `water_dataframe_query` | Run a read-only SQL SELECT against the time-series and site tables staged by `water_get_series` and `water_find_sites`. |
| `water_dataframe_drop` | Drop one staged table from a DataCanvas, leaving the canvas and its other tables in place. Opt-in via `WATER_DATAFRAME_DROP_ENABLED`. |

### Resources

| Resource | Description |
|:---|:---|
| `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude |
| `usgs-water://parameters` | Curated well-known parameter codes (the list `water_list_parameters` returns without a query) |

All resource data is also reachable via tools. Use `water_find_sites` for geographic site discovery.

### Skill

| Skill | Description |
|:---|:---|
| `usgs-water-guide` | Gates and workflows for agents calling the tools: telling live gages from discontinued ones, reading depth-to-water rankings (a shallower depth ranks higher), finding the parameter code a site reports, time zones and data lag, and SQL over staged series |

Ships in `skills/` for plugin installs, the npm package, the Docker image, and the `.mcpb` bundle, and is served over MCP as `skill://usgs-water-guide/SKILL.md`.

## Capability reference

### `water_list_parameters` <sub>tool</sub>

- Without `query`: the curated, built-in list — no network call — of codes like `00060` (Discharge, ft³/s), `00065` (Gage height, ft), and `72019` (Depth to water level, ft), filtered by `group` (`streamflow`, `groundwater`, `temperature`, `meteorological`, `water-quality`, or `all`, the default)
- With `query`: searches the full ~19,600-code USGS catalog by name or description (a bare 5-digit code returns that code) and returns at most 25 entries, each naming its `source` (`curated` or `usgs-catalog`), with `total` and `truncated` covering the full match set. `query` can't be combined with a `group` other than `all`
- The catalog is fetched on the first query and cached for 24 hours; a failed fetch fails as a retryable `upstream_error`

---

### `water_find_sites` <sub>tool</sub>

- Exactly one geographic scope per call — `bbox` (`"west,south,east,north"`), 2-letter `stateCd`, up to 20 comma-separated 5-digit FIPS `countyCd` codes, or a 2- or 8-digit `huc` — narrowed by `siteType` (`ST`, `GW`, `LK`, `SP`, …), `parameterCd`, `hasDataTypeCd` (`iv` with aliases `uv` and `rt`, `dv`, `gw`, `pk`; no other code has a source), and `observedWithin` (an ISO 8601 duration). A `bbox` has no area cap. A missing or doubled scope fails as `missing_major_filter` / `conflicting_major_filters` before any request
- Every row carries `lastObservedAt`, the UTC time of the site's newest observation among the series the filters select (null when it has none, or none with a recorded time), read from the latest-value collections without a request per site. `parameterCd` and `hasDataTypeCd` match sites that have ever reported, discontinued ones included, and never discrete water-quality samples; `observedWithin` keeps only sites whose `lastObservedAt` falls inside the window
- `limit` (1–500, default 500) and `offset` page through the match set, with `truncated` and `upstreamTotal` describing what lies outside the window; `siteOutput: expanded` adds state and county FIPS codes, drainage area, and contributing area
- With `CANVAS_PROVIDER_TYPE=duckdb`, a match set over 500 sites also stages in full to a canvas (`canvas_id` / `table_name`) for `water_dataframe_query`

---

### `water_get_readings` <sub>tool</sub>

- Up to 100 `sites` per call, an optional `parameterCd` filter, and a `period` lookback (ISO 8601, default `PT2H`, at most 1,100 days); returns one series per site, parameter, and sensor (`methodId` is the series' time-series ID, the `timeSeriesId` the site data catalog lists; `methodDescription` names the sensor), capped at 100 series per call (kept round-robin across sites) and the 10 most recent records per series, with `totalSeries`, `totalValues`, and `truncated` reporting what the caps held back
- A sensor that reported nothing in the period still returns, with `totalValues: 0`, an all-dormant batch included; sites with no series at all are named in `missingSites`, and `no_data_for_parameter` fires only when no requested site returns a series
- Every value carries its qualifier codes (`P` provisional, `A` approved, plus codes such as `e`, `Ssn`, `Dis`; a qualifier with no code passes through as the upstream word, e.g. `OTHERAGENCY`). Timestamps are site-local with the UTC offset, or UTC (`+00:00`) for a site with no known time zone

---

### `water_get_series` <sub>tool</sub>

- One `site` and `parameterCd` per call over a `startDate`–`endDate` range; `seriesType` is `daily` (one value per day, the default) or `instantaneous` (~15 min). The most recent 500 records return inline, with `totalRecords` and `truncated` reporting the rest
- Returns one named series — by default the daily mean and the sensor series with the most records, a tie going to the site's default sensor over a labeled one and then to the series that began first; `statCd` (`00003` mean, `00001` maximum, `00002` minimum; daily only) and `methodId` (a series' time-series ID, 32 hexadecimal characters) select another, and `otherSeries` lists every alternative, empty ones included, with its record count. An instantaneous range of any length is read in full up to today on the site's clock, in 366-day chunks; for a parameter the site lists no series of, only the last 366 days are read, in one request
- With `CANVAS_PROVIDER_TYPE=duckdb`, a range over 500 records spills the complete series to a canvas (`canvas_id` / `table_name`); pass a prior `canvas_id` to add the table to an existing canvas

---

### `water_get_site_data_catalog` <sub>tool</sub>

- One `site`, optional `parameterCd` and `seriesType`, and `limit` (1–1000; default 100). Reuse the same filters and limit with `nextCursor` until it is null. An unknown site fails as `not_found`; a known site with no matching metadata returns `series: []`
- Each row preserves its OGC `timeSeriesId`, parameter name/unit, nullable statistic, sensor description, raw computation fields, and full UTC `beginDate`/`endDate`. `Daily` maps to `daily`; `Points` with `Instantaneous` maps to `instantaneous`; other computations have null `seriesType`
- For `water_get_series`, take YYYY-MM-DD from the bounds, pass `statCd` only for daily rows, and pass a row's `timeSeriesId` as `methodId` to request that exact series. Bounds may contain gaps and lag observations; null bounds remain unknown
- Site identity and metadata share a 45-second deadline including retries. Malformed or rejected continuation cursors fail as `invalid_cursor`; restart without cursor

---

### `water_get_conditions` <sub>tool</sub>

- One `site` and `parameterCd`; ranks the current instantaneous reading against the period-of-record daily-mean percentiles for its calendar day as a `percentileClass` — `record-high` (≥p95), `above-normal`, `normal`, `below-normal`, `low`, `record-low` (<p05), or `unknown` for a no-data reading — with `percentileLabel` stating the threshold in plain language and `comparisonBasis` noting that the ranking is approximate, not a flood-stage or drought determination
- Depth-below-surface codes (`72019`, `30210`, `99019`, `72276`) rank as water levels: a shallower depth ranks higher, `p95` is the day's shallowest depth and `p05` the deepest, `currentValue` stays the depth as measured, and `percentileLabel` and `comparisonBasis` say so
- The calendar day is the reading's own site-local date. When percentiles can't be applied, the reading still returns with `historicalContext: null` and a `historicalContextStatus` of `no_record` (no daily-mean percentiles for the day), `no_matching_day` (the reported sensor's series has an approved record but none for that day), `no_matching_method`, or `unavailable` (a Statistics API request failed); on a multi-sensor site, `methodId` and `methodMatched` name the sensor read and whether the percentiles came from its own daily-mean series, paired by time-series ID, an exact time tie between sensors going to the site's default sensor

---

### `water_dataframe_describe` <sub>tool</sub>

- Lists the tables staged on a canvas by `water_get_series` or `water_find_sites`, with each column's name, DuckDB type, and nullability — call it before `water_dataframe_query` or `water_dataframe_drop` to confirm the exact names
- `row_count` is a DuckDB estimate and may differ from the exact count

---

### `water_dataframe_query` <sub>tool</sub>

- A single read-only `SELECT` against the staged tables; other statements, system-catalog access (`information_schema`, `pg_catalog`, `duckdb_*`), engine-setting functions, dynamic SQL, and file references are rejected. `query()` accepts a single SQL string literal, checked under the same restrictions
- Capped at 10,000 rows per query; `truncated: true` signals more matched — narrow with `WHERE`/`LIMIT`, or run `SELECT COUNT(*)` for the true total

---

### `water_dataframe_drop` <sub>tool</sub>

- Removes one staged table by `table_name` (matched case-insensitively) from the canvas named by `canvas_id`; the canvas and its other tables stay, and the response reports the dropped table's `row_count` and the `remaining_tables`
- A name not staged on the canvas fails as `table_not_found` and changes nothing, so a repeated drop is safe
- Opt-in: callable only with `WATER_DATAFRAME_DROP_ENABLED=true`; otherwise it appears on the landing page as a disabled tool and is absent from `tools/list`. Like the other dataframe tools, it needs `CANVAS_PROVIDER_TYPE=duckdb`

---

### `usgs-water://site/{siteId}` <sub>resource</sub>

- Returns `application/json` site metadata: name, coordinates, type, HUC watershed code, state, county, drainage area, and altitude
- `siteId` is an 8–15 digit site number, whichever agency holds it — discover one via `water_find_sites`

---

### `usgs-water://parameters` <sub>resource</sub>

- The curated table of well-known parameter codes as `application/json` — the list `water_list_parameters` returns without a query
- Takes no parameters; a curated subset of the USGS catalog — search the rest with `water_list_parameters` `query`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USGS Water-specific:

- Reads the USGS Water Data APIs: the OGC collections at `api.waterdata.usgs.gov/ogcapi/v1` (monitoring locations, latest-value and peak collections, continuous and daily observations, time-series metadata, and the parameter-code and statistic-code tables) and the Statistics API at `/statistics/v0` for percentiles. No API key is required; an optional `USGS_API_KEY` raises the rate limit
- Input formats are checked at the edge against what the APIs accept — site numbers, parameter codes, ISO 8601 periods, HUC, FIPS county, state, and bbox each carry a validated pattern advertised in the tool's JSON Schema
- Upstream failures are read from the API's own JSON error body and mapped to a typed failure; a 429 returns as `rate_limited` carrying `retryAfter`, and a rejected key names `USGS_API_KEY`. Every tool call shares one 45-second deadline across its requests and retries
- DataCanvas spillover: `water_get_series` (long date ranges) and `water_find_sites` (match sets past the 500-site cap) stage the full result as a DuckDB-backed table, queryable via `water_dataframe_query`; the spillover and the dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb`, and `water_dataframe_drop` also needs `WATER_DATAFRAME_DROP_ENABLED=true`
- No-data readings stay no-data: a reading USGS reports without a value (a seasonal, discontinued, dry, or malfunctioning gage) returns as an empty `value` with qualifiers naming why (`Ssn`, `Dis`, `Dry`, `Eqp`) — never as a magnitude — and stages as `NULL` on a canvas
- Groundwater depth reads like any other parameter, through `72019`: only wells with a continuous sensor return values

Agent-friendly output:

- Percentile classification: `water_get_conditions` returns a `percentileClass` that describes the water level (a shallower depth ranks higher for depth-to-water codes), paired with a `percentileLabel` that states the threshold in plain language
- Partial success over hard failure: `water_get_readings` returns the series it got and names the rest in `missingSites`; `water_get_conditions` separates an empty stat table (`no_record` / `no_matching_day`) from a failed stat call (`unavailable`, transient) instead of collapsing both into one error
- Truncation signals: every capped response (`water_get_series`, `water_find_sites`, `water_get_readings`) reports its own count and a `truncated` flag, plus `canvas_id` / `table_name` when the rest is retrievable via SQL
- Structured content and rendered text agree — every cap and count a tool applies appears identically in `structuredContent` and in the markdown

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http usgs-water-mcp-server https://usgs-water.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add usgs-water-mcp-server -- npx -y @cyanheads/usgs-water-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "usgs-water-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/usgs-water-mcp-server"]
    }
  }
}
```

DataCanvas is enabled by default for SQL analytics over large result sets; set `CANVAS_PROVIDER_TYPE=none` to return inline previews only. No API key is required; an optional `USGS_API_KEY` raises the rate limit. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CANVAS_PROVIDER_TYPE` | DataCanvas spillover for large results from `water_get_series` and `water_find_sites`; set to `none` to disable. The portable desktop bundle sets `none`. | `duckdb` |
| `USGS_USER_AGENT` | Custom User-Agent string sent to the USGS Water Data APIs. USGS requests a descriptive User-Agent per their terms. | `usgs-water-mcp-server/0.5.0 (contact: https://github.com/cyanheads/usgs-water-mcp-server)` |
| `USGS_REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds for each USGS Water Data API request. Every tool call also has a shared 45-second deadline across its requests and retries. | `30000` |
| `USGS_API_KEY` | Optional api.data.gov key, sent as the `X-Api-Key` header. Without one, requests share the anonymous per-IP hourly limit (1,000 on the OGC collections); a shared or hosted deployment should set one. | unset |
| `WATER_DATAFRAME_DROP_ENABLED` | Set to `true` to make `water_dataframe_drop` callable. Off, the tool is listed as disabled. Needs `CANVAS_PROVIDER_TYPE=duckdb` to have anything to drop. | `false` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode. The server declares `stateless` in code, matching `.env.example` and the Docker runtime; setting this overrides that, and `auto` resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `LOG_TOOL_FAILURE_PAYLOADS` | Log each failed tool call's arguments and result, redacted by key name and capped at `LOG_TOOL_FAILURE_PAYLOAD_MAX_BYTES` (default `16384`). A secret inside a free-form value is not redacted. | `false` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

Requires [Bun v1.4.4](https://bun.sh/) or higher (or Node.js v24+).

- **Clone and install:**

  ```sh
  git clone https://github.com/cyanheads/usgs-water-mcp-server.git
  cd usgs-water-mcp-server && bun install
  cp .env.example .env   # optional overrides
  ```

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/usgs-water-mcp-server:latest
```

The image defaults to HTTP transport, stateless session mode, and logs to `/var/log/usgs-water-mcp-server`. To run it over stdio from an MCP client, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/usgs-water-mcp-server:latest"]`. To build locally, `docker build -t usgs-water-mcp-server .`; OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/waterdata` | USGS Water Data client (OGC collections and Statistics API, one deadline per tool call), site discovery, observations, percentile statistics, site-series metadata, parameter-code catalog reader (24-hour cache), and curated parameter table. |
| `src/services/canvas` | DataCanvas accessor, caller-supplied `canvas_id` resolution, and deterministic table names for DuckDB-backed spillover. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

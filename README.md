<div align="center">
  <h1>@cyanheads/usgs-water-mcp-server</h1>
  <p><b>Query real-time and historical water data from ~8,000 USGS stream gages and groundwater wells via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usgs-water-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usgs-water-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usgs-water-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

USGS NWIS water data — ~8,000 active stream gages and groundwater wells across the US and territories. Find monitoring sites, pull the latest readings or a historical time series, and rank current conditions against decades of percentile records from any MCP client. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:-----|:------------|
| `water_list_parameters` | List well-known USGS parameter codes with names, units, and domain (no network call), or search the full ~19,600-code USGS catalog by name or description. |
| `water_find_sites` | Find USGS monitoring sites by bounding box, state, county, or HUC watershed. Filter by site type and parameter availability. Large match sets spill to DataCanvas. |
| `water_get_readings` | Get the latest instantaneous values (~15 min real-time) for up to 100 USGS sites. |
| `water_get_series` | Get a time series of daily or instantaneous values for a site over a date range. Large ranges spill to DataCanvas. |
| `water_get_conditions` | Get current hydrologic conditions ranked against the full period-of-record percentile statistics. |
| `water_dataframe_describe` | List tables and columns staged on a DataCanvas by `water_get_series` or `water_find_sites`. |
| `water_dataframe_query` | Run a read-only SQL SELECT against the time-series and site tables staged by `water_get_series` and `water_find_sites`. |

### Resources

| Resource | Description |
|:---|:---|
| `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude |
| `usgs-water://parameters` | Curated well-known parameter codes (the list `water_list_parameters` returns without a query) |

All resource data is also reachable via tools. Use `water_find_sites` for geographic site discovery.

## Capability reference

### `water_list_parameters` <sub>tool</sub>

- Without `query`: a curated, built-in list — no network call — covering codes like `00060` (Discharge, ft³/s), `00065` (Gage height, ft), `00010` (Temperature, water, °C), and `72019` (Depth to water level, ft). `group` filters it by thematic domain: `streamflow`, `groundwater`, `temperature`, `meteorological`, `water-quality`, or `all` (default)
- With `query`: searches the full USGS parameter-code catalog (~19,600 codes) — every word must start a word in the parameter name or description (`"turbidity"`, `"nitrate filtered"`), and a bare 5-digit code returns that code. Matching curated codes come first, then name matches, then description matches; at most 25 return, with `total` counting every match and `truncated` flagging the cap. Each entry names its `source` (`curated` or `usgs-catalog`), and catalog entries carry the USGS `description`
- The catalog is fetched once on the first query and cached for 24 hours; a failed fetch returns a retryable `upstream_error` rather than a curated-only answer. `query` and a `group` other than `all` can't be combined
- The place to resolve a code before any other tool — every `parameterCd` input takes one

---

### `water_find_sites` <sub>tool</sub>

- Geographic scoping: bounding box (`"west,south,east,north"`), 2-letter state code, comma-separated 5-digit FIPS county codes (up to 20), or a HUC watershed code — a 2-digit major HUC or an 8-digit minor HUC, the only two lengths NWIS accepts. Exactly one of the four per call: NWIS rejects a request carrying none or more than one, so the tool refuses it first with a reason naming which rule broke
- Optional filters: `siteType` (`ST` stream, `GW` groundwater well, `LK` lake/reservoir, `SP` spring, and more — comma-separable), `parameterCd` (require data availability), and `hasDataTypeCd` (`iv` / `dv` / `gw`) — these narrow within the geographic scope and cannot stand alone
- `siteOutput`: `basic` (default) or `expanded` (adds drainage area and contributing area); altitude appears in both modes when USGS records it
- `limit` (1–500, default 500) and `offset` page through the match set; `truncated` means matches remain after the returned window and `upstreamTotal` holds the full count. An `offset` at or past the end returns an empty page naming the valid range rather than a not-found error
- With `CANVAS_PROVIDER_TYPE=duckdb` set, a match set over 500 sites also stages in full to a canvas (`canvas_id`/`table_name`) — inspect the columns with `water_dataframe_describe`, then retrieve every match with `water_dataframe_query`. The table name carries the query's scope, site type, and a digest of the full filter set, so re-running a query replaces only its own table

---

### `water_get_readings` <sub>tool</sub>

- Batch up to 100 site numbers per call; optional `parameterCd` filter; `period` is an ISO 8601 lookback duration, default `PT2H`
- A site measuring one parameter with several sensors (NWIS "methods") returns one series per method, each carrying `methodId` and `methodDescription`; a method block that came back empty is omitted when another method of the same parameter has values
- Omitting `parameterCd` returns every parameter each site publishes, so at most 100 series return per call — kept round-robin across sites, so every site that returned data keeps at least one, with `totalSeries` holding the count before the cap. Pass `parameterCd` or split the sites across calls to reach the rest
- Each series returns only its 10 most recent records — `totalValues` reports the true count; use `water_get_series` for full history. `truncated` flags either cap
- Every value carries qualifier codes (e.g. `P` provisional, `A` approved). A reading NWIS reports as no data — its `-999999` no-data value, from a seasonal, discontinued, dry, or malfunctioning gage — comes back as an empty `value` with its qualifiers naming why (`Ssn`, `Dis`, `Dry`, `Eqp`), never as a magnitude, and a series whose every record is no data ranks with the empty ones under the series cap
- Sites NWIS returns nothing for are named in `missingSites` rather than dropped silently
- Groundwater depth reads through this same IV service via parameter `72019` — the legacy `gwlevels` endpoint was decommissioned November 2025

---

### `water_get_series` <sub>tool</sub>

- One site and one parameter code per call; `seriesType` is `daily` (DV service, one value/day, default) or `instantaneous` (IV service, ~15 min), over a `startDate`–`endDate` range
- Returns one series and names it: NWIS can hold one daily series per statistic (`00003` mean, `00001` maximum, `00002` minimum) and one per sensor (method). The default is the daily mean when NWIS returns one with values, and the method with the most records; `statCd` and `methodId` pick another, and `otherSeries` lists every alternative with its record count. `statCd` applies to daily series only — instantaneous values carry just `00000`
- A record NWIS reports as no data (`-999999`) returns as an empty `value` with its qualifiers, and stages as `NULL` on a canvas
- Without DataCanvas, a result over 500 records returns the most recent 500 with `truncated: true` and `totalRecords` holding the full count
- With `CANVAS_PROVIDER_TYPE=duckdb` set, ranges over 500 records spill the complete series to a canvas (`canvas_id`/`table_name`) while the inline records stay the most recent — inspect the columns with `water_dataframe_describe`, then read the full series with `water_dataframe_query`. The table name carries the site, parameter code, series type, both date bounds, and — whenever a statistic or method was chosen among several — a digest of that choice, so re-running a query replaces only its own table; pass a prior `canvas_id` to add a table to an existing canvas

---

### `water_get_conditions` <sub>tool</sub>

- Ranks the current IV reading against the full period-of-record daily-mean percentiles for the observation's own calendar day: `record-high` (≥p95), `above-normal` (p75–95), `normal` (p25–75), `below-normal` (p10–25), `low` (p05–10), `record-low` (<p05)
- `percentileLabel` spells out each threshold in plain language — the `record-high`/`record-low` classes mark percentile-of-record extremes, not verified all-time records
- Short records often leave p05, p10, or p95 blank; the class is then decided by the thresholds that are published and the label names the missing one (e.g. `above-normal`, "≥ 75th percentile; 95th not published"). `normal` needs both p25 and p75
- `comparisonBasis` discloses the granularity mismatch: the reading is instantaneous while the percentiles are daily-mean, so the ranking is approximate, not a flood-stage or drought determination
- When the site reports the parameter from several sensors, one reading is used and named by `methodId`/`methodDescription`: from the sensor a statistics series is described as when one is, otherwise the most recent across them. Percentiles come from the statistics series whose description equals that method's (`methodMatched: true`). With no exact match, the series is still used — with `methodMatched: false` and a `note` saying why — when it is the only one whose description matches once the statistics service's bracketed label (`[BASE GAGE]`) is set aside, or the only statistics series at the site
- A current reading NWIS reports as no data (`-999999`, e.g. a seasonal gage) is not ranked: `currentValue` is empty, `percentileClass` is `unknown`, and the qualifiers (`Ssn`, `Dis`, `Eqp`, …) name the reason. Another sensor's measured reading is preferred when the site has one
- Degrades gracefully when history is thin: returns the reading with `historicalContext: null` and a `historicalContextStatus` of `no_record`, `no_matching_day`, `no_matching_method` (several statistics series, none identified as the reporting sensor's), or `unavailable` (a transient, retryable stat-service failure, not a statement about the site's record)

---

### `water_dataframe_describe` <sub>tool</sub>

- Lists the tables/views staged by `water_get_series` or `water_find_sites`, with per-column name, DuckDB type, and nullability
- `row_count` is a DuckDB estimate and may differ from the exact count
- Requires `CANVAS_PROVIDER_TYPE=duckdb` — call before `water_dataframe_query` to confirm the exact table and column names

---

### `water_dataframe_query` <sub>tool</sub>

- Read-only `SELECT` only, against tables staged by `water_get_series` or `water_find_sites`; non-SELECT statements, multiple statements, and system-catalog access (`information_schema`, `pg_catalog`, `duckdb_*`) are all rejected
- Capped at 10,000 rows per query; `truncated: true` signals more matched — narrow with `WHERE`/`LIMIT`, or run `SELECT COUNT(*)` for the true total
- Requires `CANVAS_PROVIDER_TYPE=duckdb`

---

### `usgs-water://site/{siteId}` <sub>resource</sub>

- Returns `application/json` site metadata: name, coordinates, type, HUC watershed code, state, county, drainage area, and altitude
- `siteId` is an 8–15 digit USGS site number — discover one via `water_find_sites`

---

### `usgs-water://parameters` <sub>resource</sub>

- The curated table of well-known parameter codes as `application/json` — the list `water_list_parameters` returns without a query
- Takes no parameters; a curated subset of the USGS catalog — search the rest with `water_list_parameters` `query`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

USGS Water-specific:

- Wraps NWIS IV (instantaneous), DV (daily), site, and stat endpoints plus the USGS Water Data parameter-code catalog — no API key required, fully public
- Input formats are checked at the edge against what NWIS actually accepts — site numbers, parameter codes, ISO 8601 periods, HUC, FIPS county, state, and bbox each carry a validated pattern advertised in the tool's JSON Schema
- HTML error detection: NWIS returns 400 with an HTML body for bad input, and the service layer extracts NWIS's own message and maps it to a typed failure
- DataCanvas spillover: `water_get_series` (long date ranges) and `water_find_sites` (match sets past the 500-site cap) stage the full result as a DuckDB-backed table, queryable via `water_dataframe_query`
- Groundwater depth reads through the standard IV service via parameter `72019` — the legacy `gwlevels` endpoint was decommissioned November 2025

Agent-friendly output:

- Percentile classification: `water_get_conditions` returns a `percentileClass` callers can act on directly, paired with a `percentileLabel` that states the threshold in plain language
- Partial success over hard failure: `water_get_readings` returns the series it got and names the rest in `missingSites`; `water_get_conditions` separates an empty stat table (`no_record` / `no_matching_day`) from a failed stat call (`unavailable`, transient) instead of collapsing both into one error
- Truncation signals: every capped response (`water_get_series`, `water_find_sites`, `water_get_readings`) reports its own count and a `truncated` flag, plus `canvas_id` / `table_name` when the rest is retrievable via SQL
- Structured content and rendered text agree — every cap and count a tool applies appears identically in `structuredContent` and in the markdown

## Getting started

### Public Hosted Instance

A public instance is available at `https://usgs-water.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "usgs-water-mcp-server": {
      "type": "streamable-http",
      "url": "https://usgs-water.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "usgs-water-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/usgs-water-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "usgs-water-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/usgs-water-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "usgs-water-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/usgs-water-mcp-server:latest"
      ]
    }
  }
}
```

To enable DataCanvas for SQL analytics over large result sets (time series and site match sets), add `CANVAS_PROVIDER_TYPE=duckdb` to the `env` block in any of the configs above.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — USGS NWIS is a free, public API.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/usgs-water-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd usgs-water-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# Edit .env to set any optional overrides
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spillover for large results from `water_get_series` and `water_find_sites`. | — |
| `USGS_USER_AGENT` | Custom User-Agent string sent to USGS — NWIS and the parameter-code catalog. USGS requests a descriptive User-Agent per their terms. | `usgs-water-mcp-server/0.2.6 (contact: https://github.com/cyanheads/usgs-water-mcp-server)` |
| `USGS_REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds for USGS calls — NWIS and the parameter-code catalog. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode. The server declares `stateless` in code, matching `.env.example` and the Docker runtime; setting this overrides that, and `auto` resolves to `stateful`. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry) (spans, metrics, completion logs). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

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
docker build -t usgs-water-mcp-server .
docker run --rm -p 3010:3010 usgs-water-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/usgs-water-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/nwis` | NWIS HTTP client — IV, DV, site, and stat endpoints with HTML error detection. |
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

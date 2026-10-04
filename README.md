<div align="center">
  <h1>@cyanheads/usgs-water-mcp-server</h1>
  <p><b>Query real-time and historical water data from ~8,000 USGS stream gages and groundwater wells via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usgs-water-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.2.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usgs-water-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usgs-water-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

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
| `water_dataframe_drop` | Drop one staged table from a DataCanvas, leaving the canvas and its other tables in place. Opt-in via `WATER_DATAFRAME_DROP_ENABLED`. |

### Resources

| Resource | Description |
|:---|:---|
| `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude |
| `usgs-water://parameters` | Curated well-known parameter codes (the list `water_list_parameters` returns without a query) |

All resource data is also reachable via tools. Use `water_find_sites` for geographic site discovery.

## Capability reference

### `water_list_parameters` <sub>tool</sub>

- Without `query`: the curated, built-in list — no network call — of codes like `00060` (Discharge, ft³/s), `00065` (Gage height, ft), and `72019` (Depth to water level, ft), filtered by `group` (`streamflow`, `groundwater`, `temperature`, `meteorological`, `water-quality`, or `all`, the default)
- With `query`: searches the full ~19,600-code USGS catalog by name or description (a bare 5-digit code returns that code) and returns at most 25 entries, each naming its `source` (`curated` or `usgs-catalog`), with `total` and `truncated` covering the full match set. `query` can't be combined with a `group` other than `all`
- The catalog is fetched on the first query and cached for 24 hours; a failed fetch fails as a retryable `upstream_error`

---

### `water_find_sites` <sub>tool</sub>

- Exactly one geographic scope per call — `bbox` (`"west,south,east,north"`), 2-letter `stateCd`, up to 20 comma-separated 5-digit FIPS `countyCd` codes, or a 2- or 8-digit `huc` — narrowed by `siteType` (`ST`, `GW`, `LK`, `SP`, …), `parameterCd`, and `hasDataTypeCd` (`iv` / `dv` / `gw`). A missing or doubled scope fails as `missing_major_filter` / `conflicting_major_filters` before any NWIS call
- `limit` (1–500, default 500) and `offset` page through the match set, with `truncated` and `upstreamTotal` describing what lies outside the window; `siteOutput: expanded` adds drainage and contributing area
- With `CANVAS_PROVIDER_TYPE=duckdb`, a match set over 500 sites also stages in full to a canvas (`canvas_id` / `table_name`) for `water_dataframe_query`

---

### `water_get_readings` <sub>tool</sub>

- Up to 100 `sites` per call, an optional `parameterCd` filter, and a `period` lookback (ISO 8601, default `PT2H`); returns one series per site, parameter, and sensor method (`methodId` / `methodDescription`), capped at 100 series per call (kept round-robin across sites) and the 10 most recent records per series, with `totalSeries`, `totalValues`, and `truncated` reporting what the caps held back
- Every value carries its qualifier codes (`P` provisional, `A` approved), and sites NWIS returned nothing for are named in `missingSites`

---

### `water_get_series` <sub>tool</sub>

- One `site` and `parameterCd` per call over a `startDate`–`endDate` range; `seriesType` is `daily` (one value per day, the default) or `instantaneous` (~15 min). The most recent 500 records return inline, with `totalRecords` and `truncated` reporting the rest
- Returns one named series — by default the daily mean and the sensor method with the most records; `statCd` (`00003` mean, `00001` maximum, `00002` minimum; daily only) and `methodId` select another, and `otherSeries` lists every alternative with its record count
- With `CANVAS_PROVIDER_TYPE=duckdb`, a range over 500 records spills the complete series to a canvas (`canvas_id` / `table_name`); pass a prior `canvas_id` to add the table to an existing canvas

---

### `water_get_conditions` <sub>tool</sub>

- One `site` and `parameterCd`; ranks the current instantaneous reading against the period-of-record daily-mean percentiles for its calendar day as a `percentileClass` — `record-high` (≥p95), `above-normal`, `normal`, `below-normal`, `low`, `record-low` (<p05), or `unknown` for a no-data reading — with `percentileLabel` stating the threshold in plain language and `comparisonBasis` noting that the ranking is approximate, not a flood-stage or drought determination
- When percentiles can't be applied, the reading still returns with `historicalContext: null` and a `historicalContextStatus` of `no_record`, `no_matching_day`, `no_matching_method`, or `unavailable` (a transient stat-service failure); on a multi-sensor site, `methodId` and `methodMatched` name the sensor read and whether the percentiles came from its own series

---

### `water_dataframe_describe` <sub>tool</sub>

- Lists the tables staged on a canvas by `water_get_series` or `water_find_sites`, with each column's name, DuckDB type, and nullability — call it before `water_dataframe_query` or `water_dataframe_drop` to confirm the exact names
- `row_count` is a DuckDB estimate and may differ from the exact count

---

### `water_dataframe_query` <sub>tool</sub>

- A single read-only `SELECT` against the staged tables; other statements and system-catalog access (`information_schema`, `pg_catalog`, `duckdb_*`) are rejected
- Capped at 10,000 rows per query; `truncated: true` signals more matched — narrow with `WHERE`/`LIMIT`, or run `SELECT COUNT(*)` for the true total

---

### `water_dataframe_drop` <sub>tool</sub>

- Removes one staged table by `table_name` (matched case-insensitively) from the canvas named by `canvas_id`; the canvas and its other tables stay, and the response reports the dropped table's `row_count` and the `remaining_tables`
- A name not staged on the canvas fails as `table_not_found` and changes nothing, so a repeated drop is safe
- Opt-in: callable only with `WATER_DATAFRAME_DROP_ENABLED=true`; otherwise it appears on the landing page as a disabled tool and is absent from `tools/list`. Like the other dataframe tools, it needs `CANVAS_PROVIDER_TYPE=duckdb`

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
- DataCanvas spillover: `water_get_series` (long date ranges) and `water_find_sites` (match sets past the 500-site cap) stage the full result as a DuckDB-backed table, queryable via `water_dataframe_query`; the spillover and the dataframe tools require `CANVAS_PROVIDER_TYPE=duckdb`, and `water_dataframe_drop` also needs `WATER_DATAFRAME_DROP_ENABLED=true`
- No-data readings stay no-data: a value NWIS reports as `-999999` (a seasonal, discontinued, dry, or malfunctioning gage) returns as an empty `value` with qualifiers naming why (`Ssn`, `Dis`, `Dry`, `Eqp`) — never as a magnitude — and stages as `NULL` on a canvas
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
| `USGS_USER_AGENT` | Custom User-Agent string sent to USGS — NWIS and the parameter-code catalog. USGS requests a descriptive User-Agent per their terms. | `usgs-water-mcp-server/0.3.0 (contact: https://github.com/cyanheads/usgs-water-mcp-server)` |
| `USGS_REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds for USGS calls — NWIS and the parameter-code catalog. | `30000` |
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
| `src/services/waterdata` | USGS Water Data parameter-code catalog reader (24-hour cache) and the curated parameter table. |
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

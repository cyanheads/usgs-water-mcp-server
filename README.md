<div align="center">
  <h1>@cyanheads/usgs-water-mcp-server</h1>
  <p><b>Query real-time and historical water data from ~8,000 USGS stream gages and groundwater wells via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 2 Resources</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.11-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/usgs-water-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/usgs-water-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/usgs-water-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/usgs-water-mcp-server/releases/latest/download/usgs-water-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=usgs-water-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvdXNncy13YXRlci1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22usgs-water-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fusgs-water-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://usgs-water.caseyjhand.com/mcp](https://usgs-water.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools for querying USGS water data, plus two for SQL analytics over the DuckDB-backed canvas dataframes that `water_get_series` materializes:

| Tool | Description |
|:-----|:------------|
| `water_list_parameters` | Static lookup of well-known USGS parameter codes with names, units, and domain. No network call. |
| `water_find_sites` | Find USGS monitoring sites by bounding box, state, county, or HUC watershed. Filter by site type and parameter availability. |
| `water_get_readings` | Get the latest instantaneous values (~15 min real-time) for up to 100 USGS sites. |
| `water_get_series` | Get a time series of daily or instantaneous values for a site over a date range. Large ranges spill to DataCanvas. |
| `water_get_conditions` | Get current hydrologic conditions ranked against the full period-of-record percentile statistics. |
| `water_dataframe_describe` | List tables and columns staged on a DataCanvas by `water_get_series`. |
| `water_dataframe_query` | Run a read-only SQL SELECT against time-series tables staged by `water_get_series`. |

### `water_list_parameters`

Static lookup of well-known USGS parameter codes — no network call, instant response.

- Discover that `00060` = Discharge (ft³/s), `00065` = Gage height (ft), `00010` = Temperature (°C), `72019` = Depth to water level (ft), and more
- Filter by thematic domain: `streamflow`, `groundwater`, `temperature`, `meteorological`, `water-quality`, or `all`
- Use this first — parameter codes are required by every other water tool

---

### `water_find_sites`

Discover USGS monitoring sites before calling data tools — all other tools require a site number.

- Geographic scoping: bounding box (`"west,south,east,north"` decimal degrees), 2-letter state code, bare 5-digit FIPS county code (e.g. `51013`), or HUC watershed code — either a 2-digit major HUC (`02`) or an 8-digit minor HUC (`02070008`), the only two lengths NWIS accepts
- Site type filtering: `ST` (stream), `GW` (groundwater well), `LK` (lake/reservoir), `SP` (spring), and more
- Parameter filter: only return sites that have data for a specific parameter code — comma-separate to require several (e.g. `00060,00065`)
- Data type filter: require sites with real-time (`iv`), daily (`dv`), or groundwater (`gw`) data
- Returns site number, name, coordinates, type, state/county/HUC codes, and drainage area (expanded mode only) — altitude is included in both modes when USGS records it

---

### `water_get_readings`

Get the latest instantaneous (~15 min) values for one or more USGS monitoring sites.

- Batch up to 100 site numbers in a single call
- Accepts any parameter code discoverable via `water_list_parameters`
- Configurable lookback period via ISO 8601 duration (e.g. `PT2H` = last 2 hours, `P7D` = last 7 days)
- Returns per-site, per-parameter records with timestamp, value, unit, and provisional/approved qualifier
- Bounded by design: each series carries its 10 most recent records, with `totalValues` reporting how many the period actually held and `truncated` flagging the cap. Use `water_get_series` when you need the full series
- Partial batches are explicit: requested sites NWIS returns no data for are named in `missingSites` rather than dropped silently
- Groundwater depth available via `parameterCd=72019` (the legacy `gwlevels` endpoint was decommissioned November 2025 — use the IV service instead)

---

### `water_get_series`

Get a historical time series for a site and parameter over a date range.

- Daily values (DV service, one value per day) or instantaneous values (IV service, ~15 min resolution)
- Returns site name, parameter name, unit code, and time-ordered value records with qualifiers
- **DataCanvas spillover:** large date ranges (>500 records) automatically spill to a DuckDB-backed canvas when `CANVAS_PROVIDER_TYPE=duckdb` is set — response includes `canvas_id` and `table_name` for follow-up SQL via `water_dataframe_query`
- Without DataCanvas, returns the most recent 500 records with a `truncated` flag and `totalRecords` count
- Supports chaining: pass a prior `canvas_id` to append data to an existing canvas

---

### `water_get_conditions`

Get current hydrologic conditions placed in full historical context.

- Fetches the current IV reading and the full daily percentile table in parallel
- Classifies the reading: `record-high` (≥ p95), `above-normal` (p75–p95), `normal` (p25–p75), `below-normal` (p10–p25), `low` (p05–p10), `record-low` (< p05)
- Pairs each class with a `percentileLabel` spelling out the threshold — `record-high` and `record-low` mark percentile-of-record extremes, not verified all-time records, and the label says so where the class name does not
- Ranks against the observation's own calendar day, so a reading near midnight is not compared against the neighboring day's percentiles
- Discloses the granularity approximation in `comparisonBasis`: the reading is instantaneous while the percentiles are approved daily-mean values, so the class is a "how unusual is this" ranking — not a flood-stage or drought determination, which need authoritative thresholds this tool does not fetch
- Validates `site` and `parameterCd` at the schema edge; a well-formed value NWIS still rejects surfaces as the typed `invalid_request` reason rather than an opaque upstream error
- Gracefully degrades when historical context is missing: returns the current reading with `historicalContext: null` and a `historicalContextStatus` saying why — `no_record` (new/short record), `no_matching_day` (no row for the date), or `unavailable` (stat call failed — transient and retryable, kept distinct from a sparse record)

---

### `water_dataframe_describe` / `water_dataframe_query`

In-conversation SQL analytics over the time-series dataframes that `water_get_series` materializes on a DuckDB-backed canvas.

**Workflow:**
1. Call `water_get_series` with a large date range — when DataCanvas is enabled, the response includes `canvas_id` and `table_name`
2. Call `water_dataframe_describe` with the `canvas_id` to confirm the table schema (columns: `date_time`, `value`, `qualifiers`, `site_number`, `parameter_cd`, `unit_code`)
3. Call `water_dataframe_query` with the `canvas_id` and a SELECT statement to run aggregates, filter by qualifier, or join multiple series

Read-only by default — only SELECT statements are permitted. Results are capped at 10,000 rows. Requires `CANVAS_PROVIDER_TYPE=duckdb` in the server environment.

## Resources and prompts

| Type | Name | Description |
|:-----|:-----|:------------|
| Resource | `usgs-water://site/{siteId}` | Site metadata: name, coordinates, type, HUC, state, county, drainage area, and altitude |
| Resource | `usgs-water://parameters` | Full parameter code catalog (same data as `water_list_parameters`) |

All resource data is also reachable via tools. Use `water_find_sites` for geographic site discovery.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

USGS NWIS–specific:

- Wraps NWIS IV (instantaneous), DV (daily), site, and stat endpoints — no API key required, fully public
- Input formats checked at the edge against what NWIS actually accepts — site numbers, parameter codes, ISO 8601 periods, HUC, FIPS county, state, and bbox all carry a validated pattern that is advertised in each tool's JSON Schema, so malformed values fail with a pointed message instead of an opaque upstream 400
- HTML error detection: NWIS returns 400 with an HTML body for bad inputs; the service layer extracts NWIS's own message — which names the field it rejected — and maps it to a typed failure
- Multi-site batching: `water_get_readings` accepts up to 100 site numbers in one call
- Provisional vs. approved data qualifiers surfaced on every reading — not hidden from callers
- DataCanvas spillover: `water_get_series` materializes large date-range responses as DuckDB-backed `df_<id>` tables queryable via `water_dataframe_query`
- Groundwater via the IV service using parameter `72019` — the legacy `gwlevels` endpoint was decommissioned November 2025

Agent-friendly output:

- Percentile classification on every conditions response — callers get a `percentileClass` string (`record-high`, `normal`, `record-low`, etc.) they can act on directly without parsing numeric thresholds, plus a `percentileLabel` stating the threshold in plain language so the `record-*` classes are not mistaken for verified all-time records
- Partial success on conditions: when percentiles are missing, the current reading still returns with `historicalContext: null` and a `historicalContextStatus` that separates an empty stat table (`no_record` / `no_matching_day`) from a failed stat call (`unavailable`, transient), rather than collapsing both into an error
- Partial success on batches: `water_get_readings` returns the series it got and names the rest in `missingSites`, so a silently dropped site never reads as a complete answer
- Truncation signals: `water_get_series` reports `totalRecords` and `truncated`, and `water_get_readings` reports per-series `totalValues` plus `truncated`, so callers know when a preview is incomplete. `canvas_id` / `table_name` tell them exactly how to retrieve the rest
- Structured content and rendered text agree: every cap and count a tool applies is reported identically in `structuredContent` and in the markdown, so neither class of client sees a different answer

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

To enable DataCanvas for SQL analytics over large time-series results, add `CANVAS_PROVIDER_TYPE=duckdb` to the `env` block in any of the configs above.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.14](https://bun.sh/) or higher (or Node.js v24+).
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
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spillover for large time-series results from `water_get_series`. | — |
| `USGS_USER_AGENT` | Custom User-Agent string sent to USGS NWIS. USGS requests a descriptive User-Agent per their terms. | `usgs-water-mcp-server/0.1.11 (contact: https://github.com/cyanheads/usgs-water-mcp-server)` |
| `USGS_REQUEST_TIMEOUT_MS` | HTTP request timeout in milliseconds for NWIS calls. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
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
| `src/services/canvas` | DataCanvas accessor for DuckDB-backed spillover. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.

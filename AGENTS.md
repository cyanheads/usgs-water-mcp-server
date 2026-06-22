# Developer Protocol

**Server:** usgs-water-mcp-server
**Version:** 0.1.7
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.10.9`
**Engines:** Bun ≥1.3.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/sdk` ^1.29.0
**Zod:** ^4.4.3

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Check `ctx.elicit` / `ctx.sample`** for presence before calling.
- **Secrets in env vars only** — never hardcoded.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool (data-returning, with typed error contract)

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { findSites } from '@/services/nwis/nwis-service.js';

export const waterFindSites = tool('water_find_sites', {
  description: 'Find USGS water monitoring sites by bounding box, state, county, or HUC watershed code.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    stateCd: z.string().optional().describe('2-character US state abbreviation (e.g. "WA").'),
    siteType: z.string().optional().describe('Site type filter: "ST" (stream), "GW" (groundwater well).'),
  }),
  output: z.object({
    sites: z.array(z.object({
      siteNumber: z.string().describe('USGS site number (8–15 digits).'),
      siteName: z.string().describe('Human-readable USGS site name.'),
    })).describe('Matching USGS monitoring sites.'),
    total: z.number().int().describe('Total number of sites returned.'),
  }),

  errors: [
    { reason: 'no_sites_found', code: JsonRpcErrorCode.NotFound,
      when: 'No sites match the given geographic and filter criteria.',
      recovery: 'Broaden the bounding box, remove parameterCd or siteType filters, or try a different state/HUC.' },
    { reason: 'upstream_error', code: JsonRpcErrorCode.InternalError,
      when: 'NWIS returned a 5xx error or the request timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true },
  ],

  async handler(input, ctx) {
    const sites = await findSites({ stateCd: input.stateCd, siteType: input.siteType }, ctx.signal);
    if (sites.length === 0) throw ctx.fail('no_sites_found', 'No USGS sites match the specified filters.');
    ctx.log.info('Sites found', { count: sites.length });
    return { sites, total: sites.length };
  },

  format: (result) => [{
    type: 'text',
    text: result.sites.map(s => `**${s.siteNumber}**: ${s.siteName}`).join('\n'),
  }],
});
```

### Tool (DataCanvas spillover)

```ts
import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

// In handler — large result sets spill to DuckDB canvas:
const canvas = getCanvas();
if (canvas && rows.length > SPILLOVER_THRESHOLD) {
  const instance = await canvas.acquire(input.canvas_id, ctx);
  const spillResult = await spillover({ canvas: instance, source: rows, tableName, previewChars, signal: ctx.signal });
  return { ...baseResult, canvas_id: instance.canvasId, table_name: spillResult.handle.tableName, truncated: true };
}
```

### Resource

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound } from '@cyanheads/mcp-ts-core/errors';
import { getSiteInfo } from '@/services/nwis/nwis-service.js';

export const waterSiteResource = resource('usgs-water://site/{siteId}', {
  name: 'usgs-water-site',
  description: 'Site metadata for a USGS monitoring site: name, coordinates, type, HUC watershed code.',
  mimeType: 'application/json',
  params: z.object({ siteId: z.string().describe('USGS site number (8–15 digits).') }),
  async handler(params, ctx) {
    const site = await getSiteInfo(params.siteId, ctx.signal);
    if (!site) throw notFound(`Site ${params.siteId} not found.`, { siteId: params.siteId });
    return site;
  },
  list: () => ({ resources: [{ uri: 'usgs-water://site/01646500', name: 'Potomac River at Little Falls, MD', mimeType: 'application/json' }] }),
});
```

### Server config

```ts
// src/config/server-config.ts
import { z } from '@cyanheads/mcp-ts-core';
import { parseEnvConfig } from '@cyanheads/mcp-ts-core/config';

const ServerConfigSchema = z.object({
  userAgent: z.string().default('usgs-water-mcp-server/0.1.7 (contact: https://github.com/cyanheads/usgs-water-mcp-server)')
    .describe('User-Agent header sent to USGS NWIS.'),
  requestTimeoutMs: z.coerce.number().default(30_000).describe('HTTP request timeout in milliseconds.'),
});

let _config: z.infer<typeof ServerConfigSchema> | undefined;
export function getServerConfig() {
  _config ??= parseEnvConfig(ServerConfigSchema, {
    userAgent: 'USGS_USER_AGENT',
    requestTimeoutMs: 'USGS_REQUEST_TIMEOUT_MS',
  });
  return _config;
}
```

---

## Context

Handlers receive a unified `ctx` object. Key properties used in this server:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. |
| `ctx.state` | Tenant-scoped KV — `.get(key)`, `.set(key, value, { ttl? })`, `.delete(key)`, `.list(prefix, { cursor, limit })`. Accepts any serializable value. |
| `ctx.signal` | `AbortSignal` for cancellation. |
| `ctx.requestId` | Unique request ID. |
| `ctx.tenantId` | Tenant ID from JWT or `'default'` for stdio. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Typed error contract (preferred).** Declare `errors: [{ reason, code, when, recovery, retryable? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability.

**Fallback:** throw via factories or plain `Error`.

```ts
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Site not found', { siteId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp() entry point — registers tools/resources, inits canvas
  config/
    server-config.ts                    # USGS_USER_AGENT, USGS_REQUEST_TIMEOUT_MS (Zod schema)
  services/
    canvas/
      canvas-accessor.ts               # setCanvas() / getCanvas() accessors for DataCanvas
    nwis/
      nwis-service.ts                   # NWIS HTTP client — IV, DV, site, stat endpoints
      types.ts                          # NWIS domain types (NwisTimeSeries, NwisValueRecord, PercentileClass, etc.)
  mcp-server/
    tools/definitions/
      water-list-parameters.tool.ts     # Static parameter code lookup (no network)
      water-find-sites.tool.ts          # Site discovery via NWIS site service (RDB)
      water-get-readings.tool.ts        # Latest IV values, up to 100 sites
      water-get-series.tool.ts          # Historical DV/IV time series with DataCanvas spillover
      water-get-conditions.tool.ts      # Current reading + percentile classification
      water-dataframe-describe.tool.ts  # List tables on a DataCanvas
      water-dataframe-query.tool.ts     # SQL SELECT against DataCanvas tables
    resources/definitions/
      water-site.resource.ts            # usgs-water://site/{siteId}
      water-parameters.resource.ts      # usgs-water://parameters
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `water-find-sites.tool.ts` |
| Tool/resource names | snake_case | `water_find_sites` |
| Directories | kebab-case | `src/services/nwis/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Find USGS water monitoring sites by bounding box.'` |

---

## Skills

Skills are modular instructions in `skills/` at the project root. Read them directly when a task matches — e.g., `skills/add-tool/SKILL.md` when adding a tool.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `devcheck` | Lint, format, typecheck, audit |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a versioned commit + annotated tag — version bump, changelog, verify, tag. Local only. |
| `release-and-publish` | Push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, logger, state, progress |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-06-05`).

---

## Commands

**Runtime:** Scripts use `tsx` — both `npm run <cmd>` and `bun run <cmd>` work. `bun` is slightly faster for script invocation but not required.

| Command | Purpose |
|:--------|:--------|
| `npm run build` | Compile TypeScript |
| `npm run rebuild` | Clean + build |
| `npm run clean` | Remove build artifacts |
| `npm run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:refresh` | Delete `bun.lock`, reinstall, and re-run `bun audit`. Use when `devcheck` flags a transitive advisory. |
| `npm run tree` | Generate directory structure doc |
| `npm run format` | Auto-fix formatting (safe fixes only) |
| `npm run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `npm test` | Run tests |
| `npm run start:stdio` | Production mode (stdio) |
| `npm run start:http` | Production mode (HTTP) |
| `npm run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `npm run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `npm run bundle` | Build and pack as `.mcpb` for one-click Claude Desktop install |
| `npm run publish-mcp` | Publish to the MCP Registry via mcp-publisher |

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match.

---

## Changelog

Directory-based. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release. `changelog/template.md` is a **pristine format reference** — never edited or moved. `CHANGELOG.md` is a **navigation index** regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { spillover } from '@cyanheads/mcp-ts-core/canvas';

// Server's own code — via path alias
import { getServerConfig } from '@/config/server-config.js';
import { findSites } from '@/services/nwis/nwis-service.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — both `structuredContent` and `content[]` must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated and in sync with `package.json`
- [ ] `.claude-plugin/plugin.json` populated and in sync with `package.json`
- [ ] `npm run devcheck` passes

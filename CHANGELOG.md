# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-17 · ⚠️ Breaking

BREAKING: hucCd is now optional on water_find_sites sites[].hucCd and the usgs-water://site/{siteId} resource. It is omitted for sites USGS NWIS assigns no Hydrologic Unit Code, where the prior release backfilled an empty string that printed a bare HUC label. Consumers must treat hucCd as possibly-absent.

## [0.1.13](changelog/0.1.x/0.1.13.md) — 2026-07-16

Rendering-correctness fixes: water_get_series renders every returned value (not just the last 20) and its spillover notice reports the real preview count instead of a fixed 500; water_find_sites renders basic-mode altitude independently of drainageArea and no longer leaks a literal notice: undefined into content[].

## [0.1.12](changelog/0.1.x/0.1.12.md) — 2026-07-16

water_find_sites stages its full match set to a DuckDB DataCanvas when a query exceeds the 500-site inline cap and a canvas provider is enabled, returning canvas_id and table_name to retrieve every match past the cap via water_dataframe_query. An optional canvas_id input reuses an existing canvas.

## [0.1.11](changelog/0.1.x/0.1.11.md) — 2026-07-16

water_find_sites echoes the countyCd filter in its enrichment and trailer; the usgs-water://site/{siteId} resource validates siteId at the edge and declares a typed error contract; and stale site-metadata documentation — the removed available-data-types claim and altitude's mode boundary — is corrected.

## [0.1.10](changelog/0.1.x/0.1.10.md) — 2026-07-16

water_get_conditions validates site and parameterCd at the schema edge, reports why historical context is missing via a new historicalContextStatus enum, and drops the flood/drought framing for an explicit instantaneous-vs-daily-mean disclosure.

## [0.1.9](changelog/0.1.x/0.1.9.md) — 2026-07-15

Fix a midnight timezone bug in water_get_conditions' stat-row matching, add a percentileLabel field, and correct the hucCd width claim.

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-07-15

Validate NWIS inputs at the edge, bound and complete water_get_readings output, and adopt the mcp-ts-core 0.10.14 supply-chain baseline.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-21

Sanitize the CANVAS_PROVIDER_TYPE env var out of the canvas-disabled error contract and server instructions; reroute the operator hint to the server log. Follow-up to #2, which sanitized the tool descriptions.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9: check-dependency-specifiers devcheck guard, plugin-manifest packaging checks, re-synced framework tooling and skills. Framework-maintenance only — no tool behavior changes.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6: refined error codes, denySystemCatalogs SQL hardening, explicit server identity, Docker healthcheck, and post-pack bundle cleaning

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-08

Fix water_find_sites unbounded results and empty expanded fields; add YYYY-MM-DD date validation to water_get_series

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Fix misclassified site_not_found errors, remove internal env var from tool descriptions, add query enrichment context, and make stateCd/countyCd optional in basic mode

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-06

Public hosted endpoint at https://usgs-water.caseyjhand.com/mcp

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 5 USGS NWIS water-data tools + 2 DataCanvas SQL tools + 2 resources over the USGS National Water Information System, with security hardening of upstream error handling

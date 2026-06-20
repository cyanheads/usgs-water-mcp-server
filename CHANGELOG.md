# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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

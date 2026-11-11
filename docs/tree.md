# usgs-water-mcp-server - Directory Structure

Generated on: 2026-11-11 11:04:58

```text
usgs-water-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
│   └── template.md
├── docs/
│   ├── design.md
│   └── idea.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-skill/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   └── usgs-water-guide/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       ├── water-parameters.resource.ts
│   │   │       └── water-site.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── index.ts
│   │           ├── water-dataframe-describe.tool.ts
│   │           ├── water-dataframe-drop.tool.ts
│   │           ├── water-dataframe-query.tool.ts
│   │           ├── water-find-sites.tool.ts
│   │           ├── water-get-conditions.tool.ts
│   │           ├── water-get-readings.tool.ts
│   │           ├── water-get-series.tool.ts
│   │           ├── water-get-site-data-catalog.tool.ts
│   │           └── water-list-parameters.tool.ts
│   ├── services/
│   │   ├── canvas/
│   │   │   ├── acquire-canvas.ts
│   │   │   ├── canvas-accessor.ts
│   │   │   └── canvas-table-name.ts
│   │   └── waterdata/
│   │       ├── cql2-text.ts
│   │       ├── curated-parameters.ts
│   │       ├── day-statistics.ts
│   │       ├── input-schemas.ts
│   │       ├── observation-series.ts
│   │       ├── observations.ts
│   │       ├── parameter-catalog.ts
│   │       ├── request-deadline.ts
│   │       ├── site-data-catalog.ts
│   │       ├── site-discovery.ts
│   │       ├── site-local-time.ts
│   │       ├── site-resolver.ts
│   │       ├── state-fips-codes.ts
│   │       ├── statistic-codes.ts
│   │       ├── types.ts
│   │       ├── water-data-client.ts
│   │       └── water-data-errors.ts
│   └── index.ts
├── tests/
│   ├── config/
│   │   ├── server-config.test.ts
│   │   └── startup.test.ts
│   ├── fixtures/
│   │   └── waterdata/
│   │       ├── conditions-upstream-continuous-12396500-00065-20261111T0205Z.json
│   │       ├── conditions-upstream-continuous-261620081464402-62610-20261110T1505Z.json
│   │       ├── conditions-upstream-continuous-322323106314701-72019-20261111T0705Z.json
│   │       ├── conditions-upstream-continuous-404931073382101-62610-P1D.json
│   │       ├── conditions-upstream-points-12396500-00065.json
│   │       ├── conditions-upstream-points-261620081464402-62610.json
│   │       ├── conditions-upstream-points-322323106314701-72019.json
│   │       ├── conditions-upstream-points-404931073382101-62610.json
│   │       ├── error-400-invalid-parameter-value.json
│   │       ├── error-403-api-key-invalid.json
│   │       ├── error-429-over-rate-limit.json
│   │       ├── expected-waterservices-dv-01646500-00010-20190901-05.json
│   │       ├── expected-waterservices-dv-01646500-00060-20240101-10.json
│   │       ├── expected-waterservices-iv-01646500-00060-dst.json
│   │       ├── expected-waterservices-iv-readings-PT2H.json
│   │       ├── monitoring-locations-by-number.json
│   │       ├── monitoring-locations-conditions-sites.json
│   │       ├── observations-continuous-01646500-00060-dst-fall.json
│   │       ├── observations-continuous-01646500-00060-dst-spring.json
│   │       ├── observations-continuous-parameter-in.json
│   │       ├── observations-continuous-readings-PT2H.json
│   │       ├── observations-daily-01646500-00010-20190901-05.json
│   │       ├── observations-daily-01646500-00060-20240101-10.json
│   │       ├── observations-parameter-codes.json
│   │       ├── observations-resolver-readings.json
│   │       ├── observations-statistic-codes.json
│   │       ├── observations-time-zone-codes.json
│   │       ├── observations-tsm-daily-01646500-00010.json
│   │       ├── observations-tsm-daily-01646500-00060.json
│   │       ├── observations-tsm-readings-points.json
│   │       ├── parameter-codes-page-1.json
│   │       ├── parameter-codes-page-2.json
│   │       ├── site-detail-01646500.json
│   │       ├── site-detail-364643089212301.json
│   │       ├── site-ogc-sparse.json
│   │       ├── site-page-one.json
│   │       ├── site-page-two.json
│   │       ├── sites-bbox-latest-daily-00060.json
│   │       ├── sites-bbox-st-latest-continuous-00060-p7d.json
│   │       ├── sites-bbox-st-latest-continuous-00060.json
│   │       ├── sites-bbox-st-latest-continuous.json
│   │       ├── sites-bbox-st-latest-daily.json
│   │       ├── sites-bbox-st-latest-field-measurements.json
│   │       ├── sites-bbox-st-locations.json
│   │       ├── sites-bbox-st-peaks-trimmed.json
│   │       ├── sites-county-51013-51510-locations.json
│   │       ├── sites-small-bbox-gw-levels.json
│   │       ├── sites-small-bbox-locations.json
│   │       ├── states-us.json
│   │       ├── statistics-intervals-01646500-00010-40bfcf38.json
│   │       ├── statistics-intervals-01646500-00060-2cf409b0.json
│   │       ├── statistics-intervals-12396500-00065-81f6f58a.json
│   │       ├── statistics-intervals-12396500-00065-f3f93cac.json
│   │       ├── statistics-intervals-14174450-00060-008d4cef.json
│   │       ├── statistics-intervals-14233500-00060-06f3af03.json
│   │       ├── statistics-intervals-322323106314701-72019-0d91e794.json
│   │       ├── statistics-intervals-394829074053503-72019-a6f5254c.json
│   │       ├── statistics-intervals-401105074120201-72019-ef4df5f1.json
│   │       ├── statistics-intervals-404931073382101-62610-f2b89f59.json
│   │       ├── statistics-intervals-414429074052001-72019-346545fa.json
│   │       ├── statistics-normals-01646500-00010-1111.json
│   │       ├── statistics-normals-01646500-00060-0229.json
│   │       ├── statistics-normals-01646500-00060-1111.json
│   │       ├── statistics-normals-12396500-00065-1110.json
│   │       ├── statistics-normals-14174450-00060-1110.json
│   │       ├── statistics-normals-14233500-00060-1110.json
│   │       ├── statistics-normals-261620081464402-62610-1110.json
│   │       ├── statistics-normals-322323106314701-72019-1111.json
│   │       ├── statistics-normals-394829074053503-72019-1111.json
│   │       ├── statistics-normals-401105074120201-72019-1110.json
│   │       ├── statistics-normals-404931073382101-62610-1110.json
│   │       ├── statistics-normals-414429074052001-72019-1111.json
│   │       ├── statistics-normals-page.json
│   │       ├── time-series-metadata-daily-mean-01646500-00010.json
│   │       ├── time-series-metadata-daily-mean-01646500-00060.json
│   │       ├── time-series-metadata-daily-mean-12396500-00065.json
│   │       ├── time-series-metadata-daily-mean-14174450-00060.json
│   │       ├── time-series-metadata-daily-mean-14233500-00060.json
│   │       ├── time-series-metadata-daily-mean-261620081464402-62610.json
│   │       ├── time-series-metadata-daily-mean-322323106314701-72019.json
│   │       ├── time-series-metadata-daily-mean-394829074053503-72019.json
│   │       ├── time-series-metadata-daily-mean-401105074120201-72019.json
│   │       ├── time-series-metadata-daily-mean-404931073382101-62610.json
│   │       └── time-series-metadata-daily-mean-414429074052001-72019.json
│   ├── helpers/
│   │   ├── content-block.ts
│   │   ├── error-contract.ts
│   │   ├── water-data-fake.test.ts
│   │   └── water-data-fake.ts
│   ├── prompts/
│   ├── resources/
│   │   ├── water-parameters.resource.test.ts
│   │   └── water-site.resource.test.ts
│   ├── scripts/
│   │   └── bundle-entries.test.ts
│   ├── services/
│   │   ├── acquire-canvas.test.ts
│   │   ├── canvas-table-name.test.ts
│   │   ├── cql2-text.test.ts
│   │   ├── day-statistics.test.ts
│   │   ├── observation-series.test.ts
│   │   ├── observations.test.ts
│   │   ├── parameter-catalog.test.ts
│   │   ├── site-data-catalog.test.ts
│   │   ├── site-discovery.test.ts
│   │   ├── site-local-time.test.ts
│   │   ├── site-resolver.test.ts
│   │   ├── statistic-codes.test.ts
│   │   └── water-data-client.test.ts
│   └── tools/
│       ├── water-dataframe-describe.tool.test.ts
│       ├── water-dataframe-drop.gate.test.ts
│       ├── water-dataframe-drop.tool.test.ts
│       ├── water-dataframe-query.tool.test.ts
│       ├── water-find-sites.tool.test.ts
│       ├── water-get-conditions.tool.test.ts
│       ├── water-get-conditions.upstream.test.ts
│       ├── water-get-readings.tool.test.ts
│       ├── water-get-readings.upstream.test.ts
│       ├── water-get-series.tool.test.ts
│       ├── water-get-series.upstream.test.ts
│       └── water-list-parameters.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── mcp.json
├── package.json
├── plugin.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

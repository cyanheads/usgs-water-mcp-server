# usgs-water-mcp-server - Directory Structure

Generated on: 2026-09-25 05:01:47

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
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
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
│   │           ├── water-dataframe-query.tool.ts
│   │           ├── water-find-sites.tool.ts
│   │           ├── water-get-conditions.tool.ts
│   │           ├── water-get-readings.tool.ts
│   │           ├── water-get-series.tool.ts
│   │           └── water-list-parameters.tool.ts
│   ├── services/
│   │   ├── canvas/
│   │   │   ├── acquire-canvas.ts
│   │   │   ├── canvas-accessor.ts
│   │   │   └── canvas-table-name.ts
│   │   ├── nwis/
│   │   │   ├── input-schemas.ts
│   │   │   ├── nwis-service.ts
│   │   │   └── types.ts
│   │   └── waterdata/
│   │       ├── curated-parameters.ts
│   │       └── parameter-catalog.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── nwis/
│   │   │   ├── dv-01646500-00010-20190901-20190905-stat00003.json
│   │   │   ├── dv-01646500-00010-20190901-20190905.json
│   │   │   ├── dv-01646500-00060-20240101-20240110.json
│   │   │   ├── dv-12024000-00060-20260910-20260924.json
│   │   │   ├── iv-01589485-00010.json
│   │   │   ├── iv-01638500-01646500-00060.json
│   │   │   ├── iv-01646500-00010.json
│   │   │   ├── iv-01646500-00060.json
│   │   │   ├── iv-01646500-12024000-00060.json
│   │   │   ├── iv-12024000-00060.json
│   │   │   ├── iv-12036400-00060.json
│   │   │   ├── iv-12056500-00010.json
│   │   │   ├── iv-12396500-00065.json
│   │   │   ├── iv-14233500-00060.json
│   │   │   ├── stat-01646500-00010-0924.rdb
│   │   │   ├── stat-01646500-00060-0924.rdb
│   │   │   ├── stat-12024000-00060-0924.rdb
│   │   │   ├── stat-12036400-00060-empty.rdb
│   │   │   ├── stat-12056500-00010-0924.rdb
│   │   │   ├── stat-12396500-00065-0924.rdb
│   │   │   └── stat-14233500-00060-0924.rdb
│   │   └── waterdata/
│   │       ├── parameter-codes-page-1.json
│   │       └── parameter-codes-page-2.json
│   ├── helpers/
│   │   ├── content-block.ts
│   │   ├── error-contract.ts
│   │   ├── nwis-fixtures.ts
│   │   └── waterdata-fixtures.ts
│   ├── prompts/
│   ├── resources/
│   │   ├── water-parameters.resource.test.ts
│   │   └── water-site.resource.test.ts
│   ├── services/
│   │   ├── acquire-canvas.test.ts
│   │   ├── canvas-table-name.test.ts
│   │   ├── nwis-service.test.ts
│   │   └── parameter-catalog.test.ts
│   └── tools/
│       ├── water-dataframe-describe.tool.test.ts
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
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._

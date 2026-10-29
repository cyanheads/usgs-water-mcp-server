/**
 * @fileoverview Agent-doc selection in the bundle cleaner and the post-bundle
 * check. Both must strip dependency-shipped agent docs at a package root while
 * keeping runtime code that merely lives under a `skills/` directory, such as
 * the MCP SDK's `dist/ext/skills/` loader a skills-serving server needs at boot.
 *
 * @module tests/scripts/bundle-entries.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

const RUNTIME_ENTRIES = [
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
  'node_modules/parent/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.js',
  'node_modules/runtime/dist/skills/loader.js',
  'skills/water-conditions/SKILL.md',
];

const AGENT_DOC_ENTRIES = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/@scope/pkg/skills/helper/SKILL.md',
  'node_modules/@scope/pkg/.claude/settings.json',
  'node_modules/@scope/pkg/.agents/skills/helper/SKILL.md',
  'node_modules/@scope/pkg/SKILL.md',
  'node_modules/pkg/framework-skills/setup/SKILL.md',
  'node_modules/pkg/skills/helper/SKILL.md',
  'node_modules/pkg/.claude/settings.json',
  'node_modules/pkg/.agents/notes.md',
  'node_modules/pkg/SKILL.md',
  'node_modules/parent/node_modules/pkg/framework-skills/setup/SKILL.md',
  'node_modules/parent/node_modules/@scope/pkg/skills/helper/SKILL.md',
  'node_modules/parent/node_modules/pkg/.claude/settings.json',
  'node_modules/parent/node_modules/@scope/pkg/.agents/notes.md',
  'node_modules/parent/node_modules/pkg/SKILL.md',
];

describe('filterAgentDocEntries (clean-mcpb)', () => {
  it('keeps runtime entries under a non-root skills/ directory and the root skills/ tree', () => {
    expect(filterAgentDocEntries(RUNTIME_ENTRIES)).toEqual([]);
  });

  it('selects package-root agent docs in scoped, unscoped, and nested packages', () => {
    expect(filterAgentDocEntries(AGENT_DOC_ENTRIES)).toEqual(AGENT_DOC_ENTRIES);
  });
});

describe('checkBundleEntries (lint-packaging check 8)', () => {
  it('reports nothing for runtime entries under a non-root skills/ directory', () => {
    expect(checkBundleEntries(RUNTIME_ENTRIES, 'dist/test.mcpb')).toEqual([]);
  });

  it('reports every package-root agent doc', () => {
    const errors = checkBundleEntries(AGENT_DOC_ENTRIES, 'dist/test.mcpb');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(
      `contains ${AGENT_DOC_ENTRIES.length} node_modules agent-doc entries`,
    );
  });
});

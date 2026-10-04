/**
 * @fileoverview Tests for the WATER_DATAFRAME_DROP_ENABLED gate on water_dataframe_drop. Each case
 * loads the tool definitions fresh under one flag value and serves them through the framework's
 * own handler, so the assertions cover what a client lists and what the landing page shows — not
 * only the shape of the exported definition.
 * @module tests/tools/water-dataframe-drop.gate.test
 */

import { createWorkerHandler } from '@cyanheads/mcp-ts-core/worker';
import { afterEach, describe, expect, it, vi } from 'vitest';

type ToolDefinitions = typeof import('@/mcp-server/tools/definitions/index.js');
const PROTOCOL_REVISION = '2026-07-28';
const DISABLED_KEY = '__mcpDisabled';

const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
} as unknown as Parameters<ReturnType<typeof createWorkerHandler>['fetch']>[2];

/** Import the tool barrel fresh with WATER_DATAFRAME_DROP_ENABLED set to `flag` (undefined = unset). */
async function loadDefinitions(flag: string | undefined): Promise<ToolDefinitions> {
  vi.resetModules();
  vi.stubEnv('WATER_DATAFRAME_DROP_ENABLED', flag);
  return await import('@/mcp-server/tools/definitions/index.js');
}

/** Serve every tool definition the barrel exports, the way src/index.ts registers them. */
function serve(definitions: ToolDefinitions) {
  return createWorkerHandler({
    name: 'usgs-water-mcp-server',
    title: 'usgs-water-mcp-server',
    tools: Object.values(definitions),
    resources: [],
    prompts: [],
  });
}

/** Names a client receives from tools/list. */
async function listedToolNames(handler: ReturnType<typeof serve>): Promise<string[]> {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_REVISION,
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL_REVISION,
            'io.modelcontextprotocol/clientInfo': { name: 'gate-test', version: '1.0.0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
    {},
    executionContext,
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const payload = body.startsWith('{')
    ? body
    : body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');
  const { result } = JSON.parse(payload) as { result: { tools: { name: string }[] } };
  return result.tools.map((t) => t.name);
}

/** The HTML landing page, the one surface that renders a disabled tool. */
async function landingPage(handler: ReturnType<typeof serve>): Promise<string> {
  const response = await handler.fetch(new Request('http://localhost/'), {}, executionContext);
  expect(response.status).toBe(200);
  return await response.text();
}

describe('water_dataframe_drop opt-in gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it.each([
    ['unset', undefined],
    ['false', 'false'],
    ['blank', ''],
  ])('wraps the tool in disabledTool() when the flag is %s', async (_label, flag) => {
    const { waterDataframeDrop } = await loadDefinitions(flag);

    expect(waterDataframeDrop).toHaveProperty(DISABLED_KEY, {
      reason: 'Dropping staged tables is turned off in this deployment.',
      hint: 'WATER_DATAFRAME_DROP_ENABLED=true',
    });
    // The wrapper keeps the definition whole, so enabling it needs no other change.
    expect(waterDataframeDrop.name).toBe('water_dataframe_drop');
    expect(typeof waterDataframeDrop.handler).toBe('function');
  });

  it('keeps the disabled tool out of tools/list but on the landing page with its enable hint', async () => {
    const handler = serve(await loadDefinitions(undefined));

    const listed = await listedToolNames(handler);
    expect(listed).not.toContain('water_dataframe_drop');
    expect(listed).toEqual(
      expect.arrayContaining(['water_dataframe_describe', 'water_dataframe_query']),
    );
    expect(listed).toHaveLength(7);

    const landing = await landingPage(handler);
    expect(landing).toContain('water_dataframe_drop');
    expect(landing).toContain('WATER_DATAFRAME_DROP_ENABLED=true');
  });

  it('registers the plain, callable definition when the flag is true', async () => {
    const definitions = await loadDefinitions('true');

    expect(definitions.waterDataframeDrop).not.toHaveProperty(DISABLED_KEY);
    const listed = await listedToolNames(serve(definitions));
    expect(listed).toContain('water_dataframe_drop');
    expect(listed).toHaveLength(8);
  });
});

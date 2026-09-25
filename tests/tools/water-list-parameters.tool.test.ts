/**
 * @fileoverview Tests for water_list_parameters tool — static parameter code catalog.
 * @module tests/tools/water-list-parameters.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  type FetchMockHarness,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterListParameters } from '@/mcp-server/tools/definitions/water-list-parameters.tool.js';
import { textContent } from '../helpers/content-block.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import { allText } from '../helpers/nwis-fixtures.js';
import { catalogRoutes, failingCatalogRoute } from '../helpers/waterdata-fixtures.js';

describe('waterListParameters', () => {
  it('returns the full catalog when group is "all"', async () => {
    const ctx = createMockContext({ errors: waterListParameters.errors });
    const input = waterListParameters.input.parse({ group: 'all' });
    const result = await waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(5);
    expect(result.parameters.length).toBe(result.total);
    expect(result.parameters.some((p) => p.code === '00060')).toBe(true);
    expect(result.parameters.some((p) => p.code === '72019')).toBe(true);
  });

  it('defaults to "all" group', async () => {
    const ctx = createMockContext({ errors: waterListParameters.errors });
    const input = waterListParameters.input.parse({});
    const result = await waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(5);
  });

  it('filters to streamflow group', async () => {
    const ctx = createMockContext({ errors: waterListParameters.errors });
    const input = waterListParameters.input.parse({ group: 'streamflow' });
    const result = await waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.parameters.every((p) => p.group === 'streamflow')).toBe(true);
    expect(result.parameters.some((p) => p.code === '00060')).toBe(true);
    expect(result.parameters.some((p) => p.code === '72019')).toBe(false);
  });

  it('filters to groundwater group', async () => {
    const ctx = createMockContext({ errors: waterListParameters.errors });
    const input = waterListParameters.input.parse({ group: 'groundwater' });
    const result = await waterListParameters.handler(input, ctx);
    expect(result.total).toBeGreaterThan(0);
    expect(result.parameters.every((p) => p.group === 'groundwater')).toBe(true);
    expect(result.parameters.some((p) => p.code === '72019')).toBe(true);
  });

  it('returns structurally valid records', async () => {
    const ctx = createMockContext({ errors: waterListParameters.errors });
    const input = waterListParameters.input.parse({ group: 'all' });
    const result = await waterListParameters.handler(input, ctx);
    for (const p of result.parameters) {
      expect(p.code).toMatch(/^\d{5}$/);
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.unit.length).toBeGreaterThan(0);
      expect([
        'streamflow',
        'groundwater',
        'temperature',
        'meteorological',
        'water-quality',
      ]).toContain(p.group);
    }
  });

  it('formats all parameters as code — name (unit) lines', async () => {
    const ctx = createMockContext({ errors: waterListParameters.errors });
    const input = waterListParameters.input.parse({ group: 'streamflow' });
    const result = await waterListParameters.handler(input, ctx);
    const blocks = waterListParameters.format!(result);
    const text = textContent(blocks[0]);
    expect(text).toContain('00060');
    expect(text).toContain('Discharge');
    expect(text).toContain('ft');
    expect(text).toContain('streamflow');
  });
});

describe('waterListParameters — curated table (characterization)', () => {
  it('lists the curated codes in display order', async () => {
    const result = await waterListParameters.handler(
      waterListParameters.input.parse({}),
      createMockContext({ errors: waterListParameters.errors }),
    );
    expect(result.parameters.map((p) => p.code)).toEqual([
      '00060',
      '00065',
      '00010',
      '00045',
      '00095',
      '00300',
      '00400',
      '72019',
      '72020',
      '72150',
      '62610',
    ]);
  });

  it('lists the four groundwater codes for group "groundwater"', async () => {
    const result = await waterListParameters.handler(
      waterListParameters.input.parse({ group: 'groundwater' }),
      createMockContext({ errors: waterListParameters.errors }),
    );
    expect(result.parameters.map((p) => p.code)).toEqual(['72019', '72020', '72150', '62610']);
  });
});

describe('waterListParameters — curated labels match the USGS catalog (#31)', () => {
  it('names 62610 by its NGVD 1929 datum and 72150 by LMSL', async () => {
    const result = await waterListParameters.handler(
      waterListParameters.input.parse({ group: 'groundwater' }),
      createMockContext({ errors: waterListParameters.errors }),
    );
    const byCode = new Map(result.parameters.map((p) => [p.code, p.name]));
    expect(byCode.get('62610')).toBe('Groundwater level above NGVD 1929');
    expect(byCode.get('72150')).toBe('Groundwater level above LMSL');
  });
});

describe('waterListParameters — full-catalog query (#31)', () => {
  type Entry = {
    code: string;
    description?: string;
    group?: string;
    name: string;
    source: 'curated' | 'usgs-catalog';
    unit: string;
  };
  type Listing = { note?: string; parameters: Entry[]; total: number; truncated: boolean };

  let http: FetchMockHarness;
  /** The tool from a freshly loaded module graph, so every test starts with an empty catalog cache. */
  let tool: typeof waterListParameters;

  beforeEach(async () => {
    vi.resetModules();
    ({ waterListParameters: tool } = await import(
      '@/mcp-server/tools/definitions/water-list-parameters.tool.js'
    ));
    http = createFetchMock();
    http.install();
  });

  afterEach(() => {
    http.restore();
  });

  async function list(input: Record<string, unknown>) {
    const result = await runToolContract(tool, input as never);
    return {
      result,
      structured: result.structuredContent as Listing,
      text: allText(result.content),
    };
  }

  it.each([[{}], [{ group: 'groundwater' }], [{ query: '' }], [{ query: '  ' }]])(
    'answers %j from the curated table without a network call',
    async (input) => {
      const { result, structured } = await list(input);
      expect(result.isError).toBeFalsy();
      expect(http.calls).toHaveLength(0);
      expect(structured.truncated).toBe(false);
      expect(structured.parameters.every((p) => p.source === 'curated')).toBe(true);
    },
  );

  it('returns catalog entries with descriptions, counting every match', async () => {
    http.route(...catalogRoutes());
    const { result, structured, text } = await list({ query: 'turbidity' });

    expect(result.isError).toBeFalsy();
    // Both captured pages were read: the first page's next link was followed.
    expect(http.calls).toHaveLength(2);
    expect(structured.total).toBe(38);
    expect(structured.parameters).toHaveLength(25);
    expect(structured.truncated).toBe(true);
    expect(structured.parameters.every((p) => p.source === 'usgs-catalog')).toBe(true);
    expect(structured.parameters.find((p) => p.code === '63680')).toEqual({
      code: '63680',
      name: 'Turbidity, Form Neph',
      unit: 'FNU',
      description:
        'Turbidity, water, unfiltered, monochrome near infra-red LED light, 780-900 nm, detection angle 90 +-2.5 degrees, formazin nephelometric units (FNU)',
      source: 'usgs-catalog',
    });
    const first = structured.parameters[0];
    expect(first).toMatchObject({ source: 'usgs-catalog' });
    expect(first?.description).toMatch(/turbidity/i);
    expect(first?.group).toBeUndefined();
    expect(text).toContain('**25 of 38 parameter(s) matching "turbidity"**');
    expect(text).toContain(
      `\`${first?.code}\` — **${first?.name}** (${first?.unit}) · usgs-catalog`,
    );
    expect(text).toContain(first?.description ?? '(missing)');
  });

  it('lists a matching curated code once, first, as its curated entry', async () => {
    http.route(...catalogRoutes());
    const { structured, text } = await list({ query: 'discharge' });

    expect(structured.total).toBe(29);
    expect(structured.parameters[0]).toEqual({
      code: '00060',
      name: 'Discharge',
      unit: 'ft³/s',
      group: 'streamflow',
      source: 'curated',
    });
    expect(structured.parameters.filter((p) => p.code === '00060')).toHaveLength(1);
    expect(text).toContain('`00060` — **Discharge** (ft³/s) [streamflow] · curated');
  });

  it('puts pH first for a query of "pH"', async () => {
    http.route(...catalogRoutes());
    const { structured } = await list({ query: 'pH' });
    expect(structured.parameters[0]).toMatchObject({ code: '00400', source: 'curated' });
  });

  it('ranks name matches ahead of description-only matches, each by code', async () => {
    http.route(...catalogRoutes());
    const { structured } = await list({ query: 'dissolved oxygen' });

    const catalog = structured.parameters.filter((p) => p.source === 'usgs-catalog');
    const tokensInName = (p: Entry) => /\bdissolved\b/i.test(p.name) && /\boxygen\b/i.test(p.name);
    const firstDescriptionOnly = catalog.findIndex((p) => !tokensInName(p));
    expect(firstDescriptionOnly).toBeGreaterThan(0);
    expect(catalog.slice(firstDescriptionOnly).every((p) => !tokensInName(p))).toBe(true);
    const names = catalog.slice(0, firstDescriptionOnly).map((p) => p.code);
    expect(names).toEqual([...names].sort());
    const described = catalog.slice(firstDescriptionOnly).map((p) => p.code);
    expect(described).toEqual([...described].sort());
    expect(structured.parameters[0]).toMatchObject({ code: '00300', source: 'curated' });
  });

  it('matches a token only at the start of a word', async () => {
    http.route(...catalogRoutes());
    // "itrate" sits inside "nitrate" but starts no word.
    const { structured } = await list({ query: 'itrate' });
    expect(structured.total).toBe(0);
  });

  it('returns the catalog record for a bare 5-digit code', async () => {
    http.route(...catalogRoutes());
    const { structured } = await list({ query: '63680' });
    expect(structured.total).toBe(1);
    expect(structured.parameters).toEqual([
      expect.objectContaining({ code: '63680', source: 'usgs-catalog', unit: 'FNU' }),
    ]);
    expect(structured.parameters[0]?.description).toContain('formazin nephelometric units');
  });

  it('returns the curated entry for a bare curated code', async () => {
    http.route(...catalogRoutes());
    const { structured } = await list({ query: '00300' });
    expect(structured.parameters).toEqual([
      expect.objectContaining({ code: '00300', source: 'curated', group: 'water-quality' }),
    ]);
  });

  it('caps at 25 and reports the full total when a query matches more', async () => {
    http.route(...catalogRoutes());
    const { structured, text } = await list({ query: 'suspended sediment' });

    expect(structured.parameters).toHaveLength(25);
    expect(structured.total).toBe(46);
    expect(structured.truncated).toBe(true);
    expect(structured.note).toContain('25 of 46');
    expect(text).toContain(structured.note ?? '(missing note)');
  });

  it('returns exactly the matches, untruncated, when they fit the cap', async () => {
    http.route(...catalogRoutes());
    const { structured } = await list({ query: 'groundwater level' });
    expect(structured).toMatchObject({ total: 2, truncated: false });
    expect(structured.parameters.map((p) => [p.code, p.source])).toEqual([
      ['72150', 'curated'],
      ['62610', 'curated'],
    ]);
    expect(structured.note).toBeUndefined();
  });

  it('returns an empty list with guidance when nothing matches', async () => {
    http.route(...catalogRoutes());
    const { result, structured, text } = await list({ query: 'zzyzx' });

    expect(result.isError).toBeFalsy();
    expect(structured).toMatchObject({ parameters: [], total: 0, truncated: false });
    expect(structured.note).toMatch(/broaden|fewer/i);
    expect(text).toContain('**0 parameter(s) matching "zzyzx"**');
    expect(text).toContain(structured.note ?? '(missing note)');
  });

  it('rejects query combined with a group, naming both inputs', async () => {
    const { result, text } = await list({ query: 'nitrate', group: 'streamflow' });

    expect(result.isError).toBe(true);
    expect(http.calls).toHaveLength(0);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'query_with_group',
          recovery: declaredRecovery(tool.errors, 'query_with_group'),
        },
      },
    });
    expect(text).toContain('query');
    expect(text).toContain('group');
    expect(text).toContain('streamflow');
  });

  it('fetches the catalog once for repeated queries in one process', async () => {
    http.route(...catalogRoutes());
    await list({ query: 'nitrate' });
    await list({ query: 'turbidity' });
    expect(http.calls).toHaveLength(2);
  });

  it('shares one fetch between concurrent first queries', async () => {
    http.route(...catalogRoutes());
    const [a, b] = await Promise.all([list({ query: 'nitrate' }), list({ query: 'discharge' })]);
    expect(a.result.isError).toBeFalsy();
    expect(b.result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(2);
  });

  it('throws a retryable upstream_error on a failed fetch, and fetches again on the next call', async () => {
    http.route({ ...failingCatalogRoute(503, 'Service Unavailable'), once: true });
    const failed = await list({ query: 'nitrate' });

    expect(failed.result.isError).toBe(true);
    expect(failed.result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'upstream_error',
          recovery: declaredRecovery(tool.errors, 'upstream_error'),
        },
      },
    });
    expect(tool.errors?.find((e) => e.reason === 'upstream_error')?.retryable).toBe(true);

    http.route(...catalogRoutes());
    const retried = await list({ query: 'nitrate' });
    expect(retried.result.isError).toBeFalsy();
    expect(retried.structured.total).toBeGreaterThan(0);
  });

  it('never answers a query from the curated table alone when the fetch fails', async () => {
    http.route(failingCatalogRoute(500, 'boom'));
    // "discharge" matches curated 00060, which must not be served on its own.
    const { result } = await list({ query: 'discharge' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_error' } },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"source":"curated"');
  });

  it('accepts a query of up to 200 characters and rejects a longer one at the schema', () => {
    expect(tool.input.parse({ query: 'a'.repeat(200) })).toMatchObject({ query: 'a'.repeat(200) });
    expect(() => tool.input.parse({ query: 'a'.repeat(201) })).toThrow();
  });

  it('declares openWorldHint, since a query reads the live USGS catalog', () => {
    expect(tool.annotations?.openWorldHint).toBe(true);
  });
});

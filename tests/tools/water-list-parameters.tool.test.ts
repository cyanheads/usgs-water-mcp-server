/**
 * @fileoverview Tests for water_list_parameters tool — the curated table, the full-catalog query
 * with limit/offset paging, and a content[] that reads back as structuredContent.
 * @module tests/tools/water-list-parameters.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { waterListParameters } from '@/mcp-server/tools/definitions/water-list-parameters.tool.js';
import { allText, textContent } from '../helpers/content-block.js';
import { declaredRecovery } from '../helpers/error-contract.js';
import {
  catalogRoutes,
  createWaterDataFake,
  failingCatalogRoute,
  jsonResponse,
  ogcPage,
  ogcRoute,
  rateLimitResponse,
  type WaterDataFake,
} from '../helpers/water-data-fake.js';

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
  type Listing = {
    nextOffset?: number;
    note?: string;
    parameters: Entry[];
    total: number;
    truncated: boolean;
  };

  let water: WaterDataFake;
  /**
   * The tool from a freshly loaded module graph, so every test starts with an empty catalog cache
   * and an open rate-limit gate.
   */
  let tool: typeof waterListParameters;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('USGS_API_KEY', undefined);
    ({ waterListParameters: tool } = await import(
      '@/mcp-server/tools/definitions/water-list-parameters.tool.js'
    ));
    water = createWaterDataFake();
    water.install();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    water.restore();
  });

  /** Four failing first-page answers — one per attempt the request core makes — then nothing. */
  function failEveryAttempt(status: number, body: string) {
    return Array.from({ length: 4 }, () => ({ ...failingCatalogRoute(status, body), once: true }));
  }

  /** Run a call whose retries wait on a fake clock through their backoffs. */
  async function listThroughRetries(input: Record<string, unknown>) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const pending = list(input);
    await vi.advanceTimersByTimeAsync(10_000);
    const outcome = await pending;
    vi.useRealTimers();
    return outcome;
  }

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
      expect(water.requests).toHaveLength(0);
      expect(structured.truncated).toBe(false);
      expect(structured.parameters.every((p) => p.source === 'curated')).toBe(true);
    },
  );

  it('returns catalog entries with descriptions, counting every match', async () => {
    water.route(...catalogRoutes());
    const { result, structured, text } = await list({ query: 'turbidity' });

    expect(result.isError).toBeFalsy();
    // Both captured pages were read: the first page's next link was followed.
    expect(water.requests).toHaveLength(2);
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
    water.route(...catalogRoutes());
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
    water.route(...catalogRoutes());
    const { structured } = await list({ query: 'pH' });
    expect(structured.parameters[0]).toMatchObject({ code: '00400', source: 'curated' });
  });

  it('ranks name matches ahead of description-only matches, each by code', async () => {
    water.route(...catalogRoutes());
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
    water.route(...catalogRoutes());
    // "itrate" sits inside "nitrate" but starts no word.
    const { structured } = await list({ query: 'itrate' });
    expect(structured.total).toBe(0);
  });

  it('returns the catalog record for a bare 5-digit code', async () => {
    water.route(...catalogRoutes());
    const { structured } = await list({ query: '63680' });
    expect(structured.total).toBe(1);
    expect(structured.parameters).toEqual([
      expect.objectContaining({ code: '63680', source: 'usgs-catalog', unit: 'FNU' }),
    ]);
    expect(structured.parameters[0]?.description).toContain('formazin nephelometric units');
  });

  it('returns the curated entry for a bare curated code', async () => {
    water.route(...catalogRoutes());
    const { structured } = await list({ query: '00300' });
    expect(structured.parameters).toEqual([
      expect.objectContaining({ code: '00300', source: 'curated', group: 'water-quality' }),
    ]);
  });

  it('returns the default 25 and reports the full total when a query matches more', async () => {
    water.route(...catalogRoutes());
    const { structured, text } = await list({ query: 'suspended sediment' });

    expect(structured.parameters).toHaveLength(25);
    expect(structured.total).toBe(46);
    expect(structured.truncated).toBe(true);
    expect(structured.note).toContain('25 of 46');
    expect(text).toContain(structured.note ?? '(missing note)');
  });

  it('returns exactly the matches, untruncated, when they fit the default page', async () => {
    water.route(...catalogRoutes());
    const { structured } = await list({ query: 'groundwater level' });
    expect(structured).toMatchObject({ total: 2, truncated: false });
    expect(structured.parameters.map((p) => [p.code, p.source])).toEqual([
      ['72150', 'curated'],
      ['62610', 'curated'],
    ]);
    expect(structured.note).toBeUndefined();
  });

  it('returns an empty list with guidance when nothing matches', async () => {
    water.route(...catalogRoutes());
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
    expect(water.requests).toHaveLength(0);
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
    water.route(...catalogRoutes());
    await list({ query: 'nitrate' });
    await list({ query: 'turbidity' });
    expect(water.requests).toHaveLength(2);
  });

  it('shares one fetch between concurrent first queries', async () => {
    water.route(...catalogRoutes());
    const [a, b] = await Promise.all([list({ query: 'nitrate' }), list({ query: 'discharge' })]);
    expect(a.result.isError).toBeFalsy();
    expect(b.result.isError).toBeFalsy();
    expect(water.requests).toHaveLength(2);
  });

  it('throws a retryable upstream_error on a failed fetch, and fetches again on the next call', async () => {
    water.route(...failEveryAttempt(503, 'Service Unavailable'));
    const failed = await listThroughRetries({ query: 'nitrate' });

    expect(failed.result.isError).toBe(true);
    expect(water.requests).toHaveLength(4);
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

    water.route(...catalogRoutes());
    const retried = await list({ query: 'nitrate' });
    expect(retried.result.isError).toBeFalsy();
    expect(retried.structured.total).toBeGreaterThan(0);
  });

  it('never answers a query from the curated table alone when the fetch fails', async () => {
    water.route(...failEveryAttempt(500, 'boom'));
    // "discharge" matches curated 00060, which must not be served on its own.
    const { result } = await listThroughRetries({ query: 'discharge' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'upstream_error' } },
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"source":"curated"');
  });

  it('reports a rate limit as RateLimited with its wait, not as upstream_error', async () => {
    water.route(ogcRoute('parameter-codes', () => rateLimitResponse(1800)));
    const { result, text } = await list({ query: 'nitrate' });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'rate_limited', retryAfter: 1800 },
      },
    });
    expect(text).toContain('retry after 1800');
    expect(text).toContain('USGS_API_KEY');
    expect(JSON.stringify(result.structuredContent)).not.toContain('"source":"curated"');
    expect(water.requests).toHaveLength(1);
  });

  it('accepts a query of up to 200 characters and rejects a longer one at the schema', () => {
    expect(tool.input.parse({ query: 'a'.repeat(200) })).toMatchObject({ query: 'a'.repeat(200) });
    expect(() => tool.input.parse({ query: 'a'.repeat(201) })).toThrow();
  });

  it('declares openWorldHint, since a query reads the live USGS catalog', () => {
    expect(tool.annotations?.openWorldHint).toBe(true);
  });

  describe('limit / offset paging (#60)', () => {
    it('returns the first 25 of 38 turbidity matches with nextOffset 25, then the other 13 at offset 25', async () => {
      water.route(...catalogRoutes());
      const first = await list({ query: 'turbidity' });
      expect(first.structured).toMatchObject({ total: 38, truncated: true, nextOffset: 25 });
      expect(first.structured.parameters).toHaveLength(25);
      expect(first.structured.note).toBe(
        'Showing entries 1 to 25 of 38. Pass nextOffset (25) as offset for the next page.',
      );
      expect(first.text).toContain(
        '**25 of 38 parameter(s) matching "turbidity"** *(truncated; next page at offset 25)*',
      );
      expect(first.text).toContain(first.structured.note ?? '(missing note)');

      const second = await list({ query: 'turbidity', offset: 25 });
      expect(second.structured).toMatchObject({ total: 38, truncated: false });
      expect(second.structured).not.toHaveProperty('nextOffset');
      expect(second.structured.parameters).toHaveLength(13);
      expect(second.structured.note).toBe('Showing entries 26 to 38 of 38.');
      expect(second.text).toContain('**13 of 38 parameter(s) matching "turbidity"**');
      expect(second.text).not.toContain('truncated');
      expect(second.text).not.toContain('next page');
      expect(second.text).toContain(second.structured.note ?? '(missing note)');

      const codes = [...first.structured.parameters, ...second.structured.parameters].map(
        (p) => p.code,
      );
      expect(new Set(codes).size).toBe(38);
      // Both pages read the one cached catalog: two pages fetched once, by the first call.
      expect(water.requests).toHaveLength(2);
    });

    it('walks nextOffset to the end, returning every match once in single-call order', async () => {
      water.route(...catalogRoutes());
      const whole = await list({ query: 'turbidity', limit: 4000 });
      expect(whole.structured).toMatchObject({ total: 38, truncated: false });
      expect(whole.structured).not.toHaveProperty('nextOffset');

      const walked: Entry[] = [];
      const offsets: number[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        /**
         * 38 matches at 10 a page end on page 4: a fifth page means nextOffset never ran out, and
         * failing here keeps a stuck continuation from spinning the walk forever.
         */
        expect(offsets.length).toBeLessThan(Math.ceil(38 / 10));
        offsets.push(offset);
        const page = await list({ query: 'turbidity', limit: 10, offset });
        expect(page.structured.truncated).toBe(page.structured.nextOffset !== undefined);
        // Each continuation moves past the page it continues; the last page carries none.
        expect(page.structured.nextOffset ?? Number.POSITIVE_INFINITY).toBeGreaterThan(offset);
        walked.push(...page.structured.parameters);
        offset = page.structured.nextOffset;
      }
      expect(offsets).toEqual([0, 10, 20, 30]);
      expect(walked).toEqual(whole.structured.parameters);
    });

    it('returns an empty page, the true total, and the valid offset range for an offset at or past the end', async () => {
      water.route(...catalogRoutes());
      for (const offset of [38, 500]) {
        const { result, structured, text } = await list({ query: 'turbidity', offset });
        expect(result.isError).toBeFalsy();
        expect(structured).toMatchObject({ parameters: [], total: 38, truncated: false });
        expect(structured).not.toHaveProperty('nextOffset');
        expect(structured.note).toBe(
          `No entries in this window: offset ${offset} is at or past the 38 matching entries. Valid offset range is 0 to 37.`,
        );
        expect(text).toContain('**0 of 38 parameter(s) matching "turbidity"**');
        expect(text).toContain(structured.note ?? '(missing note)');
      }
    });

    it('keeps the no-match note for a query that matches nothing, whatever the offset', async () => {
      water.route(...catalogRoutes());
      const { structured } = await list({ query: 'zzyzx', offset: 5 });
      expect(structured).toMatchObject({ parameters: [], total: 0, truncated: false });
      expect(structured.note).toMatch(/^No USGS parameter code matched "zzyzx"/);
    });

    it('windows the curated list the same way when query is omitted, with no network call', async () => {
      const curatedCodes = (await list({})).structured.parameters.map((p) => p.code);
      expect(curatedCodes).toHaveLength(11);

      const first = await list({ limit: 5 });
      expect(first.structured).toMatchObject({ total: 11, truncated: true, nextOffset: 5 });
      expect(first.structured.parameters.map((p) => p.code)).toEqual(curatedCodes.slice(0, 5));
      expect(first.text).toContain('**5 of 11 parameter(s)** *(truncated; next page at offset 5)*');

      const last = await list({ limit: 5, offset: 10 });
      expect(last.structured).toMatchObject({ total: 11, truncated: false });
      expect(last.structured.parameters.map((p) => p.code)).toEqual(curatedCodes.slice(10));

      const past = await list({ offset: 11 });
      expect(past.structured).toMatchObject({ parameters: [], total: 11, truncated: false });
      expect(past.structured.note).toContain('Valid offset range is 0 to 10.');

      const grouped = await list({ group: 'groundwater', offset: 1, limit: 2 });
      expect(grouped.structured.parameters.map((p) => p.code)).toEqual(['72020', '72150']);
      expect(grouped.structured).toMatchObject({ total: 4, truncated: true, nextOffset: 3 });
      expect(water.requests).toHaveLength(0);
    });

    it('still rejects query with a group as query_with_group when paging inputs ride along', async () => {
      const { result } = await list({
        query: 'nitrate',
        group: 'streamflow',
        limit: 10,
        offset: 5,
      });
      expect(result.structuredContent).toMatchObject({
        error: { data: { reason: 'query_with_group' } },
      });
      expect(water.requests).toHaveLength(0);
    });

    it('defaults limit to 25 and offset to 0, and rejects limit outside 1–4,000 or a negative offset', () => {
      expect(tool.input.parse({})).toMatchObject({ limit: 25, offset: 0 });
      expect(tool.input.parse({ limit: 4000, offset: 19_696 })).toMatchObject({
        limit: 4000,
        offset: 19_696,
      });
      for (const input of [
        { limit: 0 },
        { limit: 4001 },
        { limit: 2.5 },
        { offset: -1 },
        { offset: 1.5 },
      ]) {
        expect(tool.input.safeParse(input).success, JSON.stringify(input)).toBe(false);
      }
    });

    it('states the defaults and bounds in the input, tool, and output descriptions', () => {
      const { limit, offset } = tool.input.shape;
      const { parameters, truncated, nextOffset } = tool.output.shape;
      for (const description of [
        limit.description,
        offset.description,
        tool.description,
        parameters.description,
        truncated.description,
        nextOffset.description,
      ]) {
        expect(description).toMatch(/default 25/i);
        expect(description).toContain('4,000');
        expect(description).toMatch(/default 0/i);
      }
    });

    it('names the catalog size as about 19,700 codes', () => {
      expect(tool.description).toContain('~19,700');
      expect(tool.description).not.toContain('19,600');
    });
  });

  describe('content[] reads back as structuredContent', () => {
    /** A catalog record whose every text field carries Markdown syntax and a line break. */
    const ODD = {
      code: '99999',
      name: 'Odd *name* _x_ a|b [link](u) `tick` <b>bold</b>',
      unit: 'mg/L | <as N> *',
      description: 'Line one *a* _b_ | [c] `d` <e>\nline two ~s~',
    };
    const oddCatalog = () =>
      ogcRoute('parameter-codes', () =>
        jsonResponse(
          ogcPage([
            {
              type: 'Feature',
              id: ODD.code,
              properties: {
                parameter_name: ODD.name,
                unit_of_measure: ODD.unit,
                parameter_description: ODD.description,
              },
            },
          ]),
        ),
      );

    it('reads a catalog entry and a query holding * _ | [ ` < and a line break back exactly', async () => {
      water.route(oddCatalog());
      const query = 'odd* _name_ |[`<\ntick';
      const { result, structured, text } = await list({ query });

      expect(result.isError).toBeFalsy();
      expect(structured.parameters).toEqual([{ ...ODD, source: 'usgs-catalog' }]);
      const read = readListing(text);
      expect(read.header).toBe(`1 parameter(s) matching "${query}"`);
      expect(read.entries).toEqual(structured.parameters);
      expect(read.note).toBeUndefined();
    });

    it('reads a query that matches nothing back inside its note', async () => {
      water.route(oddCatalog());
      const query = 'zz* _q_ |[`<\nyy';
      const { structured, text } = await list({ query });

      expect(structured).toMatchObject({ parameters: [], total: 0 });
      expect(structured.note).toContain(`matched "${query}"`);
      const read = readListing(text);
      expect(read.header).toBe(`0 parameter(s) matching "${query}"`);
      expect(read.note).toBe(structured.note);
    });

    it('reads curated entries, their group, and a paging note back exactly', async () => {
      const { structured, text } = await list({ limit: 2, offset: 1 });
      const read = readListing(text);
      expect(read.header).toBe('2 of 11 parameter(s)');
      expect(read.entries).toEqual(structured.parameters);
      expect(read.entries.map((e) => e.group)).toEqual(['streamflow', 'temperature']);
      expect(read.note).toBe(structured.note);
    });
  });
});

/** One listed entry as the reader below recovers it from content[]. */
interface ReadEntry {
  code: string;
  description?: string;
  group?: string;
  name: string;
  source: string;
  unit: string;
}

/** An escape-aware run: a backslash with the character after it, or any other character. */
const RUN = String.raw`(?:\\[\s\S]|[^\\])`;

/** The bold count line, then the parenthesized paging marks when present. */
const HEADER = new RegExp(String.raw`^\*\*(${RUN}*?)\*\*(?: \*\([^)]*\)\*)?$`);

/** `` - `code` — **name** (unit) [group] · source — description ``, group and description optional. */
const LIST_ITEM = new RegExp(
  String.raw`^- \x60([^\x60]*)\x60 — \*\*(${RUN}*?)\*\* \((${RUN}*)\)(?: \[(${RUN}*?)\])? · (curated|usgs-catalog)(?: — (${RUN}*))?$`,
);

/** The note, one emphasized paragraph. */
const NOTE = new RegExp(String.raw`^\*(${RUN}*)\*$`);

/**
 * Read inline Markdown back into the value it encodes, implementing the part of CommonMark the
 * encoder relies on: a backslash before ASCII punctuation is that character, a backslash before a
 * line break is a hard break, and a numeric character reference is its code point. Anything that
 * would parse as markup — an unescaped `*`, `` ` ``, `[`, `]`, `~`, an `_` not inside a word, `<`
 * opening a tag or autolink, `&` opening a named entity — fails the read, as does an unescaped `|`,
 * which the encoder always escapes: this reader cannot parse it, and the encoder must never emit it.
 */
function readInline(encoded: string): string {
  const bare = encoded.replace(/\\[!-/:-@[-`{-~\n]/g, ' ');
  const live = bare.match(
    /[*`[\]~|]|(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])|<[A-Za-z/!?]|&[A-Za-z][A-Za-z0-9]{1,31};/u,
  );
  if (live) throw new Error(`${JSON.stringify(encoded)} holds live markup: ${live[0]}`);
  return encoded.replace(
    /\\([!-/:-@[-`{-~\n])|&#(\d{1,7});|&#[xX]([0-9a-fA-F]{1,6});/g,
    (_m, escaped?: string, dec?: string, hex?: string) =>
      escaped ?? String.fromCodePoint(dec ? Number(dec) : Number.parseInt(hex ?? '', 16)),
  );
}

/**
 * Read water_list_parameters' content[] back into values: the header's count line, each list item
 * as an entry, and the note. Blocks are separated by a blank line, and items by a line starting
 * `- `, which no encoded value can start a line with. A code span reads as written.
 */
function readListing(text: string): { entries: ReadEntry[]; header: string; note?: string } {
  const [headerBlock = '', ...blocks] = text.split('\n\n').map((b) => b.replace(/^\n+/, ''));
  const header = HEADER.exec(headerBlock)?.[1];
  if (header === undefined) throw new Error(`Unreadable header: ${JSON.stringify(headerBlock)}`);
  const entries: ReadEntry[] = [];
  let note: string | undefined;
  for (const block of blocks) {
    if (block.startsWith('- ')) {
      for (const item of block.split(/\n(?=- )/)) {
        const m = LIST_ITEM.exec(item);
        if (!m) throw new Error(`Unreadable list item: ${JSON.stringify(item)}`);
        const [, code = '', name = '', unit = '', group, source = '', description] = m;
        entries.push({
          code,
          name: readInline(name),
          unit: readInline(unit),
          ...(group === undefined ? {} : { group: readInline(group) }),
          source,
          ...(description === undefined ? {} : { description: readInline(description) }),
        });
      }
    } else {
      const body = NOTE.exec(block)?.[1];
      if (body === undefined) throw new Error(`Unreadable block: ${JSON.stringify(block)}`);
      note = readInline(body);
    }
  }
  return { header: readInline(header), entries, ...(note === undefined ? {} : { note }) };
}

/**
 * @fileoverview Site-catalog input characterization and OGC integration contracts.
 * @module tests/services/site-data-catalog.test
 */
import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waterGetSiteDataCatalog as tool } from '@/mcp-server/tools/definitions/water-get-site-data-catalog.tool.js';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/nwis/input-schemas.js';
import type { SiteDataCatalog } from '@/services/waterdata/site-data-catalog.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL(`../fixtures/waterdata/site-${name}.json`, import.meta.url), 'utf8'),
  );
const location = fixture('location-known');
const page1 = fixture('page-one');
const page2 = fixture('page-two');
const empty = { features: [], links: [] };
const input = { site: '01646500', limit: 1 };
const text = (content: readonly { type: string; text?: string }[]) =>
  content.map((block) => block.text ?? '').join('\n');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Run the real fetch, retry, and parsing seam against bounded captured responses. */
function serve(metadata: (url: URL) => unknown, identity: unknown = location) {
  const fetch = vi.fn(async (url: string) => {
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://api.waterdata.usgs.gov');
    return new Response(
      JSON.stringify(
        parsed.pathname.includes('monitoring-locations') ? identity : metadata(parsed),
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** Run the full contract and require every structured field to appear in the rendered page. */
async function success(args: {
  site: string;
  parameterCd?: string;
  seriesType?: 'daily' | 'instantaneous' | '';
  limit?: number;
  cursor?: string;
}) {
  const result = await runToolContract(tool, args);
  expect(result.isError, text(result.content)).toBeFalsy();
  const formatted = text(result.content);
  for (const key of ['siteNumber', 'siteName', 'nextCursor'])
    expect(formatted).toContain(`**${key}:**`);
  for (const row of (result.structuredContent as SiteDataCatalog).series) {
    for (const key of Object.keys(row)) expect(formatted).toContain(`**${key}:**`);
  }
  return result.structuredContent as SiteDataCatalog;
}

describe('site-series catalog', () => {
  it('retains captured sensors, statistics, UTC bounds and sparse values on both surfaces', async () => {
    serve(() => ({ features: [...page1.features, ...page2.features], links: [] }));
    const result = await success({ site: '01646500' });
    expect(result.series).toHaveLength(2);
    expect(result.series[0]).toMatchObject({
      timeSeriesId: '063be3d188fc43859c6436f021a9a31f',
      parameterCd: '63680',
      statCd: '00003',
      beginDate: '2013-11-23T05:00:00+00:00',
      endDate: '2019-05-26T04:00:00+00:00',
      seriesType: 'daily',
      sublocation: 'From multiparameter sonde',
    });
    expect(result.series[1]).toMatchObject({
      statCd: '00002',
      sublocation: 'SUNA',
      webDescription: null,
    });
    const rendered = text(tool.format!(result));
    expect(rendered).toContain('**timeSeriesId:** 063be3d188fc43859c6436f021a9a31f');
    expect(rendered).toContain('**beginDate:** 2013-11-23T05:00:00+00:00');
    expect(rendered).toContain('**endDate:** 2019-05-26T04:00:00+00:00');
    expect(rendered).toContain('**sublocation:** SUNA');
    expect(rendered).toContain('**webDescription:** `null`');
  });

  it('escapes markup and preserves line breaks, tabs, empty strings and null distinctly', async () => {
    serve(() => ({
      features: [
        {
          id: 'id_*[]',
          properties: {
            parameter_code: '00060',
            parameter_name: '**bold** [x] <tag>&',
            sublocation_identifier: 'line1\nline2\r\nlast\ttab',
            unit_of_measure: '',
            web_description: ' trailing ',
          },
        },
      ],
    }));
    const data = await success(input);
    const rendered = text(tool.format!(data));
    expect(data.series[0]).toMatchObject({
      parameterName: '**bold** [x] <tag>&',
      sublocation: 'line1\nline2\r\nlast\ttab',
      unit: '',
      statCd: null,
    });
    expect(rendered).toContain('**parameterName:** \\*\\*bold\\*\\* \\[x\\] &lt;tag&gt;&amp;');
    expect(rendered).toContain('**sublocation:** line1&#10;line2&#13;&#10;last&#9;tab');
    expect(rendered).toContain('**unit:** `""`');
    expect(rendered).toContain('**statCd:** `null`');
    expect(rendered).toContain('**webDescription:** &#32;trailing&#32;');
  });

  it('rejects noncanonical base64 cursors before I/O', async () => {
    const fetch = serve(() => page1);
    const first = await success(input);
    fetch.mockClear();
    const result = await runToolContract(tool, { ...input, cursor: `${first.nextCursor}!` });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_cursor' } },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('continues offset-based filtered pages without losing filters, including past the end', async () => {
    serve((url) => {
      expect(url.searchParams.get('parameter_code')).toBe('00060');
      expect(url.searchParams.get('computation_period_identifier')).toBe('Daily');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return offset >= 2
        ? empty
        : {
            features: [{ ...page1.features[0], id: String(offset) }],
            links: [
              {
                rel: 'next',
                href: `https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items?offset=${offset + 1}`,
              },
            ],
          };
    });
    const args = { ...input, parameterCd: '00060', seriesType: 'daily' as const };
    let page = await success(args);
    for (let offset = 1; offset <= 2; offset++) {
      if (page.nextCursor === null) throw new Error('Expected continuation');
      page = await success({ ...args, cursor: page.nextCursor });
      expect(page.series.map((row) => row.timeSeriesId)).toEqual(
        offset < 2 ? [String(offset)] : [],
      );
    }
    expect(page.nextCursor).toBeNull();
  });

  it('resumes at the absolute position when a cursor page switches to offset paging', async () => {
    serve((url) => {
      const offset = url.searchParams.get('offset');
      expect(url.searchParams.has('cursor')).toBe(false);
      if (offset === '2') return empty;
      return offset === '1'
        ? {
            features: page2.features,
            links: [
              {
                rel: 'next',
                href: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items?offset=1',
              },
            ],
          }
        : page1;
    });
    const first = await success(input);
    if (!first.nextCursor) throw new Error('Expected continuation');
    const second = await success({ ...input, cursor: first.nextCursor });
    if (!second.nextCursor) throw new Error('Expected continuation');
    expect(await success({ ...input, cursor: second.nextCursor })).toMatchObject({
      series: [],
      nextCursor: null,
    });
  });

  it('keeps filters through two continuations and an empty final page', async () => {
    const fetch = serve((url) => {
      expect(url.searchParams.get('monitoring_location_id')).toBe('USGS-01646500');
      expect(url.searchParams.get('parameter_code')).toBe('63680');
      expect(url.searchParams.get('computation_period_identifier')).toBe('Daily');
      expect(url.searchParams.get('limit')).toBe('1');
      const offset = Number(url.searchParams.get('offset') ?? 0);
      return offset === 0 ? page1 : offset === 1 ? page2 : empty;
    });
    const args = { ...input, parameterCd: '63680', seriesType: 'daily' as const };
    const first = await success(args);
    expect(first.nextCursor).toBeTypeOf('string');
    if (first.nextCursor === null) throw new Error('Expected first continuation');
    const second = await success({ ...args, cursor: first.nextCursor });
    expect(second.series[0]?.timeSeriesId).not.toBe(first.series[0]?.timeSeriesId);
    if (second.nextCursor === null) throw new Error('Expected second continuation');
    const third = await success({ ...args, cursor: second.nextCursor });
    expect(third).toMatchObject({ series: [], nextCursor: null });
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it.each(['site', 'parameterCd', 'seriesType', 'limit'])(
    'rejects cursor binding mismatch in %s before I/O',
    async (key) => {
      const fetch = serve(() => page1);
      const first = await success(input);
      if (first.nextCursor === null) throw new Error('Expected continuation');
      fetch.mockClear();
      const changes = { site: '01648000', parameterCd: '00060', seriesType: 'daily', limit: 2 };
      const result = await runToolContract(tool, {
        ...input,
        cursor: first.nextCursor,
        [key]: changes[key as keyof typeof changes],
      });
      expect(result.structuredContent).toMatchObject({
        error: {
          data: {
            reason: 'invalid_cursor',
            recovery: { hint: expect.stringContaining('original filters') },
          },
        },
      });
      expect(text(result.content)).toContain('original filters');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed cursors and malformed IDs before I/O', async () => {
    const fetch = serve(() => empty);
    for (const args of [
      { ...input, cursor: 'not-json' },
      { ...input, site: '../x' },
      { ...input, parameterCd: '60' },
      { ...input, limit: 1001 },
      { ...input, limit: 0 },
    ]) {
      expect((await runToolContract(tool, args)).isError).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns no rows for a known site with no matching parameter and treats blanks as omitted', async () => {
    const fetch = serve(() => empty);
    expect(await success({ ...input, parameterCd: '99999' })).toMatchObject({
      series: [],
      nextCursor: null,
    });
    expect(await success({ ...input, parameterCd: '', seriesType: '', cursor: '' })).toMatchObject({
      series: [],
    });
    expect(new URL(fetch.mock.calls.at(-1)![0]).searchParams.has('parameter_code')).toBe(false);
  });

  it('preserves a sparse site and maps only the precise callable periods', async () => {
    const sparse = fixture('ogc-sparse');
    serve(() => sparse, { properties: { monitoring_location_number: '01648000' } });
    const result = await success({ site: '01648000', limit: 1000 });
    expect(result.siteName).toBeNull();
    expect(result.series).toHaveLength(6);
    expect(result.series.some((row) => row.statCd === null)).toBe(true);
    expect(result.series.some((row) => row.sublocation === null)).toBe(true);
    const periods = ['Daily', 'Points', 'Points', 'Water Year', undefined];
    serve(() => ({
      features: periods.map((period, i) => ({
        id: String(i),
        properties: {
          parameter_code: '00060',
          computation_period_identifier: period,
          computation_identifier: i === 1 ? 'Instantaneous' : 'Mean',
        },
      })),
    }));
    const mapped = await success(input);
    expect(mapped.series.map((row) => row.seriesType)).toEqual([
      'daily',
      'instantaneous',
      null,
      null,
      null,
    ]);
    expect(mapped.series[4]?.beginDate).toBeNull();
  });

  it('sends both precise instantaneous filters', async () => {
    serve((url) => {
      expect(url.searchParams.get('computation_period_identifier')).toBe('Points');
      expect(url.searchParams.get('computation_identifier')).toBe('Instantaneous');
      return empty;
    });
    await success({ ...input, seriesType: 'instantaneous' });
  });

  it('reports unknown locations with recovery on both surfaces', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    const result = await runToolContract(tool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.NotFound, data: { reason: 'not_found' } },
    });
    expect(text(result.content)).toContain('water_find_sites');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries malformed metadata before returning the recovered page', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    serve(() => (++attempt === 1 ? { features: 'truncated' } : empty));
    const pending = runToolContract(tool, input);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(attempt).toBe(2);
  });

  it.each(['malformed', '503', 'foreign-continuation'])(
    'reports %s upstream failures with recovery on both surfaces',
    async (mode) => {
      vi.useFakeTimers();
      const fetch = vi.fn(async (url: string) => {
        if (url.includes('monitoring-locations')) return new Response(JSON.stringify(location));
        if (mode === '503') return new Response('Unavailable', { status: 503 });
        return new Response(
          JSON.stringify(
            mode === 'malformed'
              ? { features: null }
              : {
                  features: page1.features,
                  links: [{ rel: 'next', href: 'https://example.com/?cursor=secret' }],
                },
          ),
        );
      });
      vi.stubGlobal('fetch', fetch);
      const pending = runToolContract(tool, input);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'upstream_error',
            recovery: { hint: expect.stringContaining('short backoff') },
          },
        },
      });
      expect(text(result.content)).toContain('short backoff');
      expect(
        fetch.mock.calls.every(([url]) => url.startsWith('https://api.waterdata.usgs.gov/')),
      ).toBe(true);
    },
  );

  it.each([false, true])(
    'bounds the combined identity and metadata deadline (body=%s)',
    async (body) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (url.includes('monitoring-locations')) {
          await new Promise((resolve) => setTimeout(resolve, 25_000));
          return new Response(JSON.stringify(location));
        }
        const signal = options!.signal!;
        if (body)
          return new Response(
            new ReadableStream({
              start(controller) {
                signal.addEventListener('abort', () => controller.error(signal.reason), {
                  once: true,
                });
              },
            }),
          );
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      });
      vi.stubGlobal('fetch', fetch);
      const pending = runToolContract(tool, input);
      await vi.advanceTimersByTimeAsync(45_001);
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          data: { reason: 'upstream_timeout', deadlineMs: 45_000 },
        },
      });
      expect(text(result.content)).toContain('same filters and cursor');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['identity', 'metadata', 'backoff'])(
    'preserves caller cancellation during %s',
    async (stage) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const controller = new AbortController();
      const fetch = vi.fn(async (url: string, options?: RequestInit) => {
        if (stage !== 'identity' && url.includes('monitoring-locations'))
          return new Response(JSON.stringify(location));
        if (stage === 'backoff') return new Response('Unavailable', { status: 503 });
        const signal = options!.signal!;
        return new Promise<Response>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      });
      vi.stubGlobal('fetch', fetch);
      const pending = runToolContract(tool, input, { context: { signal: controller.signal } });
      await vi.advanceTimersByTimeAsync(0);
      const calls = fetch.mock.calls.length;
      controller.abort(new DOMException('Caller cancelled catalog', 'AbortError'));
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.RequestCancelled },
      });
      expect(text(result.content)).toMatch(/aborted|cancelled/i);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetch).toHaveBeenCalledTimes(calls);
    },
  );

  it.each([400, 422])(
    'maps an upstream cursor rejection (%s) to invalid_cursor',
    async (status) => {
      serve(() => page1);
      const first = await success(input);
      if (first.nextCursor === null) throw new Error('Expected continuation');
      const fetch = vi.fn(async (url: string) =>
        url.includes('monitoring-locations')
          ? new Response(JSON.stringify(location))
          : new Response('Invalid cursor', { status }),
      );
      vi.stubGlobal('fetch', fetch);
      const result = await runToolContract(tool, { ...input, cursor: first.nextCursor });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_cursor' } },
      });
      expect(text(result.content)).toContain('Omit cursor to restart');
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it('never treats a metadata endpoint404 as an unknown monitoring location', async () => {
    serve(() => empty);
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('monitoring-locations')
        ? new Response(JSON.stringify(location))
        : new Response('{}', { status: 404 }),
    );
    const result = await runToolContract(tool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ServiceUnavailable, data: { reason: 'upstream_error' } },
    });
    expect(text(result.content)).toContain('short backoff');
  });
});

describe('catalog identifier boundaries', () => {
  it('preserves zero-padded identifiers and rejects malformed inputs', () => {
    expect(SiteNumberSchema.parse('01646500')).toBe('01646500');
    expect(ParameterCdSchema.parse('00060')).toBe('00060');
    expect(SiteNumberSchema.safeParse('USGS-01646500').success).toBe(false);
    expect(ParameterCdSchema.safeParse('60').success).toBe(false);
  });
});

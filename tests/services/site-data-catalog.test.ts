/**
 * @fileoverview Site-catalog input characterization and OGC integration contracts, run through the
 * tool at the fetch seam: the Water Data fake serves the site-resolver query and the
 * `time-series-metadata` pages, so resolution, paging, retries, the call deadline, and error
 * classification all execute. Each test loads the tool fresh, so the resolver cache and the host
 * cooldown gate start empty.
 * @module tests/services/site-data-catalog.test
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParameterCdSchema, SiteNumberSchema } from '@/services/waterdata/input-schemas.js';
import type { SiteDataCatalog } from '@/services/waterdata/site-data-catalog.js';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  rateLimitResponse,
  stalled,
  stalledBody,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type CatalogTool =
  typeof import('@/mcp-server/tools/definitions/water-get-site-data-catalog.tool.js')['waterGetSiteDataCatalog'];

const fixture = (name: string) => JSON.parse(waterDataFixture(`site-${name}.json`));
const page1 = fixture('page-one');
const page2 = fixture('page-two');
const empty = { features: [], links: [] };
const input = { site: '01646500', limit: 1 };
const METADATA_PATH = '/ogcapi/v1/collections/time-series-metadata/items';
const text = (content: readonly { type: string; text?: string }[]) =>
  content.map((block) => block.text ?? '').join('\n');

/** Resolver answers by number: the live captures, plus a sparse site with no name. */
const byNumber = JSON.parse(waterDataFixture('monitoring-locations-by-number.json')).features as {
  id: string;
}[];
const LOCATIONS = new Map<string, unknown>([
  ['01646500', byNumber.find((f) => f.id === 'USGS-01646500')],
  ['364643089212301', byNumber.find((f) => f.id === 'MO005-364643089212301')],
  [
    '01648000',
    {
      type: 'Feature',
      id: 'USGS-01648000',
      properties: {
        monitoring_location_number: '01648000',
        monitoring_location_name: null,
        agency_code: 'USGS',
        time_zone_abbreviation: 'EST',
        uses_daylight_savings: 'Y',
      },
      geometry: null,
    },
  ],
]);

let tool: CatalogTool;
let water: WaterDataFake;

async function loadTool() {
  vi.resetModules();
  ({ waterGetSiteDataCatalog: tool } = await import(
    '@/mcp-server/tools/definitions/water-get-site-data-catalog.tool.js'
  ));
}

beforeEach(async () => {
  vi.stubEnv('USGS_API_KEY', undefined);
  await loadTool();
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

function useFakeClock() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
}

function locationResponse(request: Request) {
  const numbers =
    new URL(request.url).searchParams.get('monitoring_location_number')?.split(',') ?? [];
  return jsonResponse(
    ogcPage(numbers.flatMap((n) => (LOCATIONS.has(n) ? [LOCATIONS.get(n)] : []))),
  );
}

const locationRoute = () => ogcRoute('monitoring-locations', locationResponse);

/** Serve the resolver and every metadata page from `metadata(url)`. */
function serve(metadata: (url: URL) => unknown) {
  water.route(
    locationRoute(),
    ogcRoute('time-series-metadata', (request) => jsonResponse(metadata(new URL(request.url)))),
  );
}

const metadataRequests = () => water.requests.filter((r) => r.url.pathname === METADATA_PATH);

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
    expect(result.siteName).toBe('POTOMAC RIVER NEAR WASH, DC LITTLE FALLS PUMP STA');
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

  it('resolves a site registered under another agency and reads its series by that identifier', async () => {
    water.route(
      ogcRoute('monitoring-locations', new Response('{"code":"NotFound"}', { status: 404 }), {
        item: 'USGS-364643089212301',
      }),
      locationRoute(),
      ogcRoute(
        'time-series-metadata',
        jsonResponse(ogcPage([{ id: 'abc', properties: { parameter_code: '72019' } }])),
        { query: { monitoring_location_id: 'MO005-364643089212301' } },
      ),
    );
    const result = await success({ site: '364643089212301' });
    expect(result).toMatchObject({
      siteNumber: '364643089212301',
      siteName: 'East Prairie',
      series: [{ timeSeriesId: 'abc', parameterCd: '72019' }],
      nextCursor: null,
    });
    expect(water.requests.map((r) => r.url.pathname)).toEqual([
      '/ogcapi/v1/collections/monitoring-locations/items',
      METADATA_PATH,
    ]);
    expect(water.requests[0]?.url.searchParams.get('monitoring_location_number')).toBe(
      '364643089212301',
    );
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
    serve(() => page1);
    const first = await success(input);
    const sent = water.requests.length;
    const result = await runToolContract(tool, { ...input, cursor: `${first.nextCursor}!` });
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'invalid_cursor' } },
    });
    expect(water.requests).toHaveLength(sent);
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

  it('keeps filters through two continuations and an empty final page, resolving the site once', async () => {
    serve((url) => {
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
    // The resolved site is cached: one identity request, then one metadata request per page.
    expect(water.requests).toHaveLength(4);
    expect(metadataRequests()).toHaveLength(3);
  });

  it('continues after the rows a short page delivered, not after its limit', async () => {
    serve((url) =>
      url.searchParams.has('offset')
        ? empty
        : {
            features: [
              { ...page1.features[0], id: 'first' },
              { ...page1.features[0], id: 'second' },
            ],
            links: [
              {
                rel: 'next',
                href: 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/time-series-metadata/items?cursor=c2',
              },
            ],
          },
    );
    const first = await success({ ...input, limit: 3 });
    expect(first.series.map((row) => row.timeSeriesId)).toEqual(['first', 'second']);
    if (first.nextCursor === null) throw new Error('Expected continuation');
    await success({ ...input, limit: 3, cursor: first.nextCursor });
    expect(metadataRequests().map((r) => r.url.searchParams.get('offset'))).toEqual([null, '2']);
  });

  it.each(['site', 'parameterCd', 'seriesType', 'limit'])(
    'rejects cursor binding mismatch in %s before I/O',
    async (key) => {
      serve(() => page1);
      const first = await success(input);
      if (first.nextCursor === null) throw new Error('Expected continuation');
      const sent = water.requests.length;
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
      expect(water.requests).toHaveLength(sent);
    },
  );

  it('rejects malformed cursors and malformed IDs before I/O', async () => {
    serve(() => empty);
    for (const args of [
      { ...input, cursor: 'not-json' },
      { ...input, site: '../x' },
      { ...input, parameterCd: '60' },
      { ...input, limit: 1001 },
      { ...input, limit: 0 },
    ]) {
      expect((await runToolContract(tool, args)).isError).toBe(true);
    }
    expect(water.requests).toHaveLength(0);
  });

  it('returns no rows for a known site with no matching parameter and treats blanks as omitted', async () => {
    serve(() => empty);
    expect(await success({ ...input, parameterCd: '99999' })).toMatchObject({
      series: [],
      nextCursor: null,
    });
    expect(await success({ ...input, parameterCd: '', seriesType: '', cursor: '' })).toMatchObject({
      series: [],
    });
    expect(metadataRequests().at(-1)?.url.searchParams.has('parameter_code')).toBe(false);
  });

  it('preserves a sparse site and maps only the precise callable periods', async () => {
    const sparse = fixture('ogc-sparse');
    const periods = ['Daily', 'Points', 'Points', 'Water Year', undefined];
    serve((url) =>
      url.searchParams.get('monitoring_location_id') === 'USGS-01648000'
        ? sparse
        : {
            features: periods.map((period, i) => ({
              id: String(i),
              properties: {
                parameter_code: '00060',
                computation_period_identifier: period,
                computation_identifier: i === 1 ? 'Instantaneous' : 'Mean',
              },
            })),
          },
    );
    const result = await success({ site: '01648000', limit: 1000 });
    expect(result.siteName).toBeNull();
    expect(result.series).toHaveLength(6);
    expect(result.series.some((row) => row.statCd === null)).toBe(true);
    expect(result.series.some((row) => row.sublocation === null)).toBe(true);
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
    water.route(locationRoute());
    const result = await runToolContract(tool, { ...input, site: '99999999' });
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.NotFound,
        message: 'USGS site 99999999 was not found.',
        data: { reason: 'not_found' },
      },
    });
    expect(text(result.content)).toContain('water_find_sites');
    expect(water.requests).toHaveLength(1);
  });

  it('fails malformed metadata at once instead of re-sending a deterministic body failure', async () => {
    useFakeClock();
    serve(() => ({ features: 'truncated' }));
    const pending = runToolContract(tool, input);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: expect.stringContaining(
          'USGS Water Data OGC API sent an unexpected response (getSiteDataCatalog): features:',
        ),
        data: { reason: 'upstream_error' },
      },
    });
    expect(metadataRequests()).toHaveLength(1);
  });

  it.each(['malformed', '503', 'foreign-continuation'])(
    'reports %s upstream failures with recovery on both surfaces',
    async (mode) => {
      useFakeClock();
      water.route(
        locationRoute(),
        ogcRoute('time-series-metadata', () => {
          if (mode === '503') return new Response('Unavailable', { status: 503 });
          return jsonResponse(
            mode === 'malformed'
              ? { features: null }
              : {
                  features: page1.features,
                  links: [{ rel: 'next', href: 'https://example.com/?cursor=secret' }],
                },
          );
        }),
      );
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
      // Only the 503 can clear on a retry; the other two are deterministic.
      const { data } = (result.structuredContent as { error: { data: { retryable?: boolean } } })
        .error;
      if (mode === '503') expect(data.retryable).not.toBe(false);
      else expect(data.retryable).toBe(false);
      expect(metadataRequests()).toHaveLength(mode === '503' ? 4 : 1);
      expect(water.requests.every((r) => r.url.origin === 'https://api.waterdata.usgs.gov')).toBe(
        true,
      );
    },
  );

  it.each([
    ['headers', stalled],
    ['body', stalledBody],
  ] as const)(
    'bounds the combined identity and metadata deadline (stalled %s)',
    async (_stage, respond) => {
      useFakeClock();
      water.route(
        ogcRoute('monitoring-locations', async (request) => {
          await new Promise((resolve) => setTimeout(resolve, 25_000));
          return locationResponse(request);
        }),
        ogcRoute('time-series-metadata', respond),
      );
      const pending = runToolContract(tool, input);
      await vi.advanceTimersByTimeAsync(45_001);
      const result = await pending;
      expect(result.structuredContent).toMatchObject({
        error: {
          code: JsonRpcErrorCode.Timeout,
          message:
            'getSiteDataCatalog ran out of the 45000 ms budget for this call after 1 attempt.',
          data: { reason: 'upstream_timeout', deadlineMs: 45_000, retryAttempts: 1 },
        },
      });
      expect(text(result.content)).toContain('same filters and cursor');
      expect(water.requests).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    ['identity', 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.'],
    ['metadata', 'fetch GET https://api.waterdata.usgs.gov/…?… was aborted.'],
    ['backoff', 'Caller cancelled catalog'],
  ])('preserves caller cancellation during %s', async (stage, message) => {
    useFakeClock();
    water.route(
      ogcRoute('monitoring-locations', stage === 'identity' ? stalled : locationResponse),
      ogcRoute(
        'time-series-metadata',
        stage === 'backoff' ? new Response('Unavailable', { status: 503 }) : stalled,
      ),
    );
    const controller = new AbortController();
    const pending = runToolContract(tool, input, { context: { signal: controller.signal } });
    await vi.advanceTimersByTimeAsync(0);
    const sent = water.requests.length;
    expect(sent).toBe(stage === 'identity' ? 1 : 2);
    controller.abort(new DOMException('Caller cancelled catalog', 'AbortError'));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled, message },
    });
    expect(text(result.content)).toContain(message);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(water.requests).toHaveLength(sent);
  });

  it.each([400, 422])(
    'maps an upstream cursor rejection (%s) to invalid_cursor',
    async (status) => {
      let rejectWith: number | undefined;
      water.route(
        locationRoute(),
        ogcRoute('time-series-metadata', () =>
          rejectWith === undefined
            ? jsonResponse(page1)
            : new Response('Invalid cursor', { status: rejectWith }),
        ),
      );
      const first = await success(input);
      if (first.nextCursor === null) throw new Error('Expected continuation');
      rejectWith = status;
      const result = await runToolContract(tool, { ...input, cursor: first.nextCursor });
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_cursor' } },
      });
      expect(text(result.content)).toContain('Omit cursor to restart');
      expect(metadataRequests()).toHaveLength(2);
    },
  );

  it('never treats a metadata endpoint 404 as an unknown monitoring location', async () => {
    water.route(
      locationRoute(),
      ogcRoute('time-series-metadata', new Response('{}', { status: 404 })),
    );
    const result = await runToolContract(tool, input);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_error', retryable: false },
      },
    });
    expect(text(result.content)).toContain('short backoff');
    expect(text(result.content)).toContain('(reason upstream_error · not retryable)');
    expect(metadataRequests()).toHaveLength(1);
  });

  it('reports a rate limit with its wait on both surfaces, without retrying', async () => {
    water.route(ogcRoute('monitoring-locations', rateLimitResponse(924)));
    const result = await runToolContract(tool, input);
    expect(result.structuredContent).toMatchObject({
      error: {
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'rate_limited',
          retryAfter: 924,
          recovery: { hint: expect.stringContaining('Wait the retryAfter interval') },
        },
      },
    });
    expect(text(result.content)).toContain('Retry after 924 s.');
    expect(text(result.content)).toContain('Wait the retryAfter interval');
    expect(water.requests).toHaveLength(1);
  });

  it('sends a configured USGS_API_KEY and reports its rejection naming the setting', async () => {
    vi.stubEnv('USGS_API_KEY', 'test-key-catalog');
    await loadTool();
    water.route(
      ogcRoute(
        'monitoring-locations',
        jsonResponse(waterDataFixture('error-403-api-key-invalid.json'), { status: 403 }),
      ),
    );
    const result = await runToolContract(tool, input);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.ConfigurationError, data: { reason: 'api_key_rejected' } },
    });
    expect(text(result.content)).toContain('USGS_API_KEY');
    expect(text(result.content)).not.toContain('test-key-catalog');
    expect(water.requests[0]?.headers.get('x-api-key')).toBe('test-key-catalog');
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

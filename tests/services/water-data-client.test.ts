/**
 * @fileoverview The USGS Water Data request core at the fetch seam: HTTP-failure classification
 * (rate limit, cooldown gate, rejected key, rejected request, other 4xx, unreadable 200, 5xx), the
 * one deadline per call, caller cancellation, the `X-Api-Key` header, and OGC / Statistics paging.
 * Each test loads the client fresh, so the per-host cooldown gate and parsed config start clean.
 * @module tests/services/water-data-client.test
 */

import { inspect } from 'node:util';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, type MockContextLogger } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  rateLimitResponse,
  stalled,
  stalledBody,
  statisticsRoute,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type Client = typeof import('@/services/waterdata/water-data-client.js');
type Errors = typeof import('@/services/waterdata/water-data-errors.js');
type Deadlines = typeof import('@/services/waterdata/request-deadline.js');

const OGC = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections';
const ML_ITEMS = `${OGC}/monitoring-locations/items`;
const KEY = 'test-key-5f0c2e9a1b7d4c3e';
const Feature = z.object({ id: z.string() });
const StatisticsFeature = z.object({
  properties: z.object({ monitoring_location_id: z.string() }),
});

let water: WaterDataFake;
let client: Client;
let errors: Errors;
let deadlines: Deadlines;

/** Load the client graph fresh with `USGS_API_KEY` and `USGS_REQUEST_TIMEOUT_MS` as given. */
async function load(env: { USGS_API_KEY?: string; USGS_REQUEST_TIMEOUT_MS?: string } = {}) {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', env.USGS_API_KEY);
  vi.stubEnv('USGS_REQUEST_TIMEOUT_MS', env.USGS_REQUEST_TIMEOUT_MS);
  client = await import('@/services/waterdata/water-data-client.js');
  errors = await import('@/services/waterdata/water-data-errors.js');
  deadlines = await import('@/services/waterdata/request-deadline.js');
}

beforeEach(async () => {
  await load();
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

function request(
  overrides: Partial<import('@/services/waterdata/water-data-client.js').WaterDataRequest> = {},
) {
  return {
    ctx: createMockContext(),
    deadline: deadlines.startDeadline(),
    operation: 'probeOperation',
    signal: undefined,
    ...overrides,
  };
}

/** One page of `monitoring-locations` for site 01646500. */
function readPage(overrides: Parameters<typeof request>[0] = {}) {
  const url = client.ogcItemsUrl(
    'monitoring-locations',
    new URLSearchParams({ monitoring_location_number: '01646500' }),
  );
  return client.fetchOgcPage('monitoring-locations', url, Feature, request(overrides));
}

/** The outcome of `operation`, as a value or an error, without letting the rejection go unhandled. */
function outcomeOf<T>(operation: Promise<T>) {
  return operation.then(
    (value) => ({ value }) as const,
    (error: unknown) => ({ error: error as McpError }) as const,
  );
}

/** Settle `operation` while fake time runs forward `ms`. */
async function settle<T>(operation: Promise<T>, ms = 120_000) {
  const outcome = outcomeOf(operation);
  await vi.advanceTimersByTimeAsync(ms);
  return await outcome;
}

async function failure(operation: Promise<unknown>): Promise<McpError> {
  const outcome = await operation.then(
    () => undefined,
    (error: unknown) => error as McpError,
  );
  if (!outcome) throw new Error('Expected the request to fail.');
  return outcome;
}

const mlRoute = (respond: Parameters<typeof ogcRoute>[1], once = false) =>
  ogcRoute('monitoring-locations', respond, { once });

describe('HTTP failure classification', () => {
  it('turns a 429 into RateLimited carrying the wait, the limit, and keyless guidance', async () => {
    water.route(mlRoute(rateLimitResponse(924)));
    const error = await failure(readPage());
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message).toBe(
      'USGS Water Data OGC API rate limit reached (OVER_RATE_LIMIT). The limit is 1000 requests per hour per IP address without an API key. Retry after 924 s.',
    );
    expect(error.data).toMatchObject({
      reason: 'rate_limited',
      retryAfter: 924,
      upstreamCode: 'OVER_RATE_LIMIT',
      rateLimitPerHour: 1000,
      recovery: { hint: expect.stringContaining('setting USGS_API_KEY to a free key') },
    });
    // The wait outlasts the retry ladder, so the 429 is reported, not retried.
    expect(water.requests).toHaveLength(1);
  });

  it('waits out a short Retry-After inside the deadline and retries', async () => {
    useFakeClock();
    water.route(
      mlRoute(rateLimitResponse(2), true),
      mlRoute(jsonResponse(ogcPage([{ id: 'USGS-01646500' }]))),
    );
    const outcome = outcomeOf(readPage());
    await vi.advanceTimersByTimeAsync(1_999);
    expect(water.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(await outcome).toMatchObject({ value: { features: [{ id: 'USGS-01646500' }] } });
    expect(water.requests).toHaveLength(2);
  });

  it('sheds later calls with the same rate-limit shape while the host cooldown is closed', async () => {
    water.route(mlRoute(rateLimitResponse(924)));
    await failure(readPage());
    const shed = await failure(readPage());
    expect(shed.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(shed.message).toMatch(
      /^USGS Water Data OGC API rate limit reached: requests are paused for \d+ s after an HTTP 429\.$/,
    );
    expect(shed.data).toMatchObject({
      reason: 'rate_limited',
      retryAfter: expect.any(Number),
      recovery: { hint: expect.stringContaining('USGS_API_KEY') },
    });
    expect(Number(shed.data?.retryAfter)).toBeGreaterThan(900);
    expect(water.requests).toHaveLength(1);

    // The gate is per host: the Statistics API is not paused by an OGC 429.
    water.route(statisticsRoute('observationNormals', jsonResponse({ features: [], next: null })));
    await expect(
      client.fetchStatistics(
        'observationNormals',
        new URLSearchParams(),
        StatisticsFeature,
        request(),
      ),
    ).resolves.toEqual([]);
    expect(water.requests).toHaveLength(2);
  });

  it('turns a 403 API_KEY_* into a ConfigurationError naming the configured USGS_API_KEY, without retrying', async () => {
    await load({ USGS_API_KEY: KEY });
    water.route(
      mlRoute(jsonResponse(waterDataFixture('error-403-api-key-invalid.json'), { status: 403 })),
    );
    const error = await failure(readPage());
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.message).toBe(
      'USGS Water Data OGC API rejected the configured USGS_API_KEY (API_KEY_INVALID).',
    );
    expect(error.data).toMatchObject({
      reason: 'api_key_rejected',
      upstreamCode: 'API_KEY_INVALID',
      recovery: {
        hint: 'The server operator must replace USGS_API_KEY with a valid key from https://api.waterdata.usgs.gov/signup/, or unset it to send requests without a key.',
      },
    });
    expect(water.requests[0]?.headers.get('x-api-key')).toBe(KEY);
    expect(water.requests).toHaveLength(1);
  });

  it('asks for a USGS_API_KEY, never a configured one, when the gateway wants a key and none is set', async () => {
    water.route(
      // The gateway's body shape; only its code is read.
      mlRoute(jsonResponse({ error: { code: 'API_KEY_MISSING' } }, { status: 403 })),
    );
    const error = await failure(readPage());
    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.message).toBe(
      'USGS Water Data OGC API refused a request sent without an API key (API_KEY_MISSING).',
    );
    expect(error.data).toMatchObject({
      reason: 'api_key_rejected',
      upstreamCode: 'API_KEY_MISSING',
      recovery: {
        hint: 'The server operator must set USGS_API_KEY to a valid api.data.gov key, free from https://api.waterdata.usgs.gov/signup/.',
      },
    });
    expect(water.requests[0]?.headers.has('x-api-key')).toBe(false);
    expect(water.requests).toHaveLength(1);
  });

  it('turns an OGC 400 {code, description} into invalid_request with the upstream description', async () => {
    water.route(
      mlRoute(
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
    );
    const error = await failure(readPage());
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(
      'USGS Water Data OGC API rejected the request: bbox should be either 4 values (minx,miny,maxx,maxy) or 6 values (minx,miny,minz,maxx,maxy,maxz)',
    );
    expect(error.data).toMatchObject({
      reason: 'invalid_request',
      upstreamStatus: 400,
      upstreamCode: 'InvalidParameterValue',
    });
    expect(water.requests).toHaveLength(1);
  });

  it.each([
    [400, 'text/plain', '400 - Bad request', 'Bad request'],
    [
      422,
      'application/json',
      JSON.stringify({
        detail: [{ loc: ['query', 'start_date'], msg: 'String should match pattern', type: 'x' }],
      }),
      'start_date: String should match pattern',
    ],
  ])(
    'turns a Statistics %i (%s) into invalid_request with its stated reason',
    async (status, type, body, stated) => {
      water.route(
        statisticsRoute(
          'observationNormals',
          new Response(body, { status, headers: { 'content-type': type } }),
        ),
      );
      const error = await failure(
        client.fetchStatistics(
          'observationNormals',
          new URLSearchParams(),
          StatisticsFeature,
          request(),
        ),
      );
      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(`USGS Water Data Statistics API rejected the request: ${stated}`);
      expect(error.data).toMatchObject({ reason: 'invalid_request', upstreamStatus: status });
      expect(water.requests).toHaveLength(1);
    },
  );

  it.each([404, 403, 409])(
    'fails a %i at once as a non-retryable upstream_error',
    async (status) => {
      water.route(mlRoute(new Response('<html>nope</html>', { status })));
      const error = await failure(readPage());
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(`USGS Water Data OGC API answered HTTP ${status}.`);
      expect(error.data).toMatchObject({
        reason: 'upstream_error',
        upstreamStatus: status,
        retryable: false,
      });
      expect(water.requests).toHaveLength(1);
    },
  );

  it.each([
    ['not JSON', '<html>maintenance</html>', 'sent a response that is not JSON (probeOperation).'],
    [
      'the wrong shape',
      '{"features":"truncated"}',
      'sent an unexpected response (probeOperation): features:',
    ],
  ])('fails a complete 200 body that is %s in one attempt', async (_label, body, message) => {
    water.route(mlRoute(jsonResponse(body)));
    const error = await failure(readPage());
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain(`USGS Water Data OGC API ${message}`);
    expect(error.data).toMatchObject({ reason: 'upstream_error', retryable: false });
    expect(water.requests).toHaveLength(1);
  });

  it('retries a 5xx and returns the page that follows', async () => {
    useFakeClock();
    water.route(
      mlRoute(new Response('Unavailable', { status: 503 }), true),
      mlRoute(new Response('Bad gateway', { status: 502 }), true),
      mlRoute(jsonResponse(ogcPage([{ id: 'USGS-01646500' }]))),
    );
    const outcome = await settle(readPage());
    expect(outcome).toMatchObject({
      value: { features: [{ id: 'USGS-01646500' }], nextUrl: null },
    });
    expect(water.requests).toHaveLength(3);
  });

  it('reports a 5xx that outlasts the retries with the upstream text and the attempt count', async () => {
    useFakeClock();
    water.route(mlRoute(new Response('Unavailable', { status: 503 })));
    const outcome = await settle(readPage());
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(outcome.error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(outcome.error.message).toBe(
      'USGS Water Data OGC API answered HTTP 503: Unavailable (failed after 4 attempts)',
    );
    expect(outcome.error.data).toMatchObject({
      reason: 'upstream_error',
      upstreamStatus: 503,
      retryAttempts: 4,
    });
    expect(water.requests).toHaveLength(4);
  });

  it('fails a 501 at once: the upstream does not implement the request', async () => {
    useFakeClock();
    water.route(mlRoute(new Response('Not Implemented', { status: 501 })));
    const outcome = await settle(readPage());
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(outcome.error.data).toMatchObject({
      reason: 'upstream_error',
      upstreamStatus: 501,
      retryable: false,
    });
    expect(water.requests).toHaveLength(1);
  });

  it('keeps retrying 408 and 504, which the upstream marks as timeouts', async () => {
    useFakeClock();
    water.route(
      mlRoute(new Response('', { status: 408 }), true),
      mlRoute(new Response('', { status: 504 }), true),
      mlRoute(jsonResponse(ogcPage([]))),
    );
    expect(await settle(readPage())).toMatchObject({ value: { features: [] } });
    expect(water.requests).toHaveLength(3);
  });
});

describe('classifyWaterDataFailure', () => {
  it.each([
    ['a deadline timeout', 'upstream_timeout'],
    ['a rejected request', 'invalid_request'],
  ] as const)('maps %s onto %s, keeping timeout data', async (label, reason) => {
    useFakeClock();
    if (label === 'a deadline timeout') water.route(mlRoute(stalled));
    if (label === 'a rejected request')
      water.route(
        mlRoute(
          jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
        ),
      );
    const outcome = await settle(readPage());
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    const classified = errors.classifyWaterDataFailure(outcome.error);
    expect(classified).toMatchObject({ reason, message: outcome.error.message });
    if (reason === 'upstream_timeout')
      expect(classified?.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
        operation: 'probeOperation',
      });
    else expect(classified?.data).toBeUndefined();
  });

  it.each([
    ['a 404', () => new Response('', { status: 404 })],
    ['a 501', () => new Response('', { status: 501 })],
    ['a 200 body that is not JSON', () => new Response('<html>maintenance</html>')],
    ['a 200 body of the wrong shape', () => jsonResponse({ features: 'truncated' })],
    [
      'a continuation off the collection',
      () => jsonResponse(ogcPage([{ id: 'USGS-01646500' }], 'https://example.com/?cursor=c2')),
    ],
  ])('maps %s onto upstream_error that stays marked not retryable', async (_label, respond) => {
    water.route(mlRoute(respond));
    const error = await failure(readPage());
    expect(errors.classifyWaterDataFailure(error)).toEqual({
      reason: 'upstream_error',
      message: error.message,
      data: { retryable: false },
    });
    expect(water.requests).toHaveLength(1);
  });

  it('maps a 5xx that outlasts the retries onto upstream_error without a not-retryable mark', async () => {
    useFakeClock();
    water.route(mlRoute(new Response('Unavailable', { status: 503 })));
    const outcome = await settle(readPage());
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(errors.classifyWaterDataFailure(outcome.error)).toEqual({
      reason: 'upstream_error',
      message: outcome.error.message,
    });
    expect(water.requests).toHaveLength(4);
  });

  it.each([
    ['a rate limit', () => rateLimitResponse(924)],
    [
      'a rejected key',
      () => jsonResponse(waterDataFixture('error-403-api-key-invalid.json'), { status: 403 }),
    ],
  ])('leaves %s for the caller to rethrow', async (_label, respond) => {
    water.route(mlRoute(respond()));
    expect(errors.classifyWaterDataFailure(await failure(readPage()))).toBeNull();
  });

  it('leaves caller cancellation and unclassified throws alone', () => {
    expect(errors.classifyWaterDataFailure(new DOMException('stop', 'AbortError'))).toBeNull();
    expect(errors.classifyWaterDataFailure(new Error('boom'))).toBeNull();
  });
});

describe('one deadline per call', () => {
  it.each([
    ['headers', stalled],
    ['body', stalledBody],
  ] as const)(
    'stops a stalled exchange (%s) at the 45 s budget when the per-request timeout is longer',
    async (_stage, respond) => {
      await load({ USGS_REQUEST_TIMEOUT_MS: '60000' });
      useFakeClock();
      water.route(mlRoute(respond));
      const outcome = outcomeOf(readPage());
      await vi.advanceTimersByTimeAsync(44_999);
      expect(water.requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await outcome;
      if (!('error' in result)) throw new Error('Expected a failure.');
      expect(result.error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(result.error.message).toBe(
        'probeOperation ran out of the 45000 ms budget for this call after 1 attempt.',
      );
      expect(result.error.data).toMatchObject({
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
        elapsedMs: 45_000,
        retryAttempts: 1,
        operation: 'probeOperation',
      });
      expect(water.requests).toHaveLength(1);
    },
  );

  it('fits a second attempt into what the 30 s request timeout leaves, then stops', async () => {
    useFakeClock();
    water.route(mlRoute(stalled));
    const outcome = await settle(readPage());
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(outcome.error.message).toBe(
      'probeOperation ran out of the 45000 ms budget for this call after 2 attempts.',
    );
    expect(outcome.error.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      retryAttempts: 2,
    });
    expect(water.requests).toHaveLength(2);
  });

  it('charges every page of a walk to the same budget', async () => {
    await load({ USGS_REQUEST_TIMEOUT_MS: '60000' });
    useFakeClock();
    water.route(
      ogcRoute(
        'monitoring-locations',
        () =>
          new Promise<Response>((resolve) =>
            setTimeout(
              () => resolve(jsonResponse(ogcPage([{ id: 'a' }], `${ML_ITEMS}?cursor=2&f=json`))),
              40_000,
            ),
          ),
        { query: { cursor: null } },
      ),
      ogcRoute('monitoring-locations', stalled, { query: { cursor: '2' } }),
    );
    const outcome = await settle(
      client.fetchOgcItems('monitoring-locations', new URLSearchParams(), Feature, request()),
    );
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(outcome.error.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 45_000,
      elapsedMs: 45_000,
    });
    expect(water.requests.map((r) => r.url.searchParams.get('cursor'))).toEqual([null, '2']);
  });

  it('sends nothing when the call starts with its budget spent', async () => {
    useFakeClock();
    const deadline = deadlines.startDeadline(1_000);
    vi.advanceTimersByTime(1_000);
    const error = await failure(readPage({ deadline }));
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toBe(
      'probeOperation ran out of the 1000 ms budget for this call before its request could start.',
    );
    expect(error.data).toMatchObject({
      reason: 'retry_deadline_exceeded',
      deadlineMs: 1_000,
      retryAttempts: 0,
    });
    expect(water.requests).toHaveLength(0);
  });
});

describe('caller cancellation', () => {
  it('rejects a cancelled request as RequestCancelled without retrying', async () => {
    useFakeClock();
    water.route(mlRoute(stalled));
    const controller = new AbortController();
    const pending = outcomeOf(readPage({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    const outcome = await pending;
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(outcome.error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(outcome.error.message).toBe('fetch GET https://api.waterdata.usgs.gov/…?… was aborted.');
    expect(errors.classifyWaterDataFailure(outcome.error)).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(water.requests).toHaveLength(1);
  });

  it('reports a caller deadline as a timeout the caller set, without retrying', async () => {
    useFakeClock();
    water.route(mlRoute(stalled));
    const controller = new AbortController();
    const pending = outcomeOf(readPage({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new DOMException('Caller deadline', 'TimeoutError'));
    const outcome = await pending;
    if (!('error' in outcome)) throw new Error('Expected a failure.');
    expect(outcome.error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(outcome.error.data).toMatchObject({ errorSource: 'FetchSignalTimeout' });
    expect(errors.classifyWaterDataFailure(outcome.error)).toMatchObject({
      reason: 'upstream_timeout',
      data: { errorSource: 'FetchSignalTimeout' },
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(water.requests).toHaveLength(1);
  });

  it('stops during a retry backoff with the caller’s own reason', async () => {
    useFakeClock();
    water.route(mlRoute(new Response('Unavailable', { status: 503 })));
    const controller = new AbortController();
    const pending = outcomeOf(readPage({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(0);
    expect(water.requests).toHaveLength(1);
    const reason = new DOMException('Caller cancelled the request', 'AbortError');
    controller.abort(reason);
    expect(await pending).toEqual({ error: reason });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(water.requests).toHaveLength(1);
  });

  it('sends nothing for a call whose signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    await expect(readPage({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(water.requests).toHaveLength(0);
  });
});

describe('USGS_API_KEY', () => {
  it('sends no X-Api-Key header when the key is unset', async () => {
    water.route(mlRoute(jsonResponse(ogcPage([]))));
    await readPage();
    expect(water.requests[0]?.headers.has('x-api-key')).toBe(false);
    expect(water.requests[0]?.headers.get('user-agent')).toMatch(/^usgs-water-mcp-server\//);
  });

  it('sends the key as a header on every request and nowhere else', async () => {
    await load({ USGS_API_KEY: KEY });
    const { logger } = await import('@cyanheads/mcp-ts-core/utils');
    const logged = vi.spyOn(logger, 'log');
    const ctx = createMockContext();
    water.route(
      ogcRoute(
        'monitoring-locations',
        jsonResponse(ogcPage([{ id: 'a' }], `${ML_ITEMS}?cursor=2&f=json`)),
        {
          query: { cursor: null },
        },
      ),
      ogcRoute('monitoring-locations', jsonResponse(ogcPage([{ id: 'b' }])), {
        query: { cursor: '2' },
      }),
      ogcRoute(
        'states',
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
      ogcRoute('hydrologic-unit-codes', rateLimitResponse(924)),
      statisticsRoute('observationNormals', jsonResponse({ features: [], next: null })),
    );
    const call = {
      ctx,
      deadline: deadlines.startDeadline(),
      operation: 'keyed',
      signal: undefined,
    };
    await client.fetchOgcItems('monitoring-locations', new URLSearchParams(), Feature, call);
    await client.fetchStatistics(
      'observationNormals',
      new URLSearchParams(),
      StatisticsFeature,
      call,
    );
    const rejected = await failure(
      client.fetchOgcItems('states', new URLSearchParams(), Feature, call),
    );
    const limited = await failure(
      client.fetchOgcItems('hydrologic-unit-codes', new URLSearchParams(), Feature, call),
    );

    expect(water.requests).toHaveLength(5);
    for (const sent of water.requests) {
      expect(sent.headers.get('x-api-key')).toBe(KEY);
      expect(sent.url.href).not.toContain(KEY);
    }
    expect(limited.data?.recovery).toEqual({
      hint: expect.stringContaining('already sends its USGS_API_KEY'),
    });
    expect(limited.message).toContain("for this server's USGS_API_KEY");
    expect(logged).toHaveBeenCalled();
    const surfaces = [
      inspect([rejected, limited], { depth: 12 }),
      inspect(logged.mock.calls, { depth: 12 }),
      inspect((ctx.log as MockContextLogger).calls, { depth: 12 }),
    ];
    for (const surface of surfaces) expect(surface).not.toContain(KEY);
  });
});

describe('OGC paging', () => {
  /** Pages keyed by cursor: `null` is the first page. */
  function servePages(pages: Record<string, { ids: string[]; next?: string }>) {
    for (const [cursor, page] of Object.entries(pages)) {
      water.route(
        ogcRoute(
          'monitoring-locations',
          jsonResponse(
            ogcPage(
              page.ids.map((id) => ({ id })),
              page.next ? `${ML_ITEMS}?cursor=${page.next}&limit=3&f=json` : undefined,
            ),
          ),
          { query: { cursor: cursor === 'first' ? null : cursor } },
        ),
      );
    }
  }

  it('follows next links verbatim through short pages and a changing page size', async () => {
    servePages({
      first: { ids: ['a', 'b'], next: 'p2' },
      p2: { ids: ['c', 'd', 'e'], next: 'p3' },
      p3: { ids: ['f'] },
    });
    const features = await client.fetchOgcItems(
      'monitoring-locations',
      new URLSearchParams({ state_code: '24', limit: '3' }),
      Feature,
      request(),
    );
    expect(features.map((f) => f.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    const [first, ...rest] = water.requests.map((r) => r.url);
    expect(first?.searchParams.get('state_code')).toBe('24');
    expect(first?.searchParams.get('f')).toBe('json');
    expect(rest.map((url) => url.href)).toEqual([
      `${ML_ITEMS}?cursor=p2&limit=3&f=json`,
      `${ML_ITEMS}?cursor=p3&limit=3&f=json`,
    ]);
  });

  it('fails a page that carries a next link but no features', async () => {
    servePages({ first: { ids: [], next: 'p2' } });
    const error = await failure(
      client.fetchOgcItems('monitoring-locations', new URLSearchParams(), Feature, request()),
    );
    expect(error.message).toBe(
      'USGS Water Data OGC API sent an empty page that still has a continuation (probeOperation).',
    );
    expect(error.data).toMatchObject({ reason: 'upstream_error', retryable: false });
    expect(water.requests).toHaveLength(1);
  });

  it('fails a next link that returns to a page already read', async () => {
    servePages({ first: { ids: ['a'], next: 'p2' }, p2: { ids: ['b'], next: 'p2' } });
    const error = await failure(
      client.fetchOgcItems('monitoring-locations', new URLSearchParams(), Feature, request()),
    );
    expect(error.message).toBe(
      'USGS Water Data OGC API sent a continuation back to a page already read (probeOperation).',
    );
    expect(water.requests).toHaveLength(2);
  });

  it.each([
    ['another collection', `${OGC}/states/items?offset=1&f=json`],
    [
      'another origin',
      'https://api.waterdata.usgs.gov.example.com/ogcapi/v1/collections/monitoring-locations/items?cursor=x',
    ],
  ])('never follows a next link to %s', async (_label, href) => {
    water.route(
      mlRoute(
        jsonResponse({
          type: 'FeatureCollection',
          features: [{ id: 'a' }],
          links: [{ rel: 'next', href }],
        }),
      ),
    );
    const error = await failure(
      client.fetchOgcItems('monitoring-locations', new URLSearchParams(), Feature, request()),
    );
    expect(error.message).toBe(
      'USGS Water Data OGC API sent a continuation outside the monitoring-locations collection (probeOperation).',
    );
    expect(water.requests).toHaveLength(1);
  });
});

describe('Statistics paging', () => {
  const site = (id: string) => ({ type: 'Feature', properties: { monitoring_location_id: id } });

  function serveTokens(pages: Record<string, { ids: string[]; next: string | null }>) {
    for (const [token, page] of Object.entries(pages)) {
      water.route(
        statisticsRoute(
          'observationNormals',
          jsonResponse({
            type: 'FeatureCollection',
            features: page.ids.map(site),
            next: page.next,
          }),
          { query: { next_token: token === 'first' ? null : token } },
        ),
      );
    }
  }

  it('passes each next token back as next_token, keeping repeated parameters and sending no f', async () => {
    serveTokens({
      first: { ids: ['USGS-1', 'USGS-2'], next: 't2' },
      t2: { ids: ['USGS-3'], next: 't3' },
      t3: { ids: ['USGS-4', 'USGS-5', 'USGS-6'], next: null },
    });
    const query = new URLSearchParams([
      ['monitoring_location_id', 'USGS-01646500'],
      ['parameter_code', '00060'],
      ['parameter_code', '00010'],
    ]);
    const features = await client.fetchStatistics(
      'observationNormals',
      query,
      StatisticsFeature,
      request(),
    );
    expect(features.map((f) => f.properties.monitoring_location_id)).toEqual([
      'USGS-1',
      'USGS-2',
      'USGS-3',
      'USGS-4',
      'USGS-5',
      'USGS-6',
    ]);
    expect(water.requests.map((r) => r.url.searchParams.get('next_token'))).toEqual([
      null,
      't2',
      't3',
    ]);
    for (const { url } of water.requests) {
      expect(url.pathname).toBe('/statistics/v0/observationNormals');
      expect(url.searchParams.getAll('parameter_code')).toEqual(['00060', '00010']);
      expect(url.searchParams.has('f')).toBe(false);
    }
  });

  it('reads a captured normals page', async () => {
    water.route(
      statisticsRoute(
        'observationNormals',
        jsonResponse(waterDataFixture('statistics-normals-page.json')),
      ),
    );
    const features = await client.fetchStatistics(
      'observationNormals',
      new URLSearchParams(),
      StatisticsFeature,
      request(),
    );
    expect(features.map((f) => f.properties.monitoring_location_id)).toEqual(['USGS-01646500']);
  });

  it.each([
    ['a token on an empty page', { first: { ids: [], next: 't2' } }, 1],
    [
      'a repeated token',
      { first: { ids: ['USGS-1'], next: 't2' }, t2: { ids: ['USGS-2'], next: 't2' } },
      2,
    ],
  ])('fails %s', async (_label, pages, sent) => {
    serveTokens(pages);
    const error = await failure(
      client.fetchStatistics(
        'observationNormals',
        new URLSearchParams(),
        StatisticsFeature,
        request(),
      ),
    );
    expect(error.message).toBe(
      'USGS Water Data Statistics API sent a continuation that does not advance (probeOperation).',
    );
    expect(error.data).toMatchObject({ reason: 'upstream_error', retryable: false });
    expect(water.requests).toHaveLength(sent);
  });
});

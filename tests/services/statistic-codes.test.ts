/**
 * @fileoverview The statistic-code names reader at the fetch seam: one `statistic-codes` request,
 * names in sentence case, a 24-hour cache that never stores a failure, one shared request for
 * concurrent callers that no caller's cancellation can fail, and its own 45-second budget. Each
 * test loads the module fresh, so its cache and in-flight load start empty.
 * @module tests/services/statistic-codes.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWaterDataFake,
  jsonResponse,
  ogcPage,
  ogcRoute,
  stalled,
  type WaterDataFake,
  waterDataFixture,
} from '../helpers/water-data-fake.js';

type StatisticCodes = typeof import('@/services/waterdata/statistic-codes.js');

let water: WaterDataFake;
let codes: StatisticCodes;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  codes = await import('@/services/waterdata/statistic-codes.js');
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

/** The captured table: 00001–00011 and 00021–00024, in capitals as the collection writes them. */
function tableRoute(options: { once?: boolean } = {}) {
  return ogcRoute(
    'statistic-codes',
    () => jsonResponse(waterDataFixture('observations-statistic-codes.json')),
    options,
  );
}

describe('getStatisticNames', () => {
  it('reads the whole table in one request and names each code in sentence case', async () => {
    water.route(tableRoute());
    const names = await codes.getStatisticNames(createMockContext());
    expect(Object.fromEntries(names)).toEqual({
      '00001': 'Maximum',
      '00002': 'Minimum',
      '00003': 'Mean',
      '00004': 'Am',
      '00005': 'Pm',
      '00006': 'Sum',
      '00007': 'Mode',
      '00008': 'Median',
      '00009': 'Std',
      '00010': 'Variance',
      '00011': 'Instantaneous',
      '00021': 'Tidal high-high',
      '00022': 'Tidal low-high',
      '00023': 'Tidal high-low',
      '00024': 'Tidal low-low',
    });
    expect(water.requests).toHaveLength(1);
    expect(Object.fromEntries(water.requests[0]!.url.searchParams)).toEqual({
      limit: '5000',
      skipGeometry: 'true',
      properties: 'statistic_name',
      f: 'json',
    });
  });

  it('leaves out a code the table names nothing for', async () => {
    water.route(
      ogcRoute('statistic-codes', () =>
        jsonResponse(
          ogcPage([
            {
              type: 'Feature',
              id: '00003',
              properties: { statistic_name: 'MEAN' },
              geometry: null,
            },
            { type: 'Feature', id: '00099', properties: { statistic_name: null }, geometry: null },
            { type: 'Feature', id: '00098', properties: { statistic_name: '' }, geometry: null },
            { type: 'Feature', id: '00097', properties: {}, geometry: null },
          ]),
        ),
      ),
    );
    const names = await codes.getStatisticNames(createMockContext());
    expect([...names]).toEqual([['00003', 'Mean']]);
  });

  it('follows a next link to the last page', async () => {
    const next =
      'https://api.waterdata.usgs.gov/ogcapi/v1/collections/statistic-codes/items?f=json&offset=1';
    water.route(
      ogcRoute(
        'statistic-codes',
        () =>
          jsonResponse(
            ogcPage(
              [
                {
                  type: 'Feature',
                  id: '00001',
                  properties: { statistic_name: 'MAXIMUM' },
                  geometry: null,
                },
              ],
              next,
            ),
          ),
        { query: { offset: null } },
      ),
      ogcRoute(
        'statistic-codes',
        () =>
          jsonResponse(
            ogcPage([
              {
                type: 'Feature',
                id: '00002',
                properties: { statistic_name: 'MINIMUM' },
                geometry: null,
              },
            ]),
          ),
        { query: { offset: '1' } },
      ),
    );
    const names = await codes.getStatisticNames(createMockContext());
    expect([...names]).toEqual([
      ['00001', 'Maximum'],
      ['00002', 'Minimum'],
    ]);
    expect(water.requests.map((r) => r.url.searchParams.get('offset'))).toEqual([null, '1']);
  });

  it('serves the table from the cache for 24 hours, then reads it again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    water.route(tableRoute());
    const first = await codes.getStatisticNames(createMockContext());
    vi.setSystemTime(new Date('2026-11-11T23:59:59.999Z'));
    expect(await codes.getStatisticNames(createMockContext())).toBe(first);
    expect(water.requests).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    const refreshed = await codes.getStatisticNames(createMockContext());
    expect(water.requests).toHaveLength(2);
    expect(refreshed).not.toBe(first);
    expect(refreshed.get('00003')).toBe('Mean');
  });

  it('shares one request between concurrent callers', async () => {
    water.route(tableRoute());
    const [a, b, c] = await Promise.all([
      codes.getStatisticNames(createMockContext()),
      codes.getStatisticNames(createMockContext()),
      codes.getStatisticNames(createMockContext()),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(water.requests).toHaveLength(1);
  });

  it("carries no caller's signal, so a cancelled caller's context still loads the table", async () => {
    water.route(tableRoute());
    const cancelled = new AbortController();
    cancelled.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    const names = await codes.getStatisticNames(createMockContext({ signal: cancelled.signal }));
    expect(names.get('00001')).toBe('Maximum');
    expect(water.requests).toHaveLength(1);
  });

  it('never caches a failure: the next call asks again', async () => {
    water.route(
      ogcRoute(
        'statistic-codes',
        () =>
          jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
        { once: true },
      ),
      tableRoute(),
    );
    await expect(codes.getStatisticNames(createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
    });
    expect(water.requests).toHaveLength(1);
    expect((await codes.getStatisticNames(createMockContext())).get('00003')).toBe('Mean');
    expect(water.requests).toHaveLength(2);
  });

  it('fails a body that is not the table at once, without retrying', async () => {
    water.route(ogcRoute('statistic-codes', () => new Response('<html>maintenance</html>')));
    const error = await codes.getStatisticNames(createMockContext()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: 'USGS Water Data OGC API sent a response that is not JSON (getStatisticNames).',
      data: { reason: 'upstream_error', retryable: false },
    });
    expect(water.requests).toHaveLength(1);
  });

  it('ends a stalled read at its own 45-second budget', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    water.route(ogcRoute('statistic-codes', stalled));
    const outcome = codes.getStatisticNames(createMockContext()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'getStatisticNames ran out of the 45000 ms budget for this call after 2 attempts.',
      data: {
        reason: 'retry_deadline_exceeded',
        deadlineMs: 45_000,
        operation: 'getStatisticNames',
      },
    });
    // A 30 s attempt, a backoff, and a second attempt cut short by the budget.
    expect(water.requests).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

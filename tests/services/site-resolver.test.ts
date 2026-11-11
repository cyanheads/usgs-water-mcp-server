/**
 * @fileoverview Site-number resolution at the fetch seam: any agency, the USGS record on a
 * collision, 100 numbers per request, a bounded TTL cache that never stores a miss, and one shared
 * in-flight load per number that a cancelled caller cannot fail for the others. Each test loads the
 * resolver fresh, so its cache and in-flight loads start empty.
 * @module tests/services/site-resolver.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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

type Resolver = typeof import('@/services/waterdata/site-resolver.js');
type Deadlines = typeof import('@/services/waterdata/request-deadline.js');

let water: WaterDataFake;
let resolver: Resolver;
let deadlines: Deadlines;

beforeEach(async () => {
  vi.resetModules();
  vi.stubEnv('USGS_API_KEY', undefined);
  resolver = await import('@/services/waterdata/site-resolver.js');
  deadlines = await import('@/services/waterdata/request-deadline.js');
  water = createWaterDataFake();
  water.install();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  water.restore();
});

function request(signal?: AbortSignal) {
  return {
    ctx: createMockContext(),
    deadline: deadlines.startDeadline(),
    operation: 'resolveSites',
    signal,
  };
}

/** A `monitoring-locations` feature as the resolver's `properties=` query returns it. */
function location(number: string, agency = 'USGS') {
  return {
    type: 'Feature',
    id: `${agency}-${number}`,
    properties: {
      monitoring_location_number: number,
      monitoring_location_name: `${agency} site ${number}`,
      agency_code: agency,
      time_zone_abbreviation: 'EST',
      uses_daylight_savings: 'Y',
    },
    geometry: null,
  };
}

/** The numbers one resolver request asked for. */
function numbersOf(url: URL): string[] {
  return url.searchParams.get('monitoring_location_number')?.split(',') ?? [];
}

/** Answer every number a request names with a USGS location, except those in `missing`. */
function answerAll(missing: readonly string[] = []) {
  return ogcRoute('monitoring-locations', (req) =>
    jsonResponse(
      ogcPage(
        numbersOf(new URL(req.url))
          .filter((n) => !missing.includes(n))
          .map((n) => location(n)),
      ),
    ),
  );
}

/** A response held until `release()` — a load the test keeps in flight. */
function heldRoute() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const route = ogcRoute(
    'monitoring-locations',
    async (req) => {
      await gate;
      return jsonResponse(ogcPage(numbersOf(new URL(req.url)).map((n) => location(n))));
    },
    { once: true },
  );
  return { route, release };
}

describe('resolveSites', () => {
  it('resolves numbers under any agency, with name and time zone, in one exact-match request', async () => {
    water.route(
      ogcRoute(
        'monitoring-locations',
        jsonResponse(waterDataFixture('monitoring-locations-by-number.json')),
      ),
    );
    const sites = await resolver.resolveSites(['364643089212301', '01646500'], request());
    expect(sites.get('364643089212301')).toEqual({
      agencyCode: 'MO005',
      monitoringLocationId: 'MO005-364643089212301',
      siteName: 'East Prairie',
      siteNumber: '364643089212301',
      timeZone: { abbreviation: 'CST', observesDaylightSaving: true },
    });
    expect(sites.get('01646500')).toMatchObject({
      agencyCode: 'USGS',
      monitoringLocationId: 'USGS-01646500',
      timeZone: { abbreviation: 'EST', observesDaylightSaving: true },
    });
    expect(water.requests).toHaveLength(1);
    const url = water.requests[0]!.url;
    expect(Object.fromEntries(url.searchParams)).toEqual({
      skipGeometry: 'true',
      monitoring_location_number: '364643089212301,01646500',
      properties:
        'monitoring_location_number,monitoring_location_name,agency_code,time_zone_abbreviation,uses_daylight_savings',
      limit: '1000',
      f: 'json',
    });
  });

  it('leaves a number with no location out of the result', async () => {
    water.route(answerAll(['99999999']));
    const sites = await resolver.resolveSites(['01646500', '99999999'], request());
    expect([...sites.keys()]).toEqual(['01646500']);
  });

  it.each([
    ['USGS second', ['MD007', 'USGS'], 'USGS-01650500'],
    ['USGS first', ['USGS', 'MD007'], 'USGS-01650500'],
    ['no USGS record', ['VA087', 'MD007'], 'MD007-01650500'],
  ])('picks one record when a number is registered twice (%s)', async (_label, agencies, id) => {
    water.route(
      ogcRoute(
        'monitoring-locations',
        jsonResponse(ogcPage(agencies.map((a) => location('01650500', a)))),
      ),
    );
    const sites = await resolver.resolveSites(['01650500'], request());
    expect(sites.get('01650500')?.monitoringLocationId).toBe(id);
  });

  it('asks for 100 numbers per request and each number once', async () => {
    water.route(answerAll());
    const numbers = Array.from({ length: 250 }, (_, i) => String(1_000_000_00 + i));
    const sites = await resolver.resolveSites([...numbers, numbers[0]!, numbers[249]!], request());
    expect(sites.size).toBe(250);
    const asked = water.requests.map((r) => numbersOf(r.url));
    expect(asked.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(asked.flat().sort()).toEqual([...numbers].sort());
  });

  it('serves a resolved number from the cache for 24 hours, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T00:00:00Z'));
    water.route(answerAll());
    const first = await resolver.resolveSites(['01646500'], request());
    vi.setSystemTime(new Date('2026-11-11T23:59:59.999Z'));
    expect(await resolver.resolveSites(['01646500'], request())).toEqual(first);
    expect(water.requests).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-12T00:00:00Z'));
    await resolver.resolveSites(['01646500'], request());
    expect(water.requests).toHaveLength(2);
  });

  it('asks only for the numbers the cache does not hold', async () => {
    water.route(answerAll());
    await resolver.resolveSites(['01646500'], request());
    await resolver.resolveSites(['01646500', '01638500'], request());
    expect(water.requests.map((r) => numbersOf(r.url))).toEqual([['01646500'], ['01638500']]);
  });

  it('never caches a miss', async () => {
    water.route(answerAll(['99999999']));
    await resolver.resolveSites(['99999999'], request());
    await resolver.resolveSites(['99999999'], request());
    expect(water.requests).toHaveLength(2);
  });

  it('holds at most 5,000 numbers, dropping the oldest first', async () => {
    water.route(answerAll());
    const numbers = Array.from({ length: 5_001 }, (_, i) => String(2_000_000_00 + i));
    await resolver.resolveSites([numbers[0]!], request());
    await resolver.resolveSites(numbers.slice(1), request());
    const sent = water.requests.length;
    expect(sent).toBe(51);
    await resolver.resolveSites([numbers[5_000]!, numbers[1]!], request());
    expect(water.requests).toHaveLength(sent);
    await resolver.resolveSites([numbers[0]!], request());
    expect(water.requests).toHaveLength(sent + 1);
    expect(numbersOf(water.requests.at(-1)!.url)).toEqual([numbers[0]]);
  });

  it('shares one in-flight load between concurrent callers for the same number', async () => {
    const held = heldRoute();
    water.route(held.route, answerAll());
    const first = resolver.resolveSites(['01646500'], request());
    const second = resolver.resolveSites(['01646500', '01638500'], request());
    await vi.waitFor(() => expect(water.requests).toHaveLength(2));
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(b.get('01646500')).toBe(a.get('01646500'));
    expect(b.get('01638500')?.monitoringLocationId).toBe('USGS-01638500');
    expect(water.requests.map((r) => numbersOf(r.url))).toEqual([['01646500'], ['01638500']]);
  });

  it('does not fail a waiting caller when the caller that started the load is cancelled', async () => {
    water.route(ogcRoute('monitoring-locations', stalled, { once: true }), answerAll());
    const starter = new AbortController();
    const first = resolver.resolveSites(['01646500'], request(starter.signal));
    const second = resolver.resolveSites(['01646500'], request(new AbortController().signal));
    await vi.waitFor(() => expect(water.requests).toHaveLength(1));
    starter.abort(new DOMException('Caller cancelled the request', 'AbortError'));
    await expect(first).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: expect.stringContaining('was aborted'),
    });
    expect((await second).get('01646500')?.monitoringLocationId).toBe('USGS-01646500');
    expect(water.requests).toHaveLength(2);
  });

  it('ends a waiting caller’s wait at its own cancellation, leaving the load to the others', async () => {
    const held = heldRoute();
    water.route(held.route);
    const first = resolver.resolveSites(['01646500'], request());
    const waiter = new AbortController();
    const second = resolver.resolveSites(['01646500'], request(waiter.signal));
    await vi.waitFor(() => expect(water.requests).toHaveLength(1));
    const reason = new DOMException('Caller cancelled the request', 'AbortError');
    waiter.abort(reason);
    await expect(second).rejects.toBe(reason);
    held.release();
    expect((await first).get('01646500')?.monitoringLocationId).toBe('USGS-01646500');
    expect(water.requests).toHaveLength(1);
  });

  it('hands a shared load’s upstream failure to every caller without loading again', async () => {
    water.route(
      ogcRoute(
        'monitoring-locations',
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
      ),
    );
    const results = await Promise.allSettled([
      resolver.resolveSites(['01646500'], request()),
      resolver.resolveSites(['01646500'], request()),
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        status: 'rejected',
        reason: { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_request' } },
      });
    expect(water.requests).toHaveLength(1);
  });

  it('loads a number again for the next call once its load has failed', async () => {
    water.route(
      ogcRoute(
        'monitoring-locations',
        jsonResponse(waterDataFixture('error-400-invalid-parameter-value.json'), { status: 400 }),
        { once: true },
      ),
      answerAll(),
    );
    await expect(resolver.resolveSites(['01646500'], request())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_request' },
    });
    const again = await resolver.resolveSites(['01646500'], request());
    expect(again.get('01646500')?.monitoringLocationId).toBe('USGS-01646500');
    expect(water.requests).toHaveLength(2);
  });

  it('sends nothing for no numbers', async () => {
    expect((await resolver.resolveSites([], request())).size).toBe(0);
    expect(water.requests).toHaveLength(0);
  });
});

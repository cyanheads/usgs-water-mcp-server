/**
 * @fileoverview The Water Data fake's own guarantees, which every tool test built on it relies on:
 * it records every request with its headers, matches routes on origin, path, and query, and
 * reports a request no route matched even when the code under test swallowed the rejection.
 * @module tests/helpers/water-data-fake.test
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createWaterDataFake,
  jsonResponse,
  ogcRoute,
  statisticsRoute,
  type WaterDataFake,
} from './water-data-fake.js';

const ML = 'https://api.waterdata.usgs.gov/ogcapi/v1/collections/monitoring-locations/items';
let water: WaterDataFake | undefined;

afterEach(() => {
  water?.restore();
  water = undefined;
});

describe('createWaterDataFake', () => {
  it('records each request with its headers and serves the first matching route', async () => {
    water = createWaterDataFake().route(
      ogcRoute('monitoring-locations', jsonResponse({ page: 'second' }), {
        query: { cursor: 'x' },
      }),
      ogcRoute('monitoring-locations', jsonResponse({ page: 'first' }), {
        query: { cursor: null },
      }),
    );
    water.install();
    const first = await fetch(`${ML}?f=json`, { headers: { 'X-Api-Key': 'k' } });
    const second = await fetch(`${ML}?f=json&cursor=x`);
    expect(await first.json()).toEqual({ page: 'first' });
    expect(await second.json()).toEqual({ page: 'second' });
    expect(water.requests.map((r) => [r.method, r.url.search, r.headers.get('x-api-key')])).toEqual(
      [
        ['GET', '?f=json', 'k'],
        ['GET', '?f=json&cursor=x', null],
      ],
    );
  });

  it('matches the path exactly and the origin, not a prefix of it', async () => {
    const fake = createWaterDataFake().route(
      ogcRoute('monitoring-locations', jsonResponse({})),
      statisticsRoute('observationNormals', jsonResponse({})),
    );
    fake.install();
    await expect(fetch(`${ML}/USGS-01646500`)).rejects.toThrow('unmocked fetch');
    await expect(
      fetch('https://api.waterdata.usgs.gov.example.com/statistics/v0/observationNormals'),
    ).rejects.toThrow('unmocked fetch');
    expect(fake.requests).toHaveLength(2);
    expect(() => fake.restore()).toThrow(/Requests matched no route:\nGET .*USGS-01646500/);
  });

  it('reports an unmatched request at restore even when the caller swallowed it', async () => {
    const original = globalThis.fetch;
    const fake = createWaterDataFake();
    fake.install();
    expect(globalThis.fetch).not.toBe(original);
    await fetch(`${ML}?f=json`).catch(() => undefined);
    expect(() => fake.restore()).toThrow('Requests matched no route');
    expect(globalThis.fetch).toBe(original);
  });
});

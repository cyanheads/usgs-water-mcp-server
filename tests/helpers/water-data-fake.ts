/**
 * @fileoverview A fake of the USGS Water Data APIs (the OGC collections and the Statistics API) at
 * the fetch seam, built on the framework's `createFetchMock`, plus the fixture readers and canned
 * responses tests share. The fake records every request it sees — URL and headers, matched or not
 * — and rejects a request no route matches; `restore()` then throws naming it, so a test cannot
 * pass while the code under test swallowed a request nobody mocked.
 *
 * Module state outlives a test that shares its module graph: the client's per-host cooldown gate
 * (closed by a 429), the site resolver's cache and in-flight loads, the parameter catalog's cache,
 * and the parsed server config. A test that serves a 429, resolves sites, reads the catalog, or
 * sets an env var loads its modules fresh — `vi.resetModules()` and a dynamic `import()` in
 * `beforeEach`. Tests that move time fake `Date` with the timers
 * (`vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })`): the call deadline and
 * the retry clock read `Date.now()`.
 * @module tests/helpers/water-data-fake
 */

import { readFileSync } from 'node:fs';
import {
  createFetchMock,
  type FetchMockResponder,
  type FetchMockRoute,
} from '@cyanheads/mcp-ts-core/testing';

const ORIGIN = 'https://api.waterdata.usgs.gov';
const OGC_PATH = '/ogcapi/v1/collections';
const STATISTICS_PATH = '/statistics/v0';

/** One request the code under test sent. */
export interface SentRequest {
  /** Header names lowercased, as `Headers` stores them. */
  headers: Headers;
  method: string;
  url: URL;
}

/** The fake: `install()` it in `beforeEach`, `restore()` it in `afterEach`. */
export interface WaterDataFake {
  /** Replace `globalThis.fetch`. Idempotent until restored. */
  install(): void;
  /** Every request sent while installed, in order, whether or not a route matched it. */
  readonly requests: readonly SentRequest[];
  /** Put `globalThis.fetch` back, then throw if any request matched no route. */
  restore(): void;
  /** Add routes. They match in registration order; a `once` route is removed after its match. */
  route(...routes: FetchMockRoute[]): WaterDataFake;
}

export function createWaterDataFake(): WaterDataFake {
  const unmatched: string[] = [];
  const requests: SentRequest[] = [];
  const http = createFetchMock([], {
    onUnhandled: (request) => {
      unmatched.push(`${request.method} ${request.url}`);
      return Promise.reject(new Error(`unmocked fetch: ${request.method} ${request.url}`));
    },
  });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const copy = new Request(input, init);
    requests.push({
      method: copy.method,
      url: new URL(copy.url),
      headers: new Headers(copy.headers),
    });
    return http.fetch(input, init);
  };
  let previous: typeof globalThis.fetch | undefined;
  const fake: WaterDataFake = {
    requests,
    install() {
      if (previous) return;
      previous = globalThis.fetch;
      globalThis.fetch = fetch;
    },
    restore() {
      if (previous) globalThis.fetch = previous;
      previous = undefined;
      if (unmatched.length > 0)
        throw new Error(`Requests matched no route:\n${unmatched.join('\n')}`);
    },
    route(...routes) {
      http.route(...routes);
      return fake;
    },
  };
  return fake;
}

/**
 * Query pairs a route requires: a string must equal the URL's value, `null` must be absent, and
 * `true` must be present at least once, with any value.
 */
export type QueryMatch = Readonly<Record<string, string | null | true>>;

interface RouteOptions {
  once?: boolean;
  query?: QueryMatch;
}

function matchesQuery(url: URL, query: QueryMatch | undefined): boolean {
  if (!query) return true;
  return Object.entries(query).every(([key, value]) => {
    if (value === null) return !url.searchParams.has(key);
    if (value === true) return url.searchParams.has(key);
    return url.searchParams.get(key) === value;
  });
}

function getRoute(
  path: string,
  respond: FetchMockResponder,
  { once, query }: RouteOptions,
): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => {
      const url = new URL(request.url);
      return url.origin === ORIGIN && url.pathname === path && matchesQuery(url, query);
    },
    respond,
    ...(once ? { once } : {}),
  };
}

/**
 * GET requests to one OGC collection's `items` — or to `items/<item>` when `item` is given —
 * whose query carries every pair in `query`.
 */
export function ogcRoute(
  collection: string,
  respond: FetchMockResponder,
  options: RouteOptions & { item?: string } = {},
): FetchMockRoute {
  const items = `${OGC_PATH}/${collection}/items`;
  return getRoute(options.item ? `${items}/${options.item}` : items, respond, options);
}

/** GET requests to one Statistics API endpoint whose query carries every pair in `query`. */
export function statisticsRoute(
  endpoint: 'observationIntervals' | 'observationNormals',
  respond: FetchMockResponder,
  options: RouteOptions = {},
): FetchMockRoute {
  return getRoute(`${STATISTICS_PATH}/${endpoint}`, respond, options);
}

/** A file from `tests/fixtures/waterdata/`, as text. */
export function waterDataFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/waterdata/${name}`, import.meta.url), 'utf8');
}

/** A JSON response — status 200 unless `init` says otherwise. A string body is sent as written. */
export function jsonResponse(
  body: unknown,
  init: { headers?: Record<string, string>; status?: number } = {},
): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

/** An OGC `FeatureCollection` body; `next` becomes its `rel: "next"` link. */
export function ogcPage(features: readonly unknown[], next?: string) {
  return {
    type: 'FeatureCollection',
    features,
    numberReturned: features.length,
    links: next ? [{ rel: 'next', href: next, type: 'application/geo+json' }] : [],
  };
}

/** The gateway's captured 429: `OVER_RATE_LIMIT` body, `retry-after`, and the hourly limit. */
export function rateLimitResponse(retryAfterSeconds: number, limitPerHour = 1000): Response {
  return jsonResponse(waterDataFixture('error-429-over-rate-limit.json'), {
    status: 429,
    headers: {
      'retry-after': String(retryAfterSeconds),
      'x-ratelimit-limit': String(limitPerHour),
      'x-ratelimit-remaining': '0',
    },
  });
}

/** Never answers: rejects only when the request's signal aborts (a timeout or a cancellation). */
export const stalled: FetchMockResponder = (request) =>
  new Promise<Response>((_resolve, reject) => {
    if (request.signal.aborted) reject(request.signal.reason);
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
  });

/** Sends 200 headers, then a body that never finishes until the request's signal aborts. */
export const stalledBody: FetchMockResponder = (request) =>
  new Response(
    new ReadableStream({
      start(controller) {
        request.signal.addEventListener('abort', () => controller.error(request.signal.reason), {
          once: true,
        });
      },
    }),
  );

/**
 * The parameter-code catalog, captured as two pages: real records trimmed from the live collection
 * to the curated codes plus every match for the queries the tests run. Page 1's `next` link asks
 * for page 2 by `offset`, as the live collection does when a page does not hold every record.
 */
const CATALOG_PAGE_1 = 'parameter-codes-page-1.json';
const CATALOG_PAGE_2 = 'parameter-codes-page-2.json';

/** The `offset` page 1's `next` link asks for. */
export const PAGE_2_OFFSET = (
  JSON.parse(waterDataFixture(CATALOG_PAGE_1)) as { numberReturned: number }
).numberReturned;

/** Number of records across both captured catalog pages. */
export const CATALOG_RECORD_COUNT =
  PAGE_2_OFFSET +
  (JSON.parse(waterDataFixture(CATALOG_PAGE_2)) as { numberReturned: number }).numberReturned;

/** Routes serving both catalog pages; the first page's `next` link leads to the second. */
export function catalogRoutes(): FetchMockRoute[] {
  return [
    ogcRoute('parameter-codes', () => jsonResponse(waterDataFixture(CATALOG_PAGE_1)), {
      query: { f: 'json', offset: null },
    }),
    ogcRoute('parameter-codes', () => jsonResponse(waterDataFixture(CATALOG_PAGE_2)), {
      query: { f: 'json', offset: String(PAGE_2_OFFSET) },
    }),
  ];
}

/** A route answering the first catalog page with the given status and body. */
export function failingCatalogRoute(status: number, body = ''): FetchMockRoute {
  return ogcRoute('parameter-codes', () => new Response(body, { status }), {
    query: { f: 'json', offset: null },
  });
}

/** An OGC feature as the captures hold it. */
export interface OgcFeature {
  id?: string;
  properties: Record<string, unknown>;
}

/** The values of each `property IN ('a','b',…)` clause of a cql2-text `filter`, by property. */
export function cqlInValues(filter: string | null): Map<string, string[]> {
  const clauses = new Map<string, string[]>();
  for (const [, property = '', list = ''] of (filter ?? '').matchAll(/(\w+) IN \(([^)]*)\)/g)) {
    clauses.set(
      property,
      list.split(',').map((value) => value.slice(1, -1).replaceAll("''", "'")),
    );
  }
  return clauses;
}

/**
 * An OGC responder serving the `features` whose `monitoring_location_id` the request's cql2-text
 * `monitoring_location_id IN (…)` clause names, as one page — how a batched read by location is
 * answered.
 */
export function locationFilteredResponder(
  features: readonly OgcFeature[],
): (request: Request) => Response {
  return (request) => {
    const filter = new URL(request.url).searchParams.get('filter');
    const named = new Set(cqlInValues(filter).get('monitoring_location_id'));
    return jsonResponse(
      ogcPage(features.filter((f) => named.has(String(f.properties.monitoring_location_id)))),
    );
  };
}

/**
 * The rows of a per-site daily-mean metadata capture
 * (`time-series-metadata-daily-mean-<site>-<parameterCd>.json`), each stamped with the site's
 * `monitoring_location_id` — the property the live collection adds when `properties` names it.
 * Captured one site at a time, every row is that site's.
 */
export function dailyMeanCapture(
  site: string,
  parameterCd: string,
  monitoringLocationId = `USGS-${site}`,
): OgcFeature[] {
  const body = JSON.parse(
    waterDataFixture(`time-series-metadata-daily-mean-${site}-${parameterCd}.json`),
  ) as { features: OgcFeature[] };
  return body.features.map((feature) => ({
    ...feature,
    properties: { monitoring_location_id: monitoringLocationId, ...feature.properties },
  }));
}

/** A Statistics API body: one feature per location, its series under `data`. */
export interface StatisticsBody {
  features: {
    properties: {
      data: { parent_time_series_id: string }[];
      monitoring_location_id: string;
    };
  }[];
}

/**
 * A Statistics API responder answering a batched read from captured bodies — fixture names or
 * parsed bodies, each already for one parameter (and, for normals, one calendar day) — the way the
 * live API does: the features of the locations the request repeats under `monitoring_location_id`
 * (every feature when it names none), each keeping only the series it repeats under
 * `parent_time_series_id` (every series when it names none). A feature that series filter leaves
 * empty is dropped, as is a location the captures lack. One page, `next: null`.
 */
export function statisticsBatchResponder(
  captures: readonly (string | StatisticsBody)[],
): (request: Request) => Response {
  const features = captures.flatMap(
    (capture) =>
      (typeof capture === 'string'
        ? (JSON.parse(waterDataFixture(capture)) as StatisticsBody)
        : capture
      ).features,
  );
  return (request) => {
    const params = new URL(request.url).searchParams;
    const locations = new Set(params.getAll('monitoring_location_id'));
    const series = new Set(params.getAll('parent_time_series_id'));
    const answered = features.flatMap((feature) => {
      const { properties } = feature;
      if (locations.size > 0 && !locations.has(properties.monitoring_location_id)) return [];
      if (series.size === 0) return [feature];
      const data = properties.data.filter((s) => series.has(s.parent_time_series_id));
      return data.length > 0 ? [{ ...feature, properties: { ...properties, data } }] : [];
    });
    return jsonResponse({ type: 'FeatureCollection', features: answered, next: null });
  };
}

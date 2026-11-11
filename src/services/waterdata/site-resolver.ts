/**
 * @fileoverview Resolve bare site numbers to their OGC `monitoring_location_id` whatever the
 * agency (`USGS-01646500`, `MO005-364643089212301`), with name and time zone, behind a bounded TTL
 * cache and one shared request per number in flight. Callers pass the numbers WaterServices took;
 * the OGC collections need the agency prefix.
 * @module services/waterdata/site-resolver
 */

import { z } from '@cyanheads/mcp-ts-core';
import { type SiteTimeZone, siteTimeZone } from './site-local-time.js';
import { fetchOgcItems, type WaterDataRequest } from './water-data-client.js';

/** A monitoring location, identified the way every OGC collection and the Statistics API need. */
export interface ResolvedSite {
  agencyCode: string;
  /** Agency-prefixed identifier: `USGS-01646500`, `MO005-364643089212301`. */
  monitoringLocationId: string;
  siteName: string | null;
  siteNumber: string;
  /** Null when the location carries no time zone, or one this server cannot convert. */
  timeZone: SiteTimeZone | null;
}

/** Numbers per request — the most any tool asks for at once (`water_get_readings` takes 100). */
const BATCH_SIZE = 100;
/** Site identity and time zone change rarely; a day bounds how long an edit takes to show. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 5_000;

const LocationSchema = z.object({
  id: z.string().min(1),
  properties: z.object({
    monitoring_location_number: z.string(),
    monitoring_location_name: z.string().nullish(),
    agency_code: z.string(),
    time_zone_abbreviation: z.string().nullish(),
    uses_daylight_savings: z.string().nullish(),
  }),
});

const cache = new Map<string, { expiresAt: number; site: ResolvedSite }>();

function cached(siteNumber: string): ResolvedSite | undefined {
  const entry = cache.get(siteNumber);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(siteNumber);
    return undefined;
  }
  return entry.site;
}

function remember(site: ResolvedSite): void {
  cache.delete(site.siteNumber);
  cache.set(site.siteNumber, { site, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * When one number is registered under several agencies, the USGS record wins — it is the one a
 * WaterServices caller meant — and otherwise the lowest identifier, so the choice is stable.
 */
function preferred(a: ResolvedSite, b: ResolvedSite): ResolvedSite {
  if ((a.agencyCode === 'USGS') !== (b.agencyCode === 'USGS'))
    return a.agencyCode === 'USGS' ? a : b;
  return a.monitoringLocationId <= b.monitoringLocationId ? a : b;
}

/** The locations of one batch of numbers, keyed by number; a number with none is absent. */
async function fetchBatch(
  numbers: readonly string[],
  request: WaterDataRequest,
): Promise<Map<string, ResolvedSite>> {
  const query = new URLSearchParams({
    skipGeometry: 'true',
    monitoring_location_number: numbers.join(','),
    properties:
      'monitoring_location_number,monitoring_location_name,agency_code,time_zone_abbreviation,uses_daylight_savings',
    limit: '1000',
  });
  const features = await fetchOgcItems('monitoring-locations', query, LocationSchema, request);
  const asked = new Set(numbers);
  const found = new Map<string, ResolvedSite>();
  for (const { id, properties: p } of features) {
    if (!asked.has(p.monitoring_location_number)) continue;
    const site: ResolvedSite = {
      agencyCode: p.agency_code,
      monitoringLocationId: id,
      siteName: p.monitoring_location_name ?? null,
      siteNumber: p.monitoring_location_number,
      timeZone: siteTimeZone(p.time_zone_abbreviation, p.uses_daylight_savings),
    };
    const prior = found.get(site.siteNumber);
    found.set(site.siteNumber, prior ? preferred(prior, site) : site);
  }
  return found;
}

/** A batch request other calls for the same numbers wait on instead of sending their own. */
interface InFlightLoad {
  load: Promise<Map<string, ResolvedSite>>;
  /** The starting call's signal: its cancellation fails the load for everyone waiting on it. */
  signal: AbortSignal | undefined;
}

const inFlight = new Map<string, InFlightLoad>();

/** Load one batch for this call, letting concurrent calls for its numbers share the request. */
async function loadBatch(
  numbers: readonly string[],
  request: WaterDataRequest,
  resolved: Map<string, ResolvedSite>,
): Promise<void> {
  const entry: InFlightLoad = { load: fetchBatch(numbers, request), signal: request.signal };
  for (const number of numbers) inFlight.set(number, entry);
  try {
    for (const site of (await entry.load).values()) {
      remember(site);
      resolved.set(site.siteNumber, site);
    }
  } finally {
    for (const number of numbers) if (inFlight.get(number) === entry) inFlight.delete(number);
  }
}

/** Wait for `promise`, giving up at once with the reason when `signal` aborts first. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  return Promise.race([promise, aborted]);
}

/**
 * Wait on another call's load for `numbers`. When that call was cancelled and this one was not,
 * the numbers go to `retry` for this call to load itself.
 */
async function joinLoad(
  entry: InFlightLoad,
  numbers: readonly string[],
  request: WaterDataRequest,
  resolved: Map<string, ResolvedSite>,
  retry: string[],
): Promise<void> {
  let found: Map<string, ResolvedSite>;
  try {
    found = await untilAborted(entry.load, request.signal);
  } catch (error) {
    if (!entry.signal?.aborted || request.signal?.aborted) throw error;
    retry.push(...numbers);
    return;
  }
  for (const number of numbers) {
    const site = found.get(number);
    if (site) resolved.set(number, site);
  }
}

/**
 * Resolve site numbers to monitoring locations. Numbers are matched exactly (the upstream filter
 * is not a prefix match); a number with no location is absent from the result, so the caller
 * decides between `not_found` and a `missingSites` entry. Cached hits cost no request; a number
 * another call is already loading waits on that request; the rest are fetched 100 numbers per
 * request. Misses are never cached.
 *
 * @throws {McpError} whatever the Water Data client raises (rate limit, timeout, upstream fault).
 */
export async function resolveSites(
  siteNumbers: readonly string[],
  request: WaterDataRequest,
): Promise<Map<string, ResolvedSite>> {
  const resolved = new Map<string, ResolvedSite>();
  const missing: string[] = [];
  const joined = new Map<InFlightLoad, string[]>();
  for (const number of new Set(siteNumbers)) {
    const hit = cached(number);
    const pending = hit ? undefined : inFlight.get(number);
    if (hit) resolved.set(number, hit);
    else if (pending) joined.set(pending, [...(joined.get(pending) ?? []), number]);
    else missing.push(number);
  }
  const loads: Promise<void>[] = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    loads.push(loadBatch(missing.slice(i, i + BATCH_SIZE), request, resolved));
  }
  const retry: string[] = [];
  for (const [entry, numbers] of joined) {
    loads.push(joinLoad(entry, numbers, request, resolved, retry));
  }
  await Promise.all(loads);
  if (retry.length > 0) {
    for (const [number, site] of await resolveSites(retry, request)) resolved.set(number, site);
  }
  return resolved;
}

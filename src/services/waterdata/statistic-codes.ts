/**
 * @fileoverview Names of the USGS statistic codes, read from the `statistic-codes` collection in one
 * request and cached for 24 hours: the `statName` a daily series reports ("Mean" for 00003).
 * @module services/waterdata/statistic-codes
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { startDeadline } from './request-deadline.js';
import { fetchOgcItems } from './water-data-client.js';

/** The code table changes rarely; a day bounds how long a new code takes to show. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const StatisticCodeSchema = z.object({
  id: z.string().min(1),
  properties: z.object({ statistic_name: z.string().nullish() }),
});

let cache: { fetchedAt: number; names: ReadonlyMap<string, string> } | undefined;
let inFlight: Promise<ReadonlyMap<string, string>> | undefined;

/**
 * WaterServices wrote a statistic's name in sentence case ("Maximum"); the collection writes it in
 * capitals ("MAXIMUM").
 */
function sentenceCase(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
}

/**
 * The one request shared by every caller waiting on it, so it carries no caller's signal — one
 * caller cancelling must not fail the others — and runs on its own deadline.
 */
async function load(ctx: Context): Promise<ReadonlyMap<string, string>> {
  const features = await fetchOgcItems(
    'statistic-codes',
    new URLSearchParams({ limit: '5000', skipGeometry: 'true', properties: 'statistic_name' }),
    StatisticCodeSchema,
    { ctx, deadline: startDeadline(), operation: 'getStatisticNames', signal: undefined },
  );
  const names = new Map<string, string>();
  for (const { id, properties } of features) {
    if (properties.statistic_name) names.set(id, sentenceCase(properties.statistic_name));
  }
  return names;
}

/**
 * Statistic code → name ("00003" → "Mean"). Served from the cache while it is younger than 24
 * hours; otherwise fetched, with concurrent callers sharing one request. A failed read is never
 * cached, so the next call tries again.
 *
 * @throws {McpError} whatever the Water Data client raises for the read.
 */
export function getStatisticNames(ctx: Context): Promise<ReadonlyMap<string, string>> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cache.names);
  inFlight ??= load(ctx)
    .then((names) => {
      cache = { names, fetchedAt: Date.now() };
      return names;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

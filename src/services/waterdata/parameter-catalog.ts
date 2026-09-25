/**
 * @fileoverview Reader and local search for the full USGS parameter-code catalog, served by the
 * USGS Water Data OGC API (`collections/parameter-codes`). The whole catalog (~19,600 codes) is read
 * in one request, cached in module scope for 24 hours, and searched in memory.
 * @module services/waterdata/parameter-catalog
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '@/config/server-config.js';
import { CURATED_PARAMETERS, type CuratedParameter } from './curated-parameters.js';

/**
 * First page of the catalog. `limit` exceeds the collection size, so one page normally holds
 * every record; `properties` trims each record to the three fields the search reads.
 */
const CATALOG_URL =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/parameter-codes/items?f=json&limit=50000&properties=parameter_name,unit_of_measure,parameter_description';

/** How long a fetched catalog is served before the next read refetches — upstream's `max-age`. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** One record of the USGS parameter-code catalog. */
export interface CatalogParameter {
  /** 5-digit USGS parameter code. */
  code: string;
  /** Long-form description (e.g. "Discharge, cubic feet per second"). */
  description: string;
  /** Short parameter name (e.g. "Discharge"). */
  name: string;
  /** Unit of measure as the catalog writes it (e.g. "ft3/s"). */
  unit: string;
}

/** A search result: a curated entry, or a catalog record for a code outside the curated table. */
export type ParameterEntry =
  | (CuratedParameter & { source: 'curated' })
  | (CatalogParameter & { source: 'usgs-catalog' });

/** The fields of one catalog page this reader relies on. */
const CatalogPageSchema = z.object({
  features: z.array(
    z.object({
      id: z.string(),
      properties: z.object({
        parameter_name: z.string().nullish(),
        unit_of_measure: z.string().nullish(),
        parameter_description: z.string().nullish(),
      }),
    }),
  ),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});

let cache: { catalog: readonly CatalogParameter[]; fetchedAt: number } | undefined;
let inFlight: Promise<readonly CatalogParameter[]> | undefined;

/**
 * The full parameter-code catalog, sorted by code. Served from the module-scope cache while it is
 * younger than 24 hours; otherwise fetched, with concurrent callers sharing one fetch. A failed
 * fetch is never cached, so the next call tries again.
 *
 * @throws {McpError} `ServiceUnavailable` when any page fails, times out, or is not a catalog page.
 */
export function getParameterCatalog(ctx: Context): Promise<readonly CatalogParameter[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cache.catalog);
  inFlight ??= fetchCatalog(ctx)
    .then((catalog) => {
      cache = { catalog, fetchedAt: Date.now() };
      return catalog;
    })
    .finally(() => {
      inFlight = undefined;
    });
  return inFlight;
}

/**
 * The catalog HTML-encodes `<` and `>` in its text ("bed sediment &lt;63 microns") — the only
 * entities it carries.
 */
function decodeAngleBrackets(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

/**
 * Read every catalog page, following `next` links. The shared fetch carries no caller's abort
 * signal — one caller cancelling must not fail the others waiting on it — so the configured
 * timeout alone bounds each page.
 */
async function fetchCatalog(ctx: Context): Promise<CatalogParameter[]> {
  const cfg = getServerConfig();
  const records: CatalogParameter[] = [];
  let url: string | undefined = CATALOG_URL;
  try {
    while (url) {
      const response = await fetchWithTimeout(url, cfg.requestTimeoutMs, ctx, {
        headers: { 'User-Agent': cfg.userAgent, Accept: 'application/json' },
      });
      const page = CatalogPageSchema.parse(await response.json());
      for (const { id, properties: p } of page.features) {
        records.push({
          code: id,
          name: decodeAngleBrackets(p.parameter_name ?? ''),
          unit: decodeAngleBrackets(p.unit_of_measure ?? ''),
          description: decodeAngleBrackets(p.parameter_description ?? ''),
        });
      }
      url = page.links?.find((link) => link.rel === 'next')?.href;
    }
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    throw serviceUnavailable(
      `The USGS parameter-code catalog could not be read: ${detail}`,
      { url },
      { cause: err },
    );
  }
  ctx.log.debug('Parameter-code catalog fetched', { records: records.length });
  return records.sort((a, b) => a.code.localeCompare(b.code));
}

/** Lowercased letter/digit runs of a query — its search tokens. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/**
 * A test for "this token starts a word" — preceded by the start of text or a non-letter/digit. A
 * token is a run of letters and digits (see {@link tokenize}), so it carries no regex syntax.
 */
function wordStart(token: string): RegExp {
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${token}`, 'iu');
}

/**
 * Search the catalog and the curated table.
 *
 * A bare 5-digit query matches that code alone. Otherwise every token must start a word in the
 * name or the description (case-insensitive); a query with no letters or digits matches nothing.
 * Results run: curated entries that match (by their own name or their catalog record), in curated
 * order, each once; then catalog records whose name holds every token; then description-only
 * matches — both by code.
 */
export function searchParameters(
  catalog: readonly CatalogParameter[],
  query: string,
): ParameterEntry[] {
  const trimmed = query.trim();
  const curatedCodes = new Set(CURATED_PARAMETERS.map((p) => p.code));
  const catalogOnly = catalog.filter((r) => !curatedCodes.has(r.code));
  const curated = (p: CuratedParameter): ParameterEntry => ({ ...p, source: 'curated' });
  const fromCatalog = (r: CatalogParameter): ParameterEntry => ({ ...r, source: 'usgs-catalog' });

  if (/^\d{5}$/.test(trimmed)) {
    return [
      ...CURATED_PARAMETERS.filter((p) => p.code === trimmed).map(curated),
      ...catalogOnly.filter((r) => r.code === trimmed).map(fromCatalog),
    ];
  }

  const patterns = tokenize(trimmed).map(wordStart);
  if (patterns.length === 0) return [];
  const inName = (r: { name: string }) => patterns.every((p) => p.test(r.name));
  const matches = (r: CatalogParameter) =>
    patterns.every((p) => p.test(r.name) || p.test(r.description));

  const byCode = new Map(catalog.map((r) => [r.code, r]));
  const curatedMatches = CURATED_PARAMETERS.filter((p) => {
    const record = byCode.get(p.code);
    return inName(p) || (record !== undefined && matches(record));
  });
  const catalogMatches = catalogOnly.filter(matches);
  return [
    ...curatedMatches.map(curated),
    ...catalogMatches.filter(inName).map(fromCatalog),
    ...catalogMatches.filter((r) => !inName(r)).map(fromCatalog),
  ];
}

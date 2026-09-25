/**
 * @fileoverview Test helpers for driving the USGS parameter-code catalog reader against captured
 * upstream pages. `tests/fixtures/waterdata/parameter-codes-page-{1,2}.json` hold real catalog
 * records, trimmed from the live collection to the curated codes plus every match for the queries
 * the tests run: page 1 carries a `next` link to page 2, as the live collection does when a page
 * does not hold every record.
 * @module tests/helpers/waterdata-fixtures
 */

import { readFileSync } from 'node:fs';
import type { FetchMockRoute } from '@cyanheads/mcp-ts-core/testing';

const ITEMS_PATH = '/ogcapi/v1/collections/parameter-codes/items';

/** Read a captured catalog page by file name. */
export function catalogFixture(name: string): string {
  return readFileSync(new URL(`../fixtures/waterdata/${name}`, import.meta.url), 'utf8');
}

/** The `offset` page 1's `next` link asks for. */
export const PAGE_2_OFFSET = (
  JSON.parse(catalogFixture('parameter-codes-page-1.json')) as { numberReturned: number }
).numberReturned;

/** Number of records across both captured pages. */
export const CATALOG_RECORD_COUNT =
  PAGE_2_OFFSET +
  (JSON.parse(catalogFixture('parameter-codes-page-2.json')) as { numberReturned: number })
    .numberReturned;

/** True for a catalog items request carrying the given `offset` (none for the first page). */
function isPage(request: Request, offset: number | undefined): boolean {
  const url = new URL(request.url);
  return (
    url.hostname === 'api.waterdata.usgs.gov' &&
    url.pathname === ITEMS_PATH &&
    url.searchParams.get('f') === 'json' &&
    url.searchParams.get('offset') === (offset === undefined ? null : String(offset))
  );
}

/** Routes serving both captured pages; the first page's `next` link leads to the second. */
export function catalogRoutes(): FetchMockRoute[] {
  return [
    {
      method: 'GET',
      match: (request) => isPage(request, undefined),
      respond: () => new Response(catalogFixture('parameter-codes-page-1.json'), { status: 200 }),
    },
    {
      method: 'GET',
      match: (request) => isPage(request, PAGE_2_OFFSET),
      respond: () => new Response(catalogFixture('parameter-codes-page-2.json'), { status: 200 }),
    },
  ];
}

/** A route answering the first catalog page with the given status and body. */
export function failingCatalogRoute(status: number, body = ''): FetchMockRoute {
  return {
    method: 'GET',
    match: (request) => isPage(request, undefined),
    respond: () => new Response(body, { status }),
  };
}

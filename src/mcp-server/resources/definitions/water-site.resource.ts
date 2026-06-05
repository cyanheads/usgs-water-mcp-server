/**
 * @fileoverview Resource definition for a single USGS monitoring site by site number.
 * Stable URI for site metadata including name, coordinates, type, HUC, and available parameters.
 * @module mcp-server/resources/definitions/water-site.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { getSiteInfo } from '@/services/nwis/nwis-service.js';

export const waterSiteResource = resource('usgs-water://site/{siteId}', {
  name: 'usgs-water-site',
  description:
    'Site metadata for a USGS monitoring site: name, coordinates, type, HUC watershed code, ' +
    'state, county, and available data types. Use water_find_sites to discover site numbers.',
  mimeType: 'application/json',
  params: z.object({
    siteId: z.string().describe('USGS site number (8–15 digits, e.g. "01646500").'),
  }),

  async handler(params, ctx) {
    ctx.log.info('Fetching site metadata', { siteId: params.siteId });

    let site: Awaited<ReturnType<typeof getSiteInfo>>;
    try {
      site = await getSiteInfo(params.siteId, ctx.signal);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('unavailable') || msg.includes('ServiceUnavailable')) {
        throw serviceUnavailable(
          `USGS service temporarily unavailable: ${msg}`,
          {},
          { cause: err },
        );
      }
      throw err;
    }

    if (!site) {
      throw notFound(`Site ${params.siteId} not found.`, { siteId: params.siteId });
    }

    return site;
  },

  list: () => ({
    resources: [
      {
        uri: 'usgs-water://site/01646500',
        name: 'Potomac River at Little Falls, MD',
        mimeType: 'application/json',
      },
      {
        uri: 'usgs-water://site/14211720',
        name: 'Willamette River at Portland, OR',
        mimeType: 'application/json',
      },
      {
        uri: 'usgs-water://site/09380000',
        name: 'Colorado River at Lees Ferry, AZ',
        mimeType: 'application/json',
      },
    ],
  }),
});

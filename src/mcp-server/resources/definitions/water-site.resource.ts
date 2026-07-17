/**
 * @fileoverview Resource definition for a single USGS monitoring site by site number.
 * Stable URI for site metadata including name, coordinates, type, HUC, state, county, and altitude.
 * @module mcp-server/resources/definitions/water-site.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { SiteNumberSchema } from '@/services/nwis/input-schemas.js';
import { classifyNwisFailure, getSiteInfo } from '@/services/nwis/nwis-service.js';

export const waterSiteResource = resource('usgs-water://site/{siteId}', {
  name: 'usgs-water-site',
  description:
    'Site metadata for a USGS monitoring site: name, coordinates, type, HUC watershed code, ' +
    'state, county, drainage area, and altitude. Use water_find_sites to discover site numbers.',
  mimeType: 'application/json',
  params: z.object({
    siteId: SiteNumberSchema.describe('USGS site number (8–15 digits, e.g. "01646500").'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No USGS site exists for the given (well-formed) site number.',
      recovery: 'Verify the site number with water_find_sites.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NWIS rejected the site number. The 8–15 digit format is validated at the resource edge, so this surfaces a well-formed value NWIS still refused.',
      recovery:
        'Read the NWIS message in this error, or verify the site number with water_find_sites.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NWIS returned a 5xx error or the request timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(params, ctx) {
    ctx.log.info('Fetching site metadata', { siteId: params.siteId });

    let site: Awaited<ReturnType<typeof getSiteInfo>>;
    try {
      site = await getSiteInfo(params.siteId, ctx.signal);
    } catch (err: unknown) {
      const failure = classifyNwisFailure(err);
      if (failure) throw ctx.fail(failure.reason, failure.message, undefined, { cause: err });
      throw err;
    }

    if (!site) {
      throw ctx.fail('not_found', `Site ${params.siteId} not found.`, { siteId: params.siteId });
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

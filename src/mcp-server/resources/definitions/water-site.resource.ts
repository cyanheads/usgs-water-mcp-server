/**
 * @fileoverview Resource definition for a single USGS monitoring site by site number, whichever
 * agency holds it. Stable URI for site metadata including name, coordinates, type, HUC, state,
 * county, and altitude.
 * @module mcp-server/resources/definitions/water-site.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { SiteNumberSchema } from '@/services/waterdata/input-schemas.js';
import { getSite } from '@/services/waterdata/site-discovery.js';
import { startRequest } from '@/services/waterdata/water-data-client.js';
import { classifyWaterDataFailure } from '@/services/waterdata/water-data-errors.js';

export const waterSiteResource = resource('usgs-water://site/{siteId}', {
  name: 'usgs-water-site',
  description:
    'Site metadata for a USGS monitoring site, any agency: name, coordinates, type, HUC watershed code, state, county, drainage area, and altitude. Use water_find_sites to discover site numbers.',
  mimeType: 'application/json',
  params: z.object({
    siteId: SiteNumberSchema.describe('USGS site number (8–15 digits, e.g. "01646500").'),
  }),

  errors: [
    {
      reason: 'not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No monitoring location, under any agency, has the given (well-formed) site number.',
      recovery:
        'Check the site number with water_get_site_data_catalog — its not_found is authoritative for every agency, and its series show what the site measured.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The USGS Water Data API refused the query. The 8–15 digit format is validated at the resource edge, so this surfaces a well-formed value the API still refused.',
      recovery:
        "Read the API's message in this error, then check the site number with water_get_site_data_catalog.",
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS Water Data API failed after retries or sent a response this server could not read.',
      recovery:
        'A server error usually clears: retry after a short backoff. An error marked not retryable means the upstream sent a response this server cannot read, and the same request will fail again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The site lookup ran past its 45-second budget.',
      recovery: 'Retry after a short backoff to retrieve the site metadata.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    ctx.log.info('Fetching site metadata', { siteId: params.siteId });

    let site: Awaited<ReturnType<typeof getSite>>;
    try {
      site = await getSite(params.siteId, startRequest(ctx, 'getSite'));
    } catch (error: unknown) {
      if (ctx.signal?.aborted) throw error;
      // Rate limits and a rejected USGS_API_KEY classify to null and pass through with their own
      // recovery hints.
      const failure = classifyWaterDataFailure(error);
      if (!failure) throw error;
      throw ctx.fail(
        failure.reason,
        failure.message,
        { ...failure.data, ...ctx.recoveryFor(failure.reason) },
        { cause: error },
      );
    }

    if (!site) {
      throw ctx.fail('not_found', `Site ${params.siteId} not found.`, {
        siteId: params.siteId,
        ...ctx.recoveryFor('not_found'),
      });
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

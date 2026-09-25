/**
 * @fileoverview Resource definition for the curated table of well-known USGS parameter codes.
 * Injectable context for clients that support resources — the list water_list_parameters returns
 * without a query. The full USGS catalog is searched through that tool's query input.
 * @module mcp-server/resources/definitions/water-parameters.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { CURATED_PARAMETERS } from '@/services/waterdata/curated-parameters.js';

export const waterParametersResource = resource('usgs-water://parameters', {
  name: 'usgs-water-parameters',
  description:
    'Curated table of well-known USGS parameter codes — the codes most requests use (discharge, gage height, water temperature, groundwater levels, common water-quality measures), with human-readable names, units, and thematic domain. Injectable context for clients that support resources; the same list water_list_parameters returns without a query. A curated subset of the ~19,600-code USGS catalog — search the rest with water_list_parameters query.',
  mimeType: 'application/json',
  params: z.object({}).describe('No parameters — returns the curated table.'),

  handler(_params, _ctx) {
    return { parameters: CURATED_PARAMETERS, total: CURATED_PARAMETERS.length };
  },

  list: () => ({
    resources: [
      {
        uri: 'usgs-water://parameters',
        name: 'USGS Parameter Codes (curated)',
        mimeType: 'application/json',
      },
    ],
  }),
});

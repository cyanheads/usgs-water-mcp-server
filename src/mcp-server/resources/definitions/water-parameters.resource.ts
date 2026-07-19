/**
 * @fileoverview Resource definition for the full USGS parameter code catalog.
 * Injectable context for clients that support resources — the same data as water_list_parameters.
 * @module mcp-server/resources/definitions/water-parameters.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';

/** Parameter code record. */
const ParameterRecord = z.object({
  code: z.string().describe('5-digit USGS parameter code.'),
  name: z.string().describe('Human-readable parameter name.'),
  unit: z.string().describe('Unit of measure.'),
  group: z
    .enum(['streamflow', 'groundwater', 'temperature', 'meteorological', 'water-quality'])
    .describe('Thematic domain grouping.'),
});

const PARAMETERS: Array<z.infer<typeof ParameterRecord>> = [
  { code: '00060', name: 'Discharge', unit: 'ft³/s', group: 'streamflow' },
  { code: '00065', name: 'Gage height', unit: 'ft', group: 'streamflow' },
  { code: '00010', name: 'Temperature, water', unit: '°C', group: 'temperature' },
  { code: '00045', name: 'Precipitation', unit: 'in', group: 'meteorological' },
  { code: '00095', name: 'Specific conductance', unit: 'µS/cm at 25°C', group: 'water-quality' },
  { code: '00300', name: 'Dissolved oxygen', unit: 'mg/L', group: 'water-quality' },
  { code: '00400', name: 'pH', unit: 'std units', group: 'water-quality' },
  {
    code: '72019',
    name: 'Depth to water level, below land surface',
    unit: 'ft',
    group: 'groundwater',
  },
  { code: '72020', name: 'Elevation above NGVD 1929', unit: 'ft', group: 'groundwater' },
  {
    code: '72150',
    name: 'Depth to water level, below measuring point',
    unit: 'ft',
    group: 'groundwater',
  },
  { code: '62610', name: 'Groundwater level above NAVD 88', unit: 'ft', group: 'groundwater' },
];

export const waterParametersResource = resource('usgs-water://parameters', {
  name: 'usgs-water-parameters',
  description:
    'Full USGS parameter code catalog — injectable context for clients that support resources. Lists well-known parameter codes with human-readable names, units, and thematic domain. The same data is also available via the water_list_parameters tool.',
  mimeType: 'application/json',
  params: z.object({}).describe('No parameters — returns the full catalog.'),

  handler(_params, _ctx) {
    return { parameters: PARAMETERS, total: PARAMETERS.length };
  },

  list: () => ({
    resources: [
      {
        uri: 'usgs-water://parameters',
        name: 'USGS Parameter Code Catalog',
        mimeType: 'application/json',
      },
    ],
  }),
});

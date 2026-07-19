/**
 * @fileoverview Static lookup of well-known USGS parameter codes with human-readable names,
 * units, and domain. No network call — the lookup table is baked in.
 * @module mcp-server/tools/definitions/water-list-parameters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';

/** Known parameter group domains. */
const GROUP_VALUES = [
  'streamflow',
  'groundwater',
  'temperature',
  'meteorological',
  'water-quality',
  'all',
] as const;

/** A single parameter code record. */
const ParameterSchema = z.object({
  code: z.string().describe('5-digit USGS parameter code (e.g. "00060").'),
  name: z.string().describe('Human-readable parameter name (e.g. "Discharge").'),
  unit: z.string().describe('Unit of measure (e.g. "ft³/s", "ft", "°C").'),
  group: z
    .enum(['streamflow', 'groundwater', 'temperature', 'meteorological', 'water-quality'])
    .describe('Thematic domain grouping for filtering.'),
});

/** Static parameter catalog — matches the design.md Key parameter codes table. */
const PARAMETERS: Array<z.infer<typeof ParameterSchema>> = [
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

export const waterListParameters = tool('water_list_parameters', {
  description:
    'List well-known USGS parameter codes with human-readable names, units, and thematic domain — a static, built-in catalog. Use this first to discover that 00060 = "Discharge" (ft³/s), 00065 = "Gage height" (ft), 00010 = "Temperature, water" (°C), 72019 = "Depth to water level" (ft), etc. Filter by group to narrow results.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    group: z
      .enum(GROUP_VALUES)
      .default('all')
      .describe(
        'Filter by thematic domain: "streamflow", "groundwater", "temperature", "meteorological", "water-quality", or "all" (default) for the full catalog.',
      ),
  }),
  output: z.object({
    parameters: z
      .array(
        ParameterSchema.describe('A USGS parameter code entry with name, unit, and domain group.'),
      )
      .describe('Matching parameter records with code, name, unit, and group.'),
    total: z.number().describe('Number of parameters returned.'),
  }),

  handler(input, _ctx) {
    const results =
      input.group === 'all' ? PARAMETERS : PARAMETERS.filter((p) => p.group === input.group);
    return { parameters: results, total: results.length };
  },

  format(result) {
    const lines = [`**${result.total} parameter(s)**\n`];
    for (const p of result.parameters) {
      lines.push(`- \`${p.code}\` — **${p.name}** (${p.unit}) [${p.group}]`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

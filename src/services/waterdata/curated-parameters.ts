/**
 * @fileoverview The curated table of well-known USGS parameter codes — the codes the other tools'
 * examples use, grouped by thematic domain. Shared by `water_list_parameters` and the
 * `usgs-water://parameters` resource. Names follow the USGS parameter-code catalog's descriptions;
 * units are written for display.
 * @module services/waterdata/curated-parameters
 */

/** Thematic domains the curated codes are grouped into. */
export const PARAMETER_GROUPS = [
  'streamflow',
  'groundwater',
  'temperature',
  'meteorological',
  'water-quality',
] as const;

/** A thematic domain of the curated table. */
export type ParameterGroup = (typeof PARAMETER_GROUPS)[number];

/** One curated parameter code. */
export interface CuratedParameter {
  /** 5-digit USGS parameter code. */
  code: string;
  /** Thematic domain. */
  group: ParameterGroup;
  /** Human-readable parameter name. */
  name: string;
  /** Unit of measure, written for display (e.g. "ft³/s"). */
  unit: string;
}

/** The curated parameter codes, in display order. */
export const CURATED_PARAMETERS: readonly CuratedParameter[] = [
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
  { code: '72150', name: 'Groundwater level above LMSL', unit: 'ft', group: 'groundwater' },
  { code: '62610', name: 'Groundwater level above NGVD 1929', unit: 'ft', group: 'groundwater' },
];

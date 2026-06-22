#!/usr/bin/env node
/**
 * @fileoverview usgs-water-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import {
  waterParametersResource,
  waterSiteResource,
} from './mcp-server/resources/definitions/index.js';
import {
  waterDataframeDescribe,
  waterDataframeQuery,
  waterFindSites,
  waterGetConditions,
  waterGetReadings,
  waterGetSeries,
  waterListParameters,
} from './mcp-server/tools/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';

await createApp({
  name: 'usgs-water-mcp-server',
  title: 'usgs-water-mcp-server',
  tools: [
    waterListParameters,
    waterFindSites,
    waterGetReadings,
    waterGetSeries,
    waterGetConditions,
    waterDataframeQuery,
    waterDataframeDescribe,
  ],
  resources: [waterSiteResource, waterParametersResource],
  prompts: [],
  instructions:
    'USGS Water Data MCP server — access real-time and historical water data from ~8,000 active ' +
    'USGS stream gages and groundwater wells across the US and territories.\n' +
    '- Start with water_list_parameters to discover parameter codes (00060=Discharge, 00065=GageHeight)\n' +
    '- Use water_find_sites to find sites by bbox, state, county, or HUC watershed\n' +
    '- water_get_readings returns the latest ~15-min real-time values for up to 100 sites\n' +
    '- water_get_series returns a historical daily or instantaneous time series; large ranges spill to ' +
    'DataCanvas, queryable via water_dataframe_query when enabled on this server instance\n' +
    '- water_get_conditions gives a current reading ranked against the full period-of-record percentiles\n' +
    '- Groundwater depth (parameter 72019) uses the standard IV service — gwlevels was decommissioned Nov 2025',
  setup(core) {
    setCanvas(core.canvas);
  },
});

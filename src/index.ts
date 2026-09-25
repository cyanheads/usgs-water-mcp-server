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
  instructions: `USGS Water Data MCP server — access real-time and historical water data from ~8,000 active USGS stream gages and groundwater wells across the US and territories.
- Start with water_list_parameters to discover parameter codes (00060=Discharge, 00065=Gage height); pass its query to search the full USGS parameter-code catalog for codes beyond the common ones (turbidity, nitrate, chlorophyll, suspended sediment)
- Use water_find_sites to find sites by bbox, state, county, or HUC watershed
- water_get_readings returns the latest ~15-min real-time values for up to 100 sites, one series per sensor (method) when a site measures a parameter more than one way
- water_get_series returns one historical daily or instantaneous series, most recent records inline — the daily mean by default, with statCd and methodId to pick another statistic or sensor from those listed in otherSeries; large ranges spill the complete series to DataCanvas when enabled on this server instance — inspect the staged table with water_dataframe_describe, then read it with water_dataframe_query
- water_get_conditions gives a current reading ranked against the full period-of-record percentiles
- Groundwater depth (parameter 72019) uses the standard IV service — gwlevels was decommissioned Nov 2025`,

  /**
   * Every tool here answers from the USGS response alone — none calls
   * `ctx.requestInput`, so no handler needs a session to come back to.
   * Declaring the posture in `src/` keeps it with the code rather than only in
   * `.env.example` and the Dockerfile; `MCP_SESSION_MODE` still wins when set.
   */
  sessionMode: 'stateless',

  setup(core) {
    setCanvas(core.canvas);
  },
});

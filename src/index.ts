#!/usr/bin/env node
/**
 * @fileoverview usgs-water-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { normalizeEnv, parseConfig, resetConfig } from '@cyanheads/mcp-ts-core/config';
import { getServerConfig } from './config/server-config.js';
import {
  waterParametersResource,
  waterSiteResource,
} from './mcp-server/resources/definitions/index.js';
import { setCanvas } from './services/canvas/canvas-accessor.js';

// parseConfig() is what loads ./.env under Node (Bun loads it on its own).
parseConfig();
// DataCanvas defaults on; set CANVAS_PROVIDER_TYPE=none to disable it.
process.env.CANVAS_PROVIDER_TYPE =
  normalizeEnv({ provider: process.env.CANVAS_PROVIDER_TYPE }).provider ?? 'duckdb';
resetConfig();

/**
 * Imported after parseConfig(): water_dataframe_drop decides at module load whether it registers
 * as callable, from WATER_DATAFRAME_DROP_ENABLED, so a static import would read the flag before
 * a .env value reaches process.env under Node.
 */
const {
  waterDataframeDescribe,
  waterDataframeDrop,
  waterDataframeQuery,
  waterFindSites,
  waterGetConditions,
  waterGetReadings,
  waterGetSeries,
  waterGetSiteDataCatalog,
  waterListParameters,
} = await import('./mcp-server/tools/definitions/index.js');

await createApp({
  name: 'usgs-water-mcp-server',
  title: 'usgs-water-mcp-server',
  tools: [
    waterListParameters,
    waterFindSites,
    waterGetReadings,
    waterGetSeries,
    waterGetSiteDataCatalog,
    waterGetConditions,
    waterDataframeQuery,
    waterDataframeDescribe,
    waterDataframeDrop,
  ],
  resources: [waterSiteResource, waterParametersResource],
  prompts: [],
  instructions: `USGS Water Data MCP server — access real-time and historical water data from ~8,000 active USGS stream gages and groundwater wells across the US and territories.
- Start with water_list_parameters to discover parameter codes (00060=Discharge, 00065=Gage height); pass its query to search the full USGS parameter-code catalog for codes beyond the common ones (turbidity, nitrate, chlorophyll, suspended sediment)
- Use water_find_sites to find sites by bbox, state, county, or HUC watershed
- Use water_get_site_data_catalog to discover a site's parameters, sensors, statistics and UTC bounds; take YYYY-MM-DD from beginDate/endDate for water_get_series, pass statCd only for daily rows, and obtain methodId from the series response, never from an OGC timeSeriesId
- water_get_readings returns the latest ~15-min real-time values for up to 100 sites, one series per sensor (method) when a site measures a parameter more than one way
- water_get_series returns one historical daily or instantaneous series, most recent records inline — the daily mean by default, with statCd and methodId to pick another statistic or sensor from those listed in otherSeries; large ranges spill the complete series to DataCanvas when enabled on this server instance — inspect the staged table with water_dataframe_describe, then read it with water_dataframe_query; where this server enables it, water_dataframe_drop removes a staged table you no longer need
- water_get_conditions gives a current reading ranked against the full period-of-record percentiles
- Groundwater depth (parameter 72019) uses the standard IV service — gwlevels was decommissioned Nov 2025
- The usgs-water-guide skill (skill://usgs-water-guide/SKILL.md) carries the gates for telling live gages from discontinued ones, reading depth-to-water rankings, picking a site's parameter code, time zones and data lag, and SQL over staged series`,
  skills: 'skills',

  /**
   * Every tool here answers from the USGS response alone — none calls
   * `ctx.requestInput`, so no handler needs a session to come back to.
   * Declaring the posture in `src/` keeps it with the code rather than only in
   * `.env.example` and the Dockerfile; `MCP_SESSION_MODE` still wins when set.
   */
  sessionMode: 'stateless',

  setup(core) {
    // Parse server config now so an invalid USGS_* value fails startup, not every tool call.
    getServerConfig();
    setCanvas(core.canvas);
  },
});

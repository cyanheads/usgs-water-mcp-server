/**
 * @fileoverview Find USGS monitoring sites by geographic filter (bbox, state, county, HUC),
 * site type, and parameter availability. Results are capped at 500 inline; when the result is
 * truncated and a DataCanvas provider is enabled, the full match set is staged to a canvas table
 * for gap-free retrieval via water_dataframe_query.
 * @module mcp-server/tools/definitions/water-find-sites.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  BboxSchema,
  CountyCdSchema,
  HucSchema,
  ParameterCdListSchema,
  StateCdSchema,
} from '@/services/nwis/input-schemas.js';
import { classifyNwisFailure, findSites } from '@/services/nwis/nwis-service.js';

/** Maximum sites returned inline in a single response. Prevents token overflows on broad queries. */
const SITE_CAP = 500;

export const waterFindSites = tool('water_find_sites', {
  description:
    'Find USGS water monitoring sites by bounding box, state, county, or HUC watershed code. ' +
    'Filter by site type (stream gage, groundwater well, lake) and parameter availability. ' +
    'Returns site numbers, names, coordinates, types, altitude, and (in expanded mode) drainage area. ' +
    'Call this first to discover site numbers — water_get_readings, water_get_series, and ' +
    'water_get_conditions all require a site number. ' +
    'To check which parameters or data types a site carries, use the parameterCd or hasDataTypeCd filters. ' +
    'Results are capped at 500 sites inline; when truncated=true the full upstream count is in upstreamTotal. ' +
    'When the server has DataCanvas enabled, the full match set is staged to a canvas — the response then ' +
    'includes canvas_id and table_name to retrieve every match (including those past the 500 cap) via water_dataframe_query. ' +
    'Without DataCanvas, narrow the query with bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd to get all matches.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    bbox: BboxSchema.optional().describe(
      'Bounding box as "west,south,east,north" in decimal degrees ' +
        '(e.g. "-77.5,38.5,-76.5,39.5" for the DC metro area). ' +
        'Mutually exclusive with stateCd/countyCd/huc.',
    ),
    stateCd: StateCdSchema.optional().describe(
      '2-character US state abbreviation (e.g. "VA", "WA"). ' +
        'Returns all sites in the state for the given filters.',
    ),
    countyCd: CountyCdSchema.optional().describe(
      'FIPS county code(s) as bare 5-digit numbers — state and county digits concatenated, ' +
        'no separator (e.g. "51013" for Arlington, VA). ' +
        'Comma-separate up to 20 (e.g. "51059,51061"). Use with stateCd for clarity.',
    ),
    huc: HucSchema.optional().describe(
      'Hydrologic Unit Code (HUC) scoping results to a watershed. ' +
        'Either a 2-digit major HUC (e.g. "02" for the Mid-Atlantic region) or an 8-digit minor HUC ' +
        '(e.g. "02070008" for the Middle Potomac). NWIS accepts no other lengths.',
    ),
    siteType: z
      .string()
      .optional()
      .describe(
        'Site type filter. Common codes: "ST" (stream), "GW" (groundwater well), "LK" (lake/reservoir), ' +
          '"SP" (spring), "AT" (atmosphere), "OC" (ocean), "ES" (estuary). ' +
          'Comma-separate multiple types (e.g. "ST,GW").',
      ),
    parameterCd: ParameterCdListSchema.optional().describe(
      '5-digit parameter code to require at each returned site (e.g. "00060" for discharge). ' +
        'Use water_list_parameters to discover codes. ' +
        'Comma-separate multiple codes with no spaces (e.g. "00060,00065").',
    ),
    hasDataTypeCd: z
      .string()
      .optional()
      .describe(
        'Require sites with data of this type. Common values: "iv" (real-time/instantaneous), ' +
          '"dv" (daily values), "gw" (groundwater). Comma-separate multiple types.',
      ),
    siteOutput: z
      .enum(['basic', 'expanded'])
      .default('basic')
      .describe(
        '"basic" returns core identification fields. ' +
          '"expanded" adds drainage area, altitude, contributing area, and other metadata.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID from a prior call to stage the full match set into an existing canvas rather ' +
          'than creating a new one. Applies only when the result is truncated and DataCanvas is ' +
          'enabled. Omit to start a fresh canvas.',
      ),
  }),
  output: z.object({
    sites: z
      .array(
        z
          .object({
            siteNumber: z
              .string()
              .describe('USGS site number (8–15 digits). Used by all other water tools.'),
            siteName: z
              .string()
              .describe(
                'Human-readable USGS site name (e.g. "POTOMAC RIVER AT LITTLE FALLS, MD").',
              ),
            siteType: z
              .string()
              .describe(
                'USGS site type code (e.g. "ST"=stream, "GW"=groundwater well, "LK"=lake/reservoir).',
              ),
            latitude: z.number().describe('Decimal latitude in WGS 84.'),
            longitude: z.number().describe('Decimal longitude in WGS 84.'),
            stateCd: z
              .string()
              .optional()
              .describe(
                '2-digit FIPS state code (e.g. "51" for Virginia). ' +
                  'Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            countyCd: z
              .string()
              .optional()
              .describe(
                '3-digit FIPS county code within the state (zero-padded, e.g. "013"). ' +
                  'Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            hucCd: z
              .string()
              .optional()
              .describe(
                'Hydrologic Unit Code (HUC) of the watershed containing this site. ' +
                  'Length varies by the level NWIS assigned the site — 8-digit (HUC8) and ' +
                  '12-digit (HUC12, e.g. "020700081005") values are both common, so do not ' +
                  'assume a fixed width. Absent when NWIS assigns the site no HUC. ' +
                  'Do not pass this value straight back as the huc input ' +
                  'filter, which takes 2 or 8 digits only; HUC codes nest, so the first 8 digits ' +
                  'are the containing HUC8 subbasin and are what that filter accepts.',
              ),
            drainageArea: z
              .number()
              .optional()
              .describe(
                'Total drainage area in square miles. ' +
                  'Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            altitude: z
              .number()
              .optional()
              .describe(
                'Altitude of the gage datum in feet above sea level (NAVD 88 or NGVD 29). ' +
                  'Present in both basic and expanded modes when USGS records an altitude for the site.',
              ),
            contributingArea: z
              .number()
              .optional()
              .describe(
                'Contributing drainage area in square miles (may differ from drainageArea for regulated basins). ' +
                  'Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
          })
          .describe('A USGS monitoring site with location, type, and available data.'),
      )
      .describe(
        'Matching USGS monitoring sites (capped at 500 inline; when truncated, upstreamTotal holds the full count ' +
          'and canvas_id/table_name point to the staged full set when DataCanvas is enabled).',
      ),
    total: z
      .number()
      .int()
      .describe('Number of sites returned inline in this response (at most 500).'),
    truncated: z
      .boolean()
      .describe(
        'True when the upstream result set exceeded the 500-site cap. ' +
          'Query the full match set via water_dataframe_query when canvas_id is present, ' +
          'or narrow filters (add bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd) to retrieve all matches.',
      ),
    upstreamTotal: z
      .number()
      .int()
      .describe(
        'Total number of sites matching the query upstream, before the 500-site cap was applied. ' +
          'Equals total when truncated=false.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID for the DataCanvas holding the full, uncapped match set. Present only when truncated=true ' +
          'and DataCanvas is enabled. Pass to water_dataframe_describe then water_dataframe_query to retrieve sites beyond the inline cap.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name in the canvas holding all matching sites. Present when canvas_id is present. ' +
          'Use as the FROM target in water_dataframe_query SQL.',
      ),
  }),

  enrichment: {
    filters: z
      .object({
        stateCd: z.string().optional().describe('State filter applied, if any.'),
        countyCd: z.string().optional().describe('County FIPS filter applied, if any.'),
        siteType: z.string().optional().describe('Site type filter applied, if any.'),
        parameterCd: z.string().optional().describe('Parameter code filter applied, if any.'),
        bbox: z.string().optional().describe('Bounding box filter applied, if any.'),
        huc: z.string().optional().describe('HUC watershed filter applied, if any.'),
        hasDataTypeCd: z.string().optional().describe('Data type filter applied, if any.'),
        siteOutput: z
          .enum(['basic', 'expanded'])
          .describe('Site output mode used (basic or expanded).'),
      })
      .describe('Filters applied to this query.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory when results were capped — points to the staged canvas when DataCanvas is enabled, ' +
          'otherwise to narrowing filters, for retrieving all matches.',
      ),
  },

  enrichmentTrailer: {
    filters: {
      render(v) {
        const parts: string[] = [];
        if (v.stateCd) parts.push(`state=${v.stateCd}`);
        if (v.countyCd) parts.push(`countyCd=${v.countyCd}`);
        if (v.siteType) parts.push(`siteType=${v.siteType}`);
        if (v.parameterCd) parts.push(`parameterCd=${v.parameterCd}`);
        if (v.bbox) parts.push(`bbox=${v.bbox}`);
        if (v.huc) parts.push(`huc=${v.huc}`);
        if (v.hasDataTypeCd) parts.push(`hasDataTypeCd=${v.hasDataTypeCd}`);
        parts.push(`siteOutput=${v.siteOutput}`);
        return `**Filters applied:** ${parts.join(', ')}`;
      },
    },
  },

  errors: [
    {
      reason: 'no_sites_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'No sites match the given geographic and filter criteria.',
      recovery:
        'Broaden the bounding box, remove parameterCd or siteType filters, or try a different state/HUC.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NWIS rejected the request. Filter formats are validated against NWIS-accepted patterns before the call, so this surfaces a well-formed value NWIS still refused (an unknown code, or an unsupported filter combination).',
      recovery:
        'Read the NWIS message in this error — it names the field it rejected. Correct that filter and retry.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'NWIS returned a 5xx error or the request timed out.',
      recovery: 'The USGS service is temporarily unavailable. Retry after a short backoff.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    ctx.log.info('Finding USGS sites', {
      bbox: input.bbox,
      stateCd: input.stateCd,
      countyCd: input.countyCd,
      huc: input.huc,
      siteType: input.siteType,
      parameterCd: input.parameterCd,
    });

    let sites: Awaited<ReturnType<typeof findSites>>;
    try {
      const params: Parameters<typeof findSites>[0] = { siteOutput: input.siteOutput };
      if (input.bbox) params.bbox = input.bbox;
      if (input.stateCd) params.stateCd = input.stateCd;
      if (input.countyCd) params.countyCd = input.countyCd;
      if (input.huc) params.huc = input.huc;
      if (input.siteType) params.siteType = input.siteType;
      if (input.parameterCd) params.parameterCd = input.parameterCd;
      if (input.hasDataTypeCd) params.hasDataTypeCd = input.hasDataTypeCd;
      sites = await findSites(params, ctx.signal);
    } catch (err: unknown) {
      const failure = classifyNwisFailure(err);
      if (failure) throw ctx.fail(failure.reason, failure.message, undefined, { cause: err });
      throw err;
    }

    if (sites.length === 0) {
      throw ctx.fail('no_sites_found', 'No USGS sites match the specified filters.');
    }

    const upstreamTotal = sites.length;
    const truncated = upstreamTotal > SITE_CAP;
    const capped = truncated ? sites.slice(0, SITE_CAP) : sites;

    // DataCanvas handoff: when truncated and a canvas provider is enabled, stage the FULL match set
    // so every site past the inline cap is retrievable via water_dataframe_query — a gap-free
    // retrieval path that narrowing filters alone cannot guarantee. Uses registerTable, not
    // spillover(): this tool's cap is count-based, so the full set must land on canvas whenever the
    // count exceeds SITE_CAP, independent of the serialized-size budget spillover() gates on. No
    // provider → the cap + narrowing-filters notice below is the fallback.
    let canvasId: string | undefined;
    let tableName: string | undefined;
    const canvas = getCanvas();
    if (canvas && truncated) {
      const instance = await canvas.acquire(input.canvas_id, ctx);
      const scope = input.stateCd ?? input.countyCd ?? input.huc ?? (input.bbox ? 'bbox' : 'all');
      const table = `water_sites_${scope}_${input.siteType ?? 'all'}`.replace(/[^a-z0-9_]/gi, '_');
      const handle = await instance.registerTable(
        table,
        sites.map((s) => ({
          site_number: s.siteNumber,
          site_name: s.siteName,
          site_type: s.siteType,
          latitude: s.latitude,
          longitude: s.longitude,
          huc_cd: s.hucCd ?? null,
          state_cd: s.stateCd ?? null,
          county_cd: s.countyCd ?? null,
          drainage_area: s.drainageArea ?? null,
          altitude: s.altitude ?? null,
          contributing_area: s.contributingArea ?? null,
        })),
        { signal: ctx.signal },
      );
      canvasId = instance.canvasId;
      tableName = handle.tableName;
    }

    let notice: string | undefined;
    if (truncated) {
      notice = canvasId
        ? `The full ${upstreamTotal}-site match set is staged on DataCanvas — retrieve every match via water_dataframe_query using canvas_id "${canvasId}" (table ${tableName}). Inline results are capped at ${SITE_CAP}.`
        : `Result capped at ${SITE_CAP} of ${upstreamTotal} matching sites. Add bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd filters to narrow the query, or enable DataCanvas (CANVAS_PROVIDER_TYPE=duckdb) to retrieve all matches via water_dataframe_query.`;
    }

    // Spread `notice` in only when set: passing `notice: undefined` puts the key on the enrichment
    // store, and the framework's default scalar trailer renderer stringifies it as literal
    // "undefined" in content[] (no notice.render() is declared). Omitting the key keeps optional
    // enrichment absent from both surfaces — mirroring how water_get_series enriches notice only on
    // the truncated path.
    ctx.enrich({
      filters: {
        stateCd: input.stateCd,
        countyCd: input.countyCd,
        siteType: input.siteType,
        parameterCd: input.parameterCd,
        bbox: input.bbox,
        huc: input.huc,
        hasDataTypeCd: input.hasDataTypeCd,
        siteOutput: input.siteOutput,
      },
      ...(notice ? { notice } : {}),
    });

    ctx.log.info('Sites found', {
      count: capped.length,
      upstreamTotal,
      truncated,
      canvasStaged: canvasId !== undefined,
    });
    return {
      sites: capped,
      total: capped.length,
      truncated,
      upstreamTotal,
      canvas_id: canvasId,
      table_name: tableName,
    };
  },

  format(result) {
    const header = result.truncated
      ? `**${result.total} site(s) shown** (truncated; ${result.upstreamTotal} total matched)\n`
      : `**${result.total} site(s) found**\n`;
    const lines = [header];

    if (result.truncated && result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` | **Table:** \`${result.table_name}\``,
        `*(full ${result.upstreamTotal}-site match set staged — query all matches via water_dataframe_query)*`,
        '',
      );
    } else if (result.truncated) {
      lines.push(`*(narrow filters to retrieve all ${result.upstreamTotal} matches)*`, '');
    }

    for (const s of result.sites) {
      lines.push(
        `### ${s.siteName} (${s.siteNumber})`,
        `**Type:** ${s.siteType} | **Lat/Lon:** ${s.latitude}, ${s.longitude}`,
      );
      // HUC, state, and county each render only when present — NWIS omits HUC for some sites, and
      // state/county populate in expanded mode only. Building the line from the parts that exist
      // keeps an absent field from printing a bare label (the #22 blank "HUC:" regression).
      const location: string[] = [];
      if (s.hucCd) location.push(`**HUC:** ${s.hucCd}`);
      if (s.stateCd) location.push(`**State:** ${s.stateCd}`);
      if (s.countyCd) location.push(`**County:** ${s.countyCd}`);
      if (location.length > 0) lines.push(location.join(' | '));
      // Render each scalar metric iff it is individually present. altitude populates in both basic
      // and expanded mode, but drainageArea/contributingArea only in expanded — so gating altitude
      // behind a drainageArea check silently dropped it from content[] for basic-mode sites that
      // carry an altitude. Decoupling keeps content[] in parity with structuredContent per-field.
      const metrics: string[] = [];
      if (s.drainageArea !== undefined) metrics.push(`**Drainage area:** ${s.drainageArea} mi²`);
      if (s.altitude !== undefined) metrics.push(`**Altitude:** ${s.altitude} ft`);
      if (s.contributingArea !== undefined)
        metrics.push(`**Contributing area:** ${s.contributingArea} mi²`);
      if (metrics.length > 0) lines.push(metrics.join(' | '));
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

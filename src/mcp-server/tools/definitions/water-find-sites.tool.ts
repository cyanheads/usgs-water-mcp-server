/**
 * @fileoverview Find USGS monitoring sites by geographic filter (bbox, state, county, HUC),
 * site type, and parameter availability.
 * @module mcp-server/tools/definitions/water-find-sites.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { findSites } from '@/services/nwis/nwis-service.js';

/** Maximum sites returned in a single response. Prevents token overflows on broad queries. */
const SITE_CAP = 500;

export const waterFindSites = tool('water_find_sites', {
  description:
    'Find USGS water monitoring sites by bounding box, state, county, or HUC watershed code. ' +
    'Filter by site type (stream gage, groundwater well, lake) and parameter availability. ' +
    'Returns site numbers, names, coordinates, types, and (in expanded mode) drainage area and altitude. ' +
    'Call this first to discover site numbers — water_get_readings, water_get_series, and ' +
    'water_get_conditions all require a site number. ' +
    'To check which parameters or data types a site carries, use the parameterCd or hasDataTypeCd filters. ' +
    'Results are capped at 500 sites; when truncated=true the full upstream count is in upstreamTotal — ' +
    'narrow the query with bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd to get all matches.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    bbox: z
      .string()
      .optional()
      .describe(
        'Bounding box as "west,south,east,north" in decimal degrees ' +
          '(e.g. "-77.5,38.5,-76.5,39.5" for the DC metro area). ' +
          'Mutually exclusive with stateCd/countyCd/huc.',
      ),
    stateCd: z
      .string()
      .optional()
      .describe(
        '2-character US state abbreviation (e.g. "VA", "WA"). ' +
          'Returns all sites in the state for the given filters.',
      ),
    countyCd: z
      .string()
      .optional()
      .describe(
        'FIPS county code(s) as "SS:CCC" or comma-separated list (e.g. "51:013" for Arlington, VA). ' +
          'Use with stateCd for clarity.',
      ),
    huc: z
      .string()
      .optional()
      .describe(
        'Hydrologic Unit Code (HUC) — 2, 4, 6, or 8 digits (e.g. "02070010" for Potomac/Shenandoah). ' +
          'Scopes results to a watershed.',
      ),
    siteType: z
      .string()
      .optional()
      .describe(
        'Site type filter. Common codes: "ST" (stream), "GW" (groundwater well), "LK" (lake/reservoir), ' +
          '"SP" (spring), "AT" (atmosphere), "OC" (ocean), "ES" (estuary). ' +
          'Comma-separate multiple types (e.g. "ST,GW").',
      ),
    parameterCd: z
      .string()
      .optional()
      .describe(
        '5-digit parameter code to require at each returned site (e.g. "00060" for discharge). ' +
          'Use water_list_parameters to discover codes. Comma-separate multiple codes.',
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
              .describe(
                '8-digit Hydrologic Unit Code (HUC8) for the watershed containing this site.',
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
                  'Populated only when siteOutput="expanded"; absent in basic mode.',
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
        'Matching USGS monitoring sites (capped at 500; see truncated/upstreamTotal for overflow).',
      ),
    total: z.number().int().describe('Number of sites returned in this response (at most 500).'),
    truncated: z
      .boolean()
      .describe(
        'True when the upstream result set exceeded the 500-site cap. ' +
          'Narrow filters (add bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd) to retrieve all matches.',
      ),
    upstreamTotal: z
      .number()
      .int()
      .describe(
        'Total number of sites matching the query upstream, before the 500-site cap was applied. ' +
          'Equals total when truncated=false.',
      ),
  }),

  enrichment: {
    filters: z
      .object({
        stateCd: z.string().optional().describe('State filter applied, if any.'),
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
        'Advisory when results were capped — add narrowing filters to retrieve all matches.',
      ),
  },

  enrichmentTrailer: {
    filters: {
      render(v) {
        const parts: string[] = [];
        if (v.stateCd) parts.push(`state=${v.stateCd}`);
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
      reason: 'invalid_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'NWIS rejected the request due to an invalid filter value or unsupported combination.',
      recovery:
        'Correct the filter values — check bBox decimal degree format, valid state codes, and HUC length.',
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
      // Detect HTML 400 → invalid_filter; 5xx already throws ServiceUnavailable
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes('rejected') ||
        msg.includes('InvalidParams') ||
        msg.includes('ValidationError')
      ) {
        throw ctx.fail('invalid_filter', msg);
      }
      if (
        msg.includes('unavailable') ||
        msg.includes('ServiceUnavailable') ||
        msg.includes('timed out')
      ) {
        throw ctx.fail('upstream_error', msg);
      }
      throw err;
    }

    if (sites.length === 0) {
      throw ctx.fail('no_sites_found', 'No USGS sites match the specified filters.');
    }

    const upstreamTotal = sites.length;
    const truncated = upstreamTotal > SITE_CAP;
    const capped = truncated ? sites.slice(0, SITE_CAP) : sites;

    ctx.enrich({
      filters: {
        stateCd: input.stateCd,
        siteType: input.siteType,
        parameterCd: input.parameterCd,
        bbox: input.bbox,
        huc: input.huc,
        hasDataTypeCd: input.hasDataTypeCd,
        siteOutput: input.siteOutput,
      },
      notice: truncated
        ? `Result capped at ${SITE_CAP} of ${upstreamTotal} matching sites. Add bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd filters to narrow the query.`
        : undefined,
    });

    ctx.log.info('Sites found', { count: capped.length, upstreamTotal, truncated });
    return { sites: capped, total: capped.length, truncated, upstreamTotal };
  },

  format(result) {
    const header = result.truncated
      ? `**${result.total} site(s) shown** (truncated; ${result.upstreamTotal} total matched — narrow filters to retrieve all)\n`
      : `**${result.total} site(s) found**\n`;
    const lines = [header];
    for (const s of result.sites) {
      lines.push(
        `### ${s.siteName} (${s.siteNumber})`,
        `**Type:** ${s.siteType} | **Lat/Lon:** ${s.latitude}, ${s.longitude}`,
        `**HUC:** ${s.hucCd}${s.stateCd ? ` | **State:** ${s.stateCd}` : ''}${s.countyCd ? ` | **County:** ${s.countyCd}` : ''}`,
      );
      if (s.drainageArea !== undefined)
        lines.push(
          `**Drainage area:** ${s.drainageArea} mi²${s.altitude !== undefined ? ` | **Altitude:** ${s.altitude} ft` : ''}${s.contributingArea !== undefined ? ` | **Contributing area:** ${s.contributingArea} mi²` : ''}`,
        );
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

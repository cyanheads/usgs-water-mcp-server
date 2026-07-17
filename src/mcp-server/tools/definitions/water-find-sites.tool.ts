/**
 * @fileoverview Find USGS monitoring sites by geographic filter (bbox, state, county, HUC),
 * site type, and parameter availability.
 * @module mcp-server/tools/definitions/water-find-sites.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  BboxSchema,
  CountyCdSchema,
  HucSchema,
  ParameterCdListSchema,
  StateCdSchema,
} from '@/services/nwis/input-schemas.js';
import { classifyNwisFailure, findSites } from '@/services/nwis/nwis-service.js';

/** Maximum sites returned in a single response. Prevents token overflows on broad queries. */
const SITE_CAP = 500;

export const waterFindSites = tool('water_find_sites', {
  description:
    'Find USGS water monitoring sites by bounding box, state, county, or HUC watershed code. ' +
    'Filter by site type (stream gage, groundwater well, lake) and parameter availability. ' +
    'Returns site numbers, names, coordinates, types, altitude, and (in expanded mode) drainage area. ' +
    'Call this first to discover site numbers — water_get_readings, water_get_series, and ' +
    'water_get_conditions all require a site number. ' +
    'To check which parameters or data types a site carries, use the parameterCd or hasDataTypeCd filters. ' +
    'Results are capped at 500 sites; when truncated=true the full upstream count is in upstreamTotal — ' +
    'narrow the query with bbox, countyCd, huc, siteType, parameterCd, or hasDataTypeCd to get all matches.',
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
                'Hydrologic Unit Code (HUC) of the watershed containing this site. ' +
                  'Length varies by the level NWIS assigned the site — 8-digit (HUC8) and ' +
                  '12-digit (HUC12, e.g. "020700081005") values are both common, so do not ' +
                  'assume a fixed width. Do not pass this value straight back as the huc input ' +
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
        'Advisory when results were capped — add narrowing filters to retrieve all matches.',
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

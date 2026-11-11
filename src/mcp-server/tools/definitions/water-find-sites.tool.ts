/**
 * @fileoverview Find USGS monitoring sites by geographic filter (bbox, state, county, HUC),
 * site type, and parameter availability, each row carrying the time of its newest matching
 * observation. Results are paged inline through limit/offset, capped at 500 per page; when the
 * match set exceeds that cap and a DataCanvas provider is enabled, the full set is staged to a
 * canvas table for gap-free retrieval via SQL.
 * @module mcp-server/tools/definitions/water-find-sites.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { CanvasIdSchema, type CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { acquireCanvas } from '@/services/canvas/acquire-canvas.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
import {
  assertCanvasTableName,
  sanitizeIdentifierToken,
  shortHash,
} from '@/services/canvas/canvas-table-name.js';
import {
  BboxSchema,
  CountyCdSchema,
  HucSchema,
  ParameterCdListSchema,
  PeriodSchema,
  StateCdSchema,
} from '@/services/waterdata/input-schemas.js';
import {
  DATA_TYPE_CODES,
  type FindSitesParams,
  findSites,
} from '@/services/waterdata/site-discovery.js';
import { startRequest } from '@/services/waterdata/water-data-client.js';
import { classifyWaterDataFailure } from '@/services/waterdata/water-data-errors.js';

/** Maximum sites returned inline in a single response. Prevents token overflows on broad queries. */
const SITE_CAP = 500;

/**
 * Exactly one geographic scope per call. The OGC collections would take several at once, or none
 * — a walk of the whole national network, which has no area cap — so the rule keeps every call
 * bounded and every filter set with one reading.
 */
const MAJOR_FILTERS = ['bbox', 'stateCd', 'countyCd', 'huc'] as const;

export const waterFindSites = tool('water_find_sites', {
  description:
    'Find USGS water monitoring sites by bounding box, state, county, or HUC watershed code, filtered by site type and parameter availability. Returns site numbers, names, coordinates, types, altitude, the UTC time each site last reported (lastObservedAt), and (in expanded mode) drainage area. Call this first — water_get_readings, water_get_series, and water_get_conditions all require a site number. Supply exactly one major filter — bbox, stateCd, countyCd, or huc; siteType, parameterCd, hasDataTypeCd, and observedWithin only narrow within it and cannot stand alone. parameterCd and hasDataTypeCd match sites that have ever reported, discontinued ones included; set observedWithin to keep only sites reporting now. Page through matches with limit/offset (500 per page); truncated=true means matches remain after the returned window and upstreamTotal holds the full count. When the match set exceeds 500 and DataCanvas is enabled, the complete set also stages to a canvas (canvas_id/table_name) — inspect it with water_dataframe_describe, then retrieve it with water_dataframe_query.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    bbox: BboxSchema.optional().describe(
      'Bounding box as "west,south,east,north" in decimal degrees (e.g. "-77.5,38.5,-76.5,39.5" for the DC metro area). One of the four major filters — bbox, stateCd, countyCd, and huc are mutually exclusive with each other, and exactly one must be supplied.',
    ),
    stateCd: StateCdSchema.optional().describe(
      '2-letter US state or territory postal code, any case (e.g. "VA", "wa", "PR"). Returns all sites in the state for the given filters. Major filter — supply exactly one of bbox, stateCd, countyCd, huc.',
    ),
    countyCd: CountyCdSchema.optional().describe(
      'FIPS county code(s) as bare 5-digit numbers — state and county digits concatenated, no separator (e.g. "51013" for Arlington, VA). Comma-separate up to 20 (e.g. "51059,51061"). The 5 digits already encode the state, so the code stands alone. Major filter — supply exactly one of bbox, stateCd, countyCd, huc.',
    ),
    huc: HucSchema.optional().describe(
      'Hydrologic Unit Code (HUC) scoping results to a watershed: a 2-digit region (e.g. "02" for the Mid-Atlantic) or an 8-digit subbasin (e.g. "02070008" for the Middle Potomac). Matches every site whose HUC starts with it. Major filter — supply exactly one of bbox, stateCd, countyCd, huc.',
    ),
    siteType: z
      .string()
      .optional()
      .describe(
        'Site type filter. Common codes: "ST" (stream), "GW" (groundwater well), "LK" (lake/reservoir), "SP" (spring), "AT" (atmosphere), "OC" (ocean), "ES" (estuary). A major type includes its subtypes ("ST" also matches "ST-CA", "ST-DCH", "ST-TS"); a subtype matches only itself. Comma-separate multiple types (e.g. "ST,GW").',
      ),
    parameterCd: ParameterCdListSchema.optional().describe(
      '5-digit parameter code each returned site has ever reported (e.g. "00060" for discharge) — a site whose record ended years ago still matches; read lastObservedAt, or set observedWithin to keep only sites reporting now. Matched against the series hasDataTypeCd selects (continuous, daily, and field-measurement series when it is omitted), never discrete water-quality samples, so a site with only lab-analyzed samples for the code does not match. Use water_list_parameters to discover codes. Comma-separate multiple codes with no spaces (e.g. "00060,00065").',
    ),
    hasDataTypeCd: z
      .string()
      .optional()
      .describe(
        'Require sites that have ever reported data of this type: "iv" (instantaneous, continuous record; "uv" and "rt" are aliases), "dv" (daily values), "gw" (groundwater-level field measurements), "pk" (annual peaks). No other code has a source. Comma-separate multiple types. A discontinued site still matches — read lastObservedAt, or set observedWithin to keep only sites reporting now.',
      ),
    observedWithin: PeriodSchema.optional().describe(
      'ISO 8601 duration ending now, the form water_get_readings period takes (e.g. "P7D", "PT6H", "P1Y"). Keeps only sites whose lastObservedAt falls inside it — sites reporting now, not discontinued ones. Counts the series parameterCd and hasDataTypeCd select, or any continuous, daily, or field-measurement series when both are omitted. Daily values and field measurements carry a date only and daily values publish a day or two late, so a window under "P3D" can drop a site that reports daily values only.',
    ),
    siteOutput: z
      .enum(['basic', 'expanded'])
      .default('basic')
      .describe(
        '"basic" returns core identification fields. "expanded" adds drainage area, altitude, contributing area, and other metadata.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(SITE_CAP)
      .default(SITE_CAP)
      .describe(
        `Maximum sites to return inline, 1–${SITE_CAP}. Default ${SITE_CAP} (the inline cap).`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Number of matching sites to skip before returning results. Page through matches beyond the inline cap by advancing offset by limit. Default 0.',
      ),
    canvas_id: CanvasIdSchema.optional().describe(
      'Canvas ID from a prior call to add this match set as a table on an existing canvas rather than creating a new one. Each distinct filter set gets its own table name, so re-running the identical query replaces its own table while a different query adds another alongside it. Applies only when the match set exceeds the inline cap and DataCanvas is enabled. Omit to start a fresh canvas.',
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
                '2-digit FIPS state code (e.g. "51" for Virginia). Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            countyCd: z
              .string()
              .optional()
              .describe(
                '3-digit FIPS county code within the state (zero-padded, e.g. "013"). Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            hucCd: z
              .string()
              .optional()
              .describe(
                'Hydrologic Unit Code of the watershed containing this site; width varies (8-digit HUC8 and 12-digit HUC12, e.g. "020700081005", are both common — do not assume a fixed width), and absent when USGS assigns none. Do not pass it straight back to the huc filter (which takes 2 or 8 digits); HUCs nest, so its first 8 digits are the containing HUC8 that filter accepts.',
              ),
            drainageArea: z
              .number()
              .optional()
              .describe(
                'Total drainage area in square miles. Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            altitude: z
              .number()
              .optional()
              .describe(
                'Altitude of the gage datum in feet above sea level (NAVD 88 or NGVD 29). Present in both basic and expanded modes when USGS records an altitude for the site.',
              ),
            contributingArea: z
              .number()
              .optional()
              .describe(
                'Contributing drainage area in square miles (may differ from drainageArea for regulated basins). Populated only when siteOutput="expanded"; absent in basic mode.',
              ),
            lastObservedAt: z
              .string()
              .nullable()
              .describe(
                'UTC time (ISO 8601) of the newest observation among this site’s series that match parameterCd and hasDataTypeCd — any continuous, daily, or field-measurement series when both are omitted. A daily value, field measurement, or peak carries a date only and counts from 00:00 UTC on it. A time years in the past marks a discontinued site. Null when the site has no matching series, or none with a recorded time.',
              ),
          })
          .describe('A USGS monitoring site with location, type, and when it last reported.'),
      )
      .describe(
        'The requested window of matching USGS monitoring sites — the slice starting at offset, at most limit long (500 max). upstreamTotal holds the full match count; canvas_id/table_name point to the staged full set when it exceeded the cap and DataCanvas is enabled.',
      ),
    total: z
      .number()
      .int()
      .describe(
        'Number of sites returned inline in this response — at most limit, and 0 when offset is at or past upstreamTotal.',
      ),
    truncated: z
      .boolean()
      .describe(
        'True when matches remain after the returned window (offset + total < upstreamTotal) — false on the last page, and false for a window starting past the end of the match set, where the notice names the valid offset range instead. Advance offset by limit for the next page, narrow filters (add bbox, countyCd, huc, siteType, parameterCd, hasDataTypeCd, or observedWithin), or when canvas_id is present read the staged set with water_dataframe_describe then water_dataframe_query.',
      ),
    upstreamTotal: z
      .number()
      .int()
      .describe(
        'Total number of sites matching the query upstream, before limit/offset windowing. Equals total when the whole match set fits in one window.',
      ),
    canvas_id: z
      .string()
      .optional()
      .describe(
        'Canvas ID for the DataCanvas holding the full, uncapped match set. Present only when the match set exceeded the 500-site cap and DataCanvas is enabled. Pass to water_dataframe_describe then water_dataframe_query to retrieve sites beyond the inline cap.',
      ),
    table_name: z
      .string()
      .optional()
      .describe(
        'DuckDB table name in the canvas holding all matching sites. Present when canvas_id is present. Use as the FROM target in water_dataframe_query SQL.',
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
        observedWithin: z.string().optional().describe('Recency window applied, if any.'),
        siteOutput: z
          .enum(['basic', 'expanded'])
          .describe('Site output mode used (basic or expanded).'),
      })
      .describe('Filters applied to this query.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Advisory about the returned window: the staged canvas and how to read it, the filters to narrow by, the window actually returned, the valid offset range when the request landed past the end of the match set, or the fact that a supplied canvas_id went unused because nothing was staged.',
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
        if (v.observedWithin) parts.push(`observedWithin=${v.observedWithin}`);
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
        'Broaden the bounding box, widen or drop observedWithin, remove parameterCd, hasDataTypeCd, or siteType filters, or try a different state/HUC.',
    },
    {
      reason: 'missing_major_filter',
      code: JsonRpcErrorCode.ValidationError,
      when: 'None of bbox, stateCd, countyCd, or huc was supplied. Every site search is scoped by exactly one of them; siteType, parameterCd, hasDataTypeCd, and observedWithin only narrow within that scope.',
      recovery:
        'Add exactly one of bbox, stateCd, countyCd, or huc and retry — a 2-letter stateCd is the broadest scope this tool searches.',
    },
    {
      reason: 'conflicting_major_filters',
      code: JsonRpcErrorCode.ValidationError,
      when: 'More than one of bbox, stateCd, countyCd, and huc was supplied. The tool takes exactly one per call.',
      recovery:
        'Keep the single filter that matches the intended scope and drop the others — a 5-digit countyCd already encodes its state, so stateCd adds nothing beside it.',
    },
    {
      reason: 'invalid_request',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A well-formed filter value has no translation — a stateCd that is no US state or territory, a malformed siteType, or a hasDataTypeCd with no source on the USGS Water Data APIs (refused before any request) — or the USGS Water Data API refused the query.',
      recovery: `Read this error's message for the value that was refused, correct it, and retry: stateCd takes a state or territory postal code, hasDataTypeCd takes ${DATA_TYPE_CODES}, and water_list_parameters confirms parameter codes.`,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS Water Data API failed after retries or sent a response this server could not read.',
      recovery:
        'A server error usually clears: retry after a short backoff. An error marked not retryable means the upstream sent a response this server cannot read, and the same request will fail again.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The USGS Water Data requests for this call ran past its 45-second budget.',
      recovery:
        'Retry after a short backoff; narrow the geographic filters if the request repeatedly times out.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The supplied canvas_id names a canvas that never existed or has expired. Raised before any USGS request, so no upstream call is spent on it.',
      recovery:
        'Omit canvas_id to stage this match set on a fresh canvas, or pass an id returned by a call that is still within its canvas lifetime.',
      thrownBy: 'service',
    },
    {
      reason: 'canvas_capacity_exhausted',
      code: JsonRpcErrorCode.RateLimited,
      when: 'canvas_id was omitted and a fresh canvas was needed to stage the match set, but this tenant already holds the maximum number of active canvases.',
      recovery:
        'Pass a canvas_id returned by an earlier call instead of starting a fresh canvas, or retry once an existing canvas expires.',
      retryable: true,
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    // The single-scope rule cannot live on the schema: a Zod refinement rejects at the SDK edge as
    // the generic invalid_arguments, bypassing errors[] and its authored recovery hints.
    const majors = MAJOR_FILTERS.filter((field) => input[field] !== undefined);
    if (majors.length === 0) {
      throw ctx.fail(
        'missing_major_filter',
        'A geographic filter is required: supply exactly one of bbox, stateCd, countyCd, or huc.',
      );
    }
    if (majors.length > 1) {
      throw ctx.fail(
        'conflicting_major_filters',
        `water_find_sites takes one major filter per call; this call sent ${majors.length}: ${majors.join(', ')}.`,
      );
    }

    /**
     * Every input that changes what lands on canvas. Doubles as the filter enrichment below and as
     * the digest input for the staged table name — limit/offset are deliberately absent from both,
     * because staging always holds the full match set whatever window the caller asked for.
     */
    const appliedFilters = {
      stateCd: input.stateCd,
      countyCd: input.countyCd,
      siteType: input.siteType,
      parameterCd: input.parameterCd,
      bbox: input.bbox,
      huc: input.huc,
      hasDataTypeCd: input.hasDataTypeCd,
      observedWithin: input.observedWithin,
      siteOutput: input.siteOutput,
    };

    // A supplied canvas_id is resolved before the upstream calls so a stale or never-minted id
    // fails without spending a USGS round trip. Minting stays lazy — a fresh canvas is acquired
    // further down, only once a result actually has to stage.
    const canvas = getCanvas();
    let instance: CanvasInstance | undefined;
    if (canvas && input.canvas_id) {
      instance = await acquireCanvas(canvas, input.canvas_id, ctx);
    }

    ctx.log.info('Finding USGS sites', {
      bbox: input.bbox,
      stateCd: input.stateCd,
      countyCd: input.countyCd,
      huc: input.huc,
      siteType: input.siteType,
      parameterCd: input.parameterCd,
      hasDataTypeCd: input.hasDataTypeCd,
      observedWithin: input.observedWithin,
    });

    let sites: Awaited<ReturnType<typeof findSites>>;
    try {
      const params: FindSitesParams = { siteOutput: input.siteOutput };
      if (input.bbox) params.bbox = input.bbox;
      if (input.stateCd) params.stateCd = input.stateCd;
      if (input.countyCd) params.countyCd = input.countyCd;
      if (input.huc) params.huc = input.huc;
      if (input.siteType) params.siteType = input.siteType;
      if (input.parameterCd) params.parameterCd = input.parameterCd;
      if (input.hasDataTypeCd) params.hasDataTypeCd = input.hasDataTypeCd;
      if (input.observedWithin) params.observedWithin = input.observedWithin;
      sites = await findSites(params, startRequest(ctx, 'findSites'));
    } catch (error: unknown) {
      if (ctx.signal?.aborted) throw error;
      // Rate limits and a rejected USGS_API_KEY classify to null and pass through with their own
      // recovery hints.
      const failure = classifyWaterDataFailure(error);
      if (!failure) throw error;
      throw ctx.fail(failure.reason, failure.message, failure.data, { cause: error });
    }

    if (sites.length === 0) {
      throw ctx.fail('no_sites_found', 'No USGS sites match the specified filters.');
    }

    const upstreamTotal = sites.length;
    const page = sites.slice(input.offset, input.offset + input.limit);
    // "Matches exist outside the returned window" — which covers both the inline cap and a caller's
    // own smaller limit, and is false on the last page of a paged walk.
    const truncated = input.offset + page.length < upstreamTotal;
    const exceedsCap = upstreamTotal > SITE_CAP;

    // DataCanvas handoff: when the match set exceeds the inline cap and a canvas provider is
    // enabled, stage the FULL set so every site past the cap is retrievable via SQL — a gap-free
    // retrieval path that narrowing filters alone cannot guarantee. Keyed to upstreamTotal alone
    // and never the requested limit: the whole set is already in memory, so the SQL path stays open
    // to a small-limit caller too. Uses registerTable, not spillover(): this tool's cap is
    // count-based, so the full set must land on canvas whenever the count exceeds SITE_CAP,
    // independent of the serialized-size budget spillover() gates on. No provider → the cap +
    // narrowing-filters notice below is the fallback.
    let canvasId: string | undefined;
    let tableName: string | undefined;
    if (canvas && exceedsCap) {
      instance ??= await canvas.acquire(undefined, ctx);
      // The name carries every dimension that changes the staged rows: a readable scope and
      // siteType, then a digest over the whole filter set. registerTable is DROP + CREATE, so a
      // name that collapsed two different queries would replace one result set with the other and
      // still report success. The major-filter guard above makes the scope chain total.
      const scope = input.stateCd ?? (input.countyCd ? 'county' : input.huc ? 'huc' : 'bbox');
      const siteTypeToken =
        input.siteType && !input.siteType.includes(',') ? input.siteType : 'all';
      const table = assertCanvasTableName(
        `water_sites_${sanitizeIdentifierToken(scope)}_${sanitizeIdentifierToken(siteTypeToken)}_${shortHash(appliedFilters)}`,
      );
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
          last_observed_at: s.lastObservedAt,
        })),
        { signal: ctx.signal },
      );
      canvasId = instance.canvasId;
      tableName = handle.tableName;
    }

    const narrowingAdvice =
      'Add bbox, countyCd, huc, siteType, parameterCd, hasDataTypeCd, or observedWithin filters to narrow the query.';
    const notices: string[] = [];
    if (page.length === 0) {
      // Distinct from no_sites_found: the filters matched upstream, the requested window just
      // starts past the end of the match set.
      notices.push(
        `No sites in this window: offset ${input.offset} is at or past the ${upstreamTotal} matching sites. Valid offset range is 0 to ${upstreamTotal - 1}.`,
      );
    }
    if (canvasId) {
      notices.push(
        `The full ${upstreamTotal}-site match set is staged on DataCanvas as table "${tableName}" — use water_dataframe_describe to inspect its columns, then water_dataframe_query to retrieve every match with SQL (canvas_id "${canvasId}"). Inline results are capped at ${SITE_CAP}.`,
      );
    } else if (truncated) {
      // Name whichever bound actually cut the page: the inline cap, or the caller's own window.
      // "Result capped at 500 of 4220" would misreport a limit: 5 call, and would leave a caller
      // paging at offset 600 with default limit unable to tell which 500 they were handed.
      notices.push(
        exceedsCap && input.limit === SITE_CAP && input.offset === 0
          ? `Result capped at ${SITE_CAP} of ${upstreamTotal} matching sites. ${narrowingAdvice}`
          : `Showing sites ${input.offset + 1} to ${input.offset + page.length} of ${upstreamTotal} matches. Advance offset by limit for the next page.${exceedsCap ? ` ${narrowingAdvice}` : ''}`,
      );
    }
    // A canvas_id the caller supplied that no staging used: without this the response is
    // indistinguishable from one where the match set was added to that canvas.
    if (input.canvas_id && !canvasId) {
      notices.push(
        exceedsCap
          ? `DataCanvas is not enabled on this server, so the match set was not staged and canvas "${input.canvas_id}" went unused.`
          : `The ${upstreamTotal}-site match set fits within the ${SITE_CAP}-site inline cap, so it was returned inline and nothing was staged on canvas "${input.canvas_id}".`,
      );
    }
    ctx.enrich({ filters: appliedFilters });
    // Set only when there is something to say, so an absent notice stays off both surfaces.
    // ctx.enrich.notice renders a quoted notice; a bare enrich({ notice }) would render it as a
    // code span in content[].
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('Sites found', {
      count: page.length,
      offset: input.offset,
      upstreamTotal,
      truncated,
      canvasStaged: canvasId !== undefined,
    });
    return {
      sites: page,
      total: page.length,
      truncated,
      upstreamTotal,
      canvas_id: canvasId,
      table_name: tableName,
    };
  },

  format(result) {
    // "found" only when the window holds the whole match set — a page that ends the set is not
    // truncated but still has matches outside it, and hiding upstreamTotal there would read as a
    // complete answer.
    const header =
      result.total === result.upstreamTotal
        ? `**${result.total} site(s) found**\n`
        : `**${result.total} site(s) shown** (${result.truncated ? 'truncated; ' : ''}${result.upstreamTotal} total matched)\n`;
    const lines = [header];

    if (result.canvas_id) {
      lines.push(
        `**Canvas:** \`${result.canvas_id}\` | **Table:** \`${result.table_name}\``,
        `*(full ${result.upstreamTotal}-site match set staged — use water_dataframe_describe for this table's columns, then water_dataframe_query to retrieve every match)*`,
        '',
      );
    } else if (result.truncated) {
      lines.push(
        `*(advance offset by limit for the next page, or narrow filters to retrieve all ${result.upstreamTotal} matches)*`,
        '',
      );
    }

    for (const s of result.sites) {
      lines.push(
        `### ${s.siteName} (${s.siteNumber})`,
        `**Type:** ${s.siteType} | **Lat/Lon:** ${s.latitude}, ${s.longitude}`,
      );
      lines.push(`**Last observed:** ${s.lastObservedAt ?? 'none recorded'}`);
      // HUC, state, and county each render only when present — USGS assigns no HUC to some sites,
      // and state/county populate in expanded mode only. Building the line from the parts that
      // exist keeps an absent field from printing a bare label (the #22 blank "HUC:" regression).
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

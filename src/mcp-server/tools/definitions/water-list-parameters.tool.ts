/**
 * @fileoverview Look up USGS parameter codes: the curated table of well-known codes with no network
 * call, or a search of the full USGS parameter-code catalog (~19,700 codes) by name or description,
 * either listing windowed by limit/offset.
 * @module mcp-server/tools/definitions/water-list-parameters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { escapeMarkdownInline, markdown } from '@cyanheads/mcp-ts-core/utils';
import { CURATED_PARAMETERS, PARAMETER_GROUPS } from '@/services/waterdata/curated-parameters.js';
import {
  getParameterCatalog,
  type ParameterEntry,
  searchParameters,
} from '@/services/waterdata/parameter-catalog.js';

/** Entries per page when the caller sets no limit. */
const DEFAULT_LIMIT = 25;

/**
 * Most entries one page returns: the 4,000 largest catalog entries measure about 0.9 MB of
 * structuredContent and 0.75 MB of content[] text.
 */
const MAX_LIMIT = 4_000;
const MAX_LIMIT_TEXT = MAX_LIMIT.toLocaleString('en-US');

/** The window inputs, as every description of them states. */
const WINDOW_TERMS = `limit (default ${DEFAULT_LIMIT}, 1–${MAX_LIMIT_TEXT}) and offset (default 0)`;

/** One parameter code entry — a curated entry or a catalog record. */
const ParameterSchema = z.object({
  code: z.string().describe('5-digit USGS parameter code (e.g. "00060").'),
  name: z.string().describe('Human-readable parameter name (e.g. "Discharge").'),
  unit: z.string().describe('Unit of measure (e.g. "ft³/s", "ft", "°C", "FNU").'),
  group: z
    .enum(PARAMETER_GROUPS)
    .optional()
    .describe('Thematic domain of a curated entry. Absent on usgs-catalog entries.'),
  description: z
    .string()
    .optional()
    .describe(
      'USGS catalog description, naming the medium, fraction, and method (e.g. "Turbidity, water, unfiltered, … formazin nephelometric units (FNU)"). Present on usgs-catalog entries only.',
    ),
  source: z
    .enum(['curated', 'usgs-catalog'])
    .describe(
      '"curated": one of the well-known codes this server lists by default. "usgs-catalog": a record from the full USGS parameter-code catalog.',
    ),
});

export const waterListParameters = tool('water_list_parameters', {
  description: `Look up USGS parameter codes — the 5-digit codes every other tool's parameterCd takes. With no query, lists a curated set of well-known codes with names, units, and thematic group, from a built-in table (no network call): 00060 = "Discharge" (ft³/s), 00065 = "Gage height" (ft), 00010 = "Temperature, water" (°C), 72019 = "Depth to water level" (ft), and others; filter it with group. For anything else — turbidity, nitrate, chlorophyll, suspended sediment, salinity — pass query to search the full USGS parameter-code catalog (~19,700 codes) by name and description, or pass a 5-digit code to look it up. Matches list curated codes first. ${WINDOW_TERMS} window whichever list the call selects; total counts every match, and nextOffset names the next page while entries remain.`,
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    group: z
      .enum([...PARAMETER_GROUPS, 'all'])
      .default('all')
      .describe(
        'Filter the curated list by thematic domain: "streamflow", "groundwater", "temperature", "meteorological", "water-quality", or "all" (default). Applies to the curated list only — leave it "all" when passing query.',
      ),
    query: z
      .string()
      .max(200)
      .optional()
      .describe(
        'Search the full USGS parameter-code catalog. Case-insensitive; every word must start a word in the parameter name or description (e.g. "turbidity", "nitrate filtered", "dissolved oxygen"). A bare 5-digit code (e.g. "63680") returns that code. Omit to list the curated codes.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(
        `Most entries to return, 1–${MAX_LIMIT_TEXT}. Default ${DEFAULT_LIMIT}. Applies to the query matches, or to the curated list when query is omitted; offset (default 0) picks where the window starts.`,
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        `Number of entries to skip before the window starts. Default 0. Pass the previous response's nextOffset, with the same query and limit (default 25, up to ${MAX_LIMIT_TEXT}), for the next page.`,
      ),
  }),
  output: z.object({
    parameters: z
      .array(ParameterSchema.describe('A USGS parameter code entry.'))
      .describe(
        `The window of matching entries, in a fixed order: without query, the curated codes; with query, matching curated codes first (each once, as its curated entry), then catalog records whose name holds every query word, then those matched through the description, each by code. The window is set by ${WINDOW_TERMS}.`,
      ),
    total: z
      .number()
      .int()
      .describe('Number of entries that matched — every match, before limit/offset windowing.'),
    truncated: z
      .boolean()
      .describe(
        `True when entries remain after this window, which nextOffset then continues from; false on the last page and for an offset past the end. The window is set by ${WINDOW_TERMS}.`,
      ),
    nextOffset: z
      .number()
      .int()
      .optional()
      .describe(
        `Offset of the next page, present while entries remain after this window (truncated is true) — pass it as offset with the same query and limit to continue. Absent on the last page. The window is set by ${WINDOW_TERMS}.`,
      ),
    query: z
      .string()
      .optional()
      .describe('The catalog query searched, trimmed. Absent when listing the curated codes.'),
    note: z
      .string()
      .optional()
      .describe(
        'Guidance when a query matched nothing, the window holds part of the matches (which entries, and the next offset while any remain), or offset is past the end (the valid range). Absent when the window holds every match.',
      ),
  }),

  errors: [
    {
      reason: 'query_with_group',
      code: JsonRpcErrorCode.ValidationError,
      when: 'query was combined with a group other than "all". group filters the curated list only; the USGS catalog carries no matching grouping.',
      recovery:
        'Pass query alone to search the full catalog, or group alone to filter the curated list.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The USGS parameter-code catalog could not be read — the request failed, timed out, or returned something other than a catalog page.',
      recovery:
        'A server error usually clears: retry after a short backoff. An error marked not retryable means the upstream sent a response this server cannot read, and the same request will fail again. Calling without query still lists the curated codes.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const query = input.query?.trim();
    let listing: ParameterEntry[];
    if (!query) {
      listing = CURATED_PARAMETERS.filter(
        (p) => input.group === 'all' || p.group === input.group,
      ).map((p) => ({ ...p, source: 'curated' as const }));
    } else {
      if (input.group !== 'all') {
        throw ctx.fail(
          'query_with_group',
          `query "${query}" cannot be combined with group "${input.group}" — group filters the curated list only, and the USGS catalog has no matching grouping.`,
        );
      }

      let catalog: Awaited<ReturnType<typeof getParameterCatalog>>;
      try {
        catalog = await getParameterCatalog(ctx);
      } catch (err: unknown) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, undefined, { cause: err });
        }
        throw err;
      }
      listing = searchParameters(catalog, query);
      ctx.log.info('Parameter catalog searched', { query, total: listing.length });
    }

    // One window over whichever list the call selected. Match order is fixed while the catalog is
    // cached (curated, then name matches, then description matches, each by code), so offsets
    // page through it without a repeat or a gap.
    const total = listing.length;
    const parameters = listing.slice(input.offset, input.offset + input.limit);
    const end = input.offset + parameters.length;
    const truncated = end < total;
    let note: string | undefined;
    if (query && total === 0) {
      note = `No USGS parameter code matched "${query}". Broaden the query: use fewer words, a word stem ("nitr" rather than "nitrogen"), or a different term for the same measurement.`;
    } else if (input.offset >= total) {
      // An empty page, not an error: the listing matched, the window just starts past its end.
      note = `No entries in this window: offset ${input.offset} is at or past the ${total} matching entries. Valid offset range is 0 to ${total - 1}.`;
    } else if (input.offset > 0 || truncated) {
      note = `Showing entries ${input.offset + 1} to ${end} of ${total}.${truncated ? ` Pass nextOffset (${end}) as offset for the next page.` : ''}`;
    }

    return {
      parameters,
      total,
      truncated,
      ...(truncated ? { nextOffset: end } : {}),
      ...(query ? { query } : {}),
      ...(note ? { note } : {}),
    };
  },

  // The query and the catalog text are encoded so a Markdown parse of content[] reads back the
  // values structuredContent carries; the code goes in a code span sized to whatever it holds.
  format(result) {
    const count =
      result.parameters.length === result.total
        ? `${result.total} parameter(s)`
        : `${result.parameters.length} of ${result.total} parameter(s)`;
    const matching =
      result.query === undefined ? '' : ` matching "${escapeMarkdownInline(result.query)}"`;
    const marks: string[] = [];
    if (result.truncated) marks.push('truncated');
    if (result.nextOffset !== undefined) marks.push(`next page at offset ${result.nextOffset}`);
    const lines = [
      `**${count}${matching}**${marks.length > 0 ? ` *(${marks.join('; ')})*` : ''}\n`,
    ];
    for (const p of result.parameters) {
      const code = markdown().inlineCode(p.code).build();
      const group = p.group ? ` [${escapeMarkdownInline(p.group)}]` : '';
      const description = p.description ? ` — ${escapeMarkdownInline(p.description)}` : '';
      lines.push(
        `- ${code} — **${escapeMarkdownInline(p.name)}** (${escapeMarkdownInline(p.unit)})${group} · ${p.source}${description}`,
      );
    }
    // The note quotes the caller's query.
    if (result.note) lines.push('', `*${escapeMarkdownInline(result.note)}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

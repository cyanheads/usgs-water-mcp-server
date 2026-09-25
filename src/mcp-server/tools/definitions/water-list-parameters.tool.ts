/**
 * @fileoverview Look up USGS parameter codes: the curated table of well-known codes with no network
 * call, or a search of the full USGS parameter-code catalog (~19,600 codes) by name or description.
 * @module mcp-server/tools/definitions/water-list-parameters.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { CURATED_PARAMETERS, PARAMETER_GROUPS } from '@/services/waterdata/curated-parameters.js';
import { getParameterCatalog, searchParameters } from '@/services/waterdata/parameter-catalog.js';

/** Maximum entries a query returns. */
const RESULT_CAP = 25;

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
  description: `Look up USGS parameter codes — the 5-digit codes every other tool's parameterCd takes. With no query, lists a curated set of well-known codes with names, units, and thematic group, from a built-in table (no network call): 00060 = "Discharge" (ft³/s), 00065 = "Gage height" (ft), 00010 = "Temperature, water" (°C), 72019 = "Depth to water level" (ft), and others; filter it with group. For anything else — turbidity, nitrate, chlorophyll, suspended sediment, salinity — pass query to search the full USGS parameter-code catalog (~19,600 codes) by name and description, or pass a 5-digit code to look it up. A query returns at most ${RESULT_CAP} entries, matching curated codes first, with total counting every match.`,
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
  }),
  output: z.object({
    parameters: z
      .array(ParameterSchema.describe('A USGS parameter code entry.'))
      .describe(
        `Matching parameter entries. Without query: the curated codes. With query: matching curated codes first (each once, as its curated entry), then catalog records whose name holds every query word, then those matched through the description, each by code — at most ${RESULT_CAP}.`,
      ),
    total: z
      .number()
      .int()
      .describe(`Number of entries that matched, before the ${RESULT_CAP}-entry cap.`),
    truncated: z
      .boolean()
      .describe(
        `True when a query matched more than ${RESULT_CAP} entries and only the first ${RESULT_CAP} are listed — add words to narrow it.`,
      ),
    query: z
      .string()
      .optional()
      .describe('The catalog query searched, trimmed. Absent when listing the curated codes.'),
    note: z
      .string()
      .optional()
      .describe('Guidance when a query matched nothing or was truncated. Absent otherwise.'),
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
        'The USGS Water Data API is temporarily unavailable. Retry after a short backoff; calling without query still lists the curated codes.',
      retryable: true,
    },
  ],

  async handler(input, ctx) {
    const query = input.query?.trim();
    if (!query) {
      const curated = CURATED_PARAMETERS.filter(
        (p) => input.group === 'all' || p.group === input.group,
      ).map((p) => ({ ...p, source: 'curated' as const }));
      return { parameters: curated, total: curated.length, truncated: false };
    }

    if (input.group !== 'all') {
      throw ctx.fail(
        'query_with_group',
        `query "${query}" cannot be combined with group "${input.group}" — group filters the curated list only, and the USGS catalog has no matching grouping.`,
        ctx.recoveryFor('query_with_group'),
      );
    }

    let catalog: Awaited<ReturnType<typeof getParameterCatalog>>;
    try {
      catalog = await getParameterCatalog(ctx);
    } catch (err: unknown) {
      if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
        throw ctx.fail('upstream_error', err.message, ctx.recoveryFor('upstream_error'), {
          cause: err,
        });
      }
      throw err;
    }

    const matches = searchParameters(catalog, query);
    const parameters = matches.slice(0, RESULT_CAP);
    const truncated = matches.length > RESULT_CAP;
    const note =
      matches.length === 0
        ? `No USGS parameter code matched "${query}". Broaden the query: use fewer words, a word stem ("nitr" rather than "nitrogen"), or a different term for the same measurement.`
        : truncated
          ? `Showing ${RESULT_CAP} of ${matches.length} matches — add words to narrow the query (e.g. "filtered", "unfiltered", "suspended", a unit).`
          : undefined;

    ctx.log.info('Parameter catalog searched', { query, total: matches.length });
    return { parameters, total: matches.length, truncated, query, ...(note ? { note } : {}) };
  },

  format(result) {
    const count = result.truncated
      ? `${result.parameters.length} of ${result.total} parameter(s)`
      : `${result.total} parameter(s)`;
    const matching = result.query === undefined ? '' : ` matching "${result.query}"`;
    const lines = [`**${count}${matching}**${result.truncated ? ' *(truncated)*' : ''}\n`];
    for (const p of result.parameters) {
      const group = p.group ? ` [${p.group}]` : '';
      const description = p.description ? ` — ${p.description}` : '';
      lines.push(`- \`${p.code}\` — **${p.name}** (${p.unit})${group} · ${p.source}${description}`);
    }
    if (result.note) lines.push('', `*${result.note}*`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

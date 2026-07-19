/**
 * @fileoverview Describe the tables and columns staged on a DataCanvas by water_get_series.
 * Use before water_dataframe_query to discover table names and schema.
 * @module mcp-server/tools/definitions/water-dataframe-describe.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import type { CanvasInstance } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';

export const waterDataframeDescribe = tool('water_dataframe_describe', {
  description:
    'List tables and columns staged on a DataCanvas by water_get_series or water_find_sites. Call this after water_get_series or water_find_sites returns a canvas_id to discover the exact table name and column types before writing a query. Then pass the table name to water_dataframe_query. Requires DataCanvas to be enabled on this server instance. Returns an error if DataCanvas is not available.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    canvas_id: z
      .string()
      .describe(
        'Canvas ID returned by water_get_series or water_find_sites. Identifies the canvas to describe.',
      ),
  }),
  output: z.object({
    tables: z
      .array(
        z
          .object({
            name: z.string().describe('Table or view name — use as the FROM target in SQL.'),
            kind: z.enum(['table', 'view']).describe('Whether this is a base table or a SQL view.'),
            row_count: z
              .number()
              .int()
              .describe(
                'Approximate row count for this table (DuckDB estimate; may differ from exact count).',
              ),
            columns: z
              .array(
                z
                  .object({
                    name: z.string().describe('Column name.'),
                    type: z.string().describe('DuckDB column type (e.g. VARCHAR, DOUBLE).'),
                    nullable: z.boolean().describe('True if the column allows NULL values.'),
                  })
                  .describe('A column in this table.'),
              )
              .describe('Column schema for this table.'),
          })
          .describe('A staged canvas table or view.'),
      )
      .describe('Tables and views on this canvas.'),
    canvas_id: z
      .string()
      .describe('The canvas ID that was described — pass to water_dataframe_query.'),
  }),

  errors: [
    {
      reason: 'canvas_disabled',
      code: JsonRpcErrorCode.InvalidRequest,
      when: 'DataCanvas is not enabled on this server instance.',
      recovery:
        'DataCanvas is not available on this server instance; use water_get_series to read the data directly.',
    },
    {
      reason: 'canvas_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The canvas_id does not exist or has expired.',
      recovery: 'Re-run water_get_series to stage the data again and get a fresh canvas_id.',
    },
  ],

  async handler(input, ctx) {
    const canvas = getCanvas();
    if (!canvas) {
      ctx.log.info(
        'DataCanvas not enabled; set CANVAS_PROVIDER_TYPE=duckdb to enable SQL queries over staged series.',
      );
      throw ctx.fail(
        'canvas_disabled',
        'DataCanvas is not enabled on this server instance.',
        ctx.recoveryFor('canvas_disabled'),
      );
    }

    ctx.log.info('Describing canvas', { canvas_id: input.canvas_id });

    let instance: CanvasInstance;
    try {
      instance = await canvas.acquire(input.canvas_id, ctx);
    } catch (err: unknown) {
      if (err instanceof McpError && err.data?.['reason'] === 'canvas_not_found') {
        throw ctx.fail(
          'canvas_not_found',
          `Canvas ${input.canvas_id} not found or expired.`,
          ctx.recoveryFor('canvas_not_found'),
          { cause: err },
        );
      }
      throw err;
    }

    const tableInfos = await instance.describe();
    const tables = tableInfos.map((t) => ({
      name: t.name,
      kind: t.kind as 'table' | 'view',
      row_count: t.rowCount,
      columns: t.columns.map((c) => ({
        name: c.name,
        type: String(c.type),
        nullable: c.nullable ?? false,
      })),
    }));

    ctx.log.info('Canvas described', { tableCount: tables.length });
    return { tables, canvas_id: input.canvas_id };
  },

  format(result) {
    const lines = [`**Canvas \`${result.canvas_id}\`** — ${result.tables.length} table(s)\n`];
    for (const t of result.tables) {
      lines.push(`### ${t.name} (${t.kind}, ${t.row_count} rows)`);
      for (const c of t.columns) {
        lines.push(`  - \`${c.name}\` — ${c.type}${c.nullable ? ' (nullable)' : ''}`);
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
